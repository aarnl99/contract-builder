"""Tests for contract end dates and renewals.

Covers: confirming / clearing an end date, the AI suggestion flow (stored as a
suggestion, never counted until confirmed, error handling, rate limit), the
"Renewing soon" feed, the 30 and 7 day owner emails (once each, opt-out,
reset when the date changes), and the pure helpers in app/renewals.py.

Run with:  venv/bin/pytest tests/
"""
import os
import sys
import time
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from test_multi_signer import env  # noqa: E402,F401
from app import main as m  # noqa: E402
from app import renewals as rn  # noqa: E402
from app import rate_limit as ratelimit  # noqa: E402
from app.auth import hash_password  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import GeneratedContract, User  # noqa: E402

TODAY = date.today()


def iso(days):
    return (TODAY + timedelta(days=days)).isoformat()


def put(env, **body):
    return env.put(f"/api/generated/{env.gid}/renewal", json=body)


def only_this_doc(gid):
    """All tests share one database: clear every other document's end date so
    the email job only sees this test's."""
    with Session(engine) as s:
        for gc in s.exec(select(GeneratedContract).where(GeneratedContract.id != gid, GeneratedContract.end_date != None)).all():  # noqa: E711
            gc.end_date = None
            s.add(gc)
        s.commit()


def owner_email(gid):
    with Session(engine) as s:
        gc = s.get(GeneratedContract, gid)
        return s.get(User, gc.owner_id).email


@pytest.fixture()
def mail(monkeypatch):
    sent = []
    monkeypatch.setattr(m.ee, "send_email", lambda to, subject, body, *a, **k: sent.append((to, subject, body)))
    ratelimit.reset_all()
    return sent


SUGGESTION = {
    "end_date": "2027-03-01",
    "auto_renews": True,
    "renewal_terms": "Renews for one year unless cancelled 60 days before.",
    "evidence": "This Agreement ends on March 1, 2027.",
    "confidence": "high",
    "suggested_at": datetime.utcnow().isoformat(),
}


# ---- confirming a date -----------------------------------------------------

def test_confirm_an_end_date(env):
    r = put(env, end_date="2027-03-01", auto_renews=True, renewal_terms="  60 days notice  ")
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["end_date"] == "2027-03-01" and got["auto_renews"] is True
    assert got["renewal_terms"] == "60 days notice"
    assert env.get(f"/api/generated/{env.gid}/renewal").json()["end_date"] == "2027-03-01"


def test_blank_date_clears_it(env):
    put(env, end_date=iso(40))
    r = put(env, end_date="")
    assert r.status_code == 200 and r.json()["end_date"] is None and r.json()["days_left"] is None


def test_days_left_is_reported(env):
    assert put(env, end_date=iso(12)).json()["days_left"] == 12


@pytest.mark.parametrize("bad", ["not a date", "2027-13-45", "1999-01-01", "9999-12-31"])
def test_bad_dates_are_rejected(env, bad):
    assert put(env, end_date=bad).status_code == 400


def test_other_peoples_documents_are_off_limits(env):
    with Session(engine) as s:
        u = User(email="other-%d@x.test" % time.time_ns(), password_hash=hash_password("pw"), email_verified=True)
        s.add(u)
        s.commit()
        s.refresh(u)
        gc = GeneratedContract(owner_id=u.id, template_name="t", name="Theirs", file_path="/x", values_json="[]")
        s.add(gc)
        s.commit()
        s.refresh(gc)
        other = gc.id
    assert env.get(f"/api/generated/{other}/renewal").status_code == 404
    assert env.put(f"/api/generated/{other}/renewal", json={"end_date": iso(5)}).status_code == 404
    assert env.post(f"/api/generated/{other}/renewal/suggest").status_code == 404


def test_documents_list_carries_the_end_date(env):
    put(env, end_date="2027-03-01")
    row = next(d for d in env.get("/api/generated").json() if d["id"] == env.gid)
    assert row["end_date"] == "2027-03-01" and row["has_end_date_suggestion"] is False


# ---- AI suggestion -------------------------------------------------------------

def test_suggestion_is_stored_but_not_counted_until_confirmed(env, mail, monkeypatch):
    monkeypatch.setattr(m.rn, "suggest_term", lambda text, today=None: dict(SUGGESTION))
    r = env.post(f"/api/generated/{env.gid}/renewal/suggest")
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["found"] is True and got["suggestion"]["end_date"] == "2027-03-01"
    assert got["end_date"] is None  # not confirmed yet
    row = next(d for d in env.get("/api/generated").json() if d["id"] == env.gid)
    assert row["has_end_date_suggestion"] is True and row["end_date"] is None

    # confirming (here, with an edit) clears the suggestion
    done = put(env, end_date="2027-03-15", auto_renews=True).json()
    assert done["suggestion"] is None and done["end_date"] == "2027-03-15"


def test_suggestion_sees_the_document_text(env, mail, monkeypatch):
    seen = []
    monkeypatch.setattr(m.rn, "suggest_term", lambda text, today=None: seen.append(text) or None)
    r = env.post(f"/api/generated/{env.gid}/renewal/suggest")
    assert r.status_code == 200 and r.json()["found"] is False and r.json()["suggestion"] is None
    assert "CEO signs" in seen[0]


def test_dismissing_a_suggestion(env, mail, monkeypatch):
    monkeypatch.setattr(m.rn, "suggest_term", lambda text, today=None: dict(SUGGESTION))
    env.post(f"/api/generated/{env.gid}/renewal/suggest")
    r = env.post(f"/api/generated/{env.gid}/renewal/dismiss")
    assert r.status_code == 200 and r.json()["suggestion"] is None


def test_suggest_without_an_api_key_is_a_503(env, mail, monkeypatch):
    def nokey(text, today=None):
        raise RuntimeError("ANTHROPIC_API_KEY is not configured.")

    monkeypatch.setattr(m.rn, "suggest_term", nokey)
    assert env.post(f"/api/generated/{env.gid}/renewal/suggest").status_code == 503


def test_suggest_when_the_model_fails_is_a_502(env, mail, monkeypatch):
    def boom(text, today=None):
        raise ValueError("model exploded")

    monkeypatch.setattr(m.rn, "suggest_term", boom)
    assert env.post(f"/api/generated/{env.gid}/renewal/suggest").status_code == 502


def test_suggest_is_rate_limited(env, mail, monkeypatch):
    monkeypatch.setattr(m.rn, "suggest_term", lambda text, today=None: None)
    codes = [env.post(f"/api/generated/{env.gid}/renewal/suggest").status_code for _ in range(11)]
    assert codes[:10] == [200] * 10 and codes[10] == 429


def test_background_suggestion_on_signing_stores_it(env, mail, monkeypatch):
    monkeypatch.setattr(m.ee, "ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(m.rn, "suggest_term", lambda text, today=None: dict(SUGGESTION))
    assert m._run_renewal_suggestion(env.gid) is True
    assert env.get(f"/api/generated/{env.gid}/renewal").json()["suggestion"]["end_date"] == "2027-03-01"


def test_background_suggestion_never_overwrites_a_confirmed_date(env, mail, monkeypatch):
    monkeypatch.setattr(m.ee, "ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(m.rn, "suggest_term", lambda text, today=None: dict(SUGGESTION))
    put(env, end_date=iso(100))
    assert m._run_renewal_suggestion(env.gid) is False
    assert env.get(f"/api/generated/{env.gid}/renewal").json()["suggestion"] is None


def test_background_suggestion_does_nothing_without_a_key(env, mail, monkeypatch):
    monkeypatch.setattr(m.ee, "ANTHROPIC_API_KEY", "")
    assert m._run_renewal_suggestion(env.gid) is False


# ---- the Renewing soon feed -----------------------------------------------------

def test_feed_includes_dates_in_the_window_soonest_first(env):
    put(env, end_date=iso(45), auto_renews=True)
    feed = env.get("/api/renewals").json()
    mine = [r for r in feed["renewing"] if r["id"] == env.gid]
    assert mine and mine[0]["days_left"] == 45 and mine[0]["auto_renews"] is True
    days = [r["days_left"] for r in feed["renewing"]]
    assert days == sorted(days)


@pytest.mark.parametrize("days,shown", [(0, True), (89, True), (90, True), (91, False), (-14, True), (-15, False)])
def test_feed_window_edges(env, days, shown):
    put(env, end_date=iso(days))
    ids = [r["id"] for r in env.get("/api/renewals").json()["renewing"]]
    assert (env.gid in ids) is shown


def test_feed_skips_archived_documents(env):
    put(env, end_date=iso(10))
    with Session(engine) as s:
        gc = s.get(GeneratedContract, env.gid)
        gc.archived = True
        s.add(gc)
        s.commit()
    assert env.gid not in [r["id"] for r in env.get("/api/renewals").json()["renewing"]]


def test_feed_lists_suggestions_waiting_for_confirmation(env, mail, monkeypatch):
    monkeypatch.setattr(m.rn, "suggest_term", lambda text, today=None: dict(SUGGESTION))
    env.post(f"/api/generated/{env.gid}/renewal/suggest")
    feed = env.get("/api/renewals").json()
    assert env.gid in [r["id"] for r in feed["to_confirm"]]
    put(env, end_date=iso(200))
    assert env.gid not in [r["id"] for r in env.get("/api/renewals").json()["to_confirm"]]


def test_feed_is_per_owner(env):
    put(env, end_date=iso(10))
    other = m.app  # a fresh, logged-out client sees nothing
    from fastapi.testclient import TestClient
    assert TestClient(other).get("/api/renewals").status_code in (401, 403)


# ---- emails -----------------------------------------------------------------------

def mine(sent, gid):
    me = owner_email(gid)
    return [x for x in sent if x[0] == me]


def test_thirty_day_email_goes_out_once(env, mail):
    only_this_doc(env.gid)
    put(env, end_date=iso(30), auto_renews=True, renewal_terms="60 days notice")
    m._send_due_renewal_emails(today=TODAY)
    got = mine(mail, env.gid)
    assert len(got) == 1
    assert "30 days" in got[0][1] and "Big Contract" in got[0][1]
    assert "renew automatically" in got[0][2] and "60 days notice" in got[0][2]
    m._send_due_renewal_emails(today=TODAY)
    assert len(mine(mail, env.gid)) == 1


def test_nothing_before_the_thirty_day_mark(env, mail):
    only_this_doc(env.gid)
    put(env, end_date=iso(31))
    m._send_due_renewal_emails(today=TODAY)
    assert mine(mail, env.gid) == []


def test_seven_day_email_follows_the_thirty_day_one(env, mail):
    only_this_doc(env.gid)
    put(env, end_date=iso(30))
    m._send_due_renewal_emails(today=TODAY)
    m._send_due_renewal_emails(today=TODAY + timedelta(days=23))  # 7 days left
    got = mine(mail, env.gid)
    assert len(got) == 2 and "7 days" in got[1][1]
    m._send_due_renewal_emails(today=TODAY + timedelta(days=24))
    assert len(mine(mail, env.gid)) == 2


def test_a_contract_already_inside_seven_days_gets_one_email_not_two(env, mail):
    only_this_doc(env.gid)
    put(env, end_date=iso(5))
    m._send_due_renewal_emails(today=TODAY)
    m._send_due_renewal_emails(today=TODAY + timedelta(days=1))
    got = mine(mail, env.gid)
    assert len(got) == 1 and "5 days" in got[0][1]


def test_ending_tomorrow_wording(env, mail):
    only_this_doc(env.gid)
    put(env, end_date=iso(1))
    m._send_due_renewal_emails(today=TODAY)
    assert "tomorrow" in mine(mail, env.gid)[0][1]


def test_expired_contracts_get_no_email(env, mail):
    only_this_doc(env.gid)
    put(env, end_date=iso(-1))
    m._send_due_renewal_emails(today=TODAY)
    assert mine(mail, env.gid) == []


def test_owner_can_turn_renewal_emails_off(env, mail):
    only_this_doc(env.gid)
    assert env.patch("/api/account/notification-settings", json={"renewal_emails": False}).json()["renewal_emails"] is False
    put(env, end_date=iso(20))
    m._send_due_renewal_emails(today=TODAY)
    assert mine(mail, env.gid) == []


def test_changing_the_date_restarts_the_schedule(env, mail):
    only_this_doc(env.gid)
    put(env, end_date=iso(20))
    m._send_due_renewal_emails(today=TODAY)
    assert len(mine(mail, env.gid)) == 1
    put(env, end_date=iso(25))  # renewed / extended: a new date
    m._send_due_renewal_emails(today=TODAY)
    assert len(mine(mail, env.gid)) == 2


def test_archived_documents_get_no_email(env, mail):
    only_this_doc(env.gid)
    put(env, end_date=iso(10))
    with Session(engine) as s:
        gc = s.get(GeneratedContract, env.gid)
        gc.archived = True
        s.add(gc)
        s.commit()
    m._send_due_renewal_emails(today=TODAY)
    assert mine(mail, env.gid) == []


def test_unsendable_email_is_retried_next_pass(env, mail, monkeypatch):
    only_this_doc(env.gid)
    put(env, end_date=iso(10))

    def nokey(*a, **k):
        raise RuntimeError("no sendgrid")

    monkeypatch.setattr(m.ee, "send_email", nokey)
    m._send_due_renewal_emails(today=TODAY)
    monkeypatch.setattr(m.ee, "send_email", lambda to, subject, body, *a, **k: mail.append((to, subject, body)))
    m._send_due_renewal_emails(today=TODAY)
    assert len(mine(mail, env.gid)) == 1


def test_renewal_email_setting_round_trips(env):
    assert env.get("/api/account/notification-settings").json()["renewal_emails"] is True
    env.patch("/api/account/notification-settings", json={"renewal_emails": False})
    assert env.get("/api/account/notification-settings").json()["renewal_emails"] is False


# ---- helpers in app/renewals.py ----------------------------------------------------

def test_parse_iso_date():
    assert rn.parse_iso_date("2027-03-01") == date(2027, 3, 1)
    assert rn.parse_iso_date("2027-03-01T10:00:00") == date(2027, 3, 1)
    assert rn.parse_iso_date("") is None and rn.parse_iso_date(None) is None
    assert rn.parse_iso_date("March 1") is None and rn.parse_iso_date("2027-02-30") is None


def test_clean_suggestion_keeps_good_data():
    got = rn.clean_suggestion({"end_date": "2027-03-01", "auto_renews": True, "renewal_terms": " x ", "confidence": "high"}, TODAY)
    assert got["end_date"] == "2027-03-01" and got["auto_renews"] is True and got["renewal_terms"] == "x"


def test_clean_suggestion_drops_implausible_dates_and_junk():
    assert rn.clean_suggestion({"end_date": "1850-01-01"}, TODAY) is None
    assert rn.clean_suggestion({"end_date": "3500-01-01"}, TODAY) is None
    assert rn.clean_suggestion({"end_date": "", "auto_renews": "yes", "confidence": "certain"}, TODAY) is None
    # renewal info with no date is still worth showing
    got = rn.clean_suggestion({"end_date": "", "auto_renews": True, "confidence": "certain"}, TODAY)
    assert got["end_date"] is None and got["auto_renews"] is True and got["confidence"] == "low"


def test_clean_suggestion_truncates_long_notes():
    got = rn.clean_suggestion({"end_date": iso(10), "renewal_terms": "x" * 1000, "evidence": "y" * 1000}, TODAY)
    assert len(got["renewal_terms"]) == rn.MAX_NOTE_CHARS and len(got["evidence"]) == rn.MAX_NOTE_CHARS


@pytest.mark.parametrize("left,s30,s7,expected", [
    (45, False, False, None), (31, False, False, None), (30, False, False, 30), (30, True, False, None),
    (8, False, False, 30), (8, True, False, None), (7, False, False, 7), (7, True, False, 7),
    (7, True, True, None), (1, False, False, 7), (0, False, False, 7), (-1, False, False, None),
])
def test_email_stage(left, s30, s7, expected):
    assert rn.email_stage(TODAY + timedelta(days=left), TODAY, s30, s7) == expected


def test_suggestion_from_json_is_forgiving():
    assert rn.suggestion_from_json("") is None
    assert rn.suggestion_from_json("{not json") is None
    assert rn.suggestion_from_json("[1,2]") is None
    assert rn.suggestion_from_json('{"end_date": "2027-03-01"}') == {"end_date": "2027-03-01"}


def test_suggest_term_reads_the_models_tool_answer(monkeypatch):
    """The real AI call, with the Anthropic client faked: checks the request
    forces the tool and the answer is parsed and cleaned."""
    import types

    calls = []

    class FakeMessages:
        def create(self, **kw):
            calls.append(kw)
            block = types.SimpleNamespace(
                type="tool_use", name="record_term",
                input={"end_date": "2027-03-01", "auto_renews": True, "renewal_terms": "1 year", "evidence": "ends March 1", "confidence": "high"},
            )
            return types.SimpleNamespace(content=[block])

    class FakeAnthropic:
        def __init__(self, api_key):
            self.messages = FakeMessages()

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=FakeAnthropic))
    monkeypatch.setattr(rn.ee, "ANTHROPIC_API_KEY", "k")
    got = rn.suggest_term("This Agreement ends on March 1, 2027.", today=TODAY)
    assert got["end_date"] == "2027-03-01" and got["auto_renews"] is True
    assert calls[0]["tool_choice"] == {"type": "auto"}  # forced choice is rejected by newer models
    assert "record_term tool" in calls[0]["messages"][0]["content"]
    assert "March 1, 2027" in calls[0]["messages"][0]["content"]
    assert "not instructions" in calls[0]["messages"][0]["content"]


def test_suggest_term_without_a_key_raises(monkeypatch):
    monkeypatch.setattr(rn.ee, "ANTHROPIC_API_KEY", "")
    with pytest.raises(RuntimeError):
        rn.suggest_term("anything")
