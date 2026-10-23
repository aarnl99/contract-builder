"""Tests for signature reminders and the "waiting on" view.

Covers: signers get a notified_at stamp when first emailed (only the first
signer in sign-in-order mode, the next one when the previous finishes), the
waiting_on data in the signature payload, the manual "Send reminder"
endpoint (turn check, 12 hour cooldown, nothing pending), the automatic
reminder job (day 3/6/9 then stop, owner opt-out, skips signers who already
signed or whose turn it isn't), the label shown on the Documents list, and
the account toggle.

Run with:  venv/bin/pytest tests/
"""
import os
import sys
import uuid
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from test_multi_signer import env, place_all, send, webhook, SIGNERS3  # noqa: E402,F401
from app import main as m  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import SigningRequest, SigningRequestSigner, User, GeneratedContract  # noqa: E402


def unique_signers():
    tag = uuid.uuid4().hex[:8]
    return [{**s, "email": f"{tag}-{s['email']}"} for s in SIGNERS3]


def signer_rows(sr_id):
    with Session(engine) as s:
        rows = s.exec(select(SigningRequestSigner).where(SigningRequestSigner.signing_request_id == sr_id)).all()
        return {r.role: r for r in rows}


def backdate(sr_id, days, role=None):
    """Pretend the signer(s) were emailed `days` ago."""
    with Session(engine) as s:
        rows = s.exec(select(SigningRequestSigner).where(SigningRequestSigner.signing_request_id == sr_id)).all()
        for r in rows:
            if role and r.role != role:
                continue
            if r.notified_at:
                r.notified_at = datetime.utcnow() - timedelta(days=days)
                s.add(r)
        s.commit()


def only_this_request(sr_id):
    """All tests share one database: park every other pending request so the
    reminder job only sees this test's."""
    with Session(engine) as s:
        for sr in s.exec(select(SigningRequest).where(SigningRequest.status == "pending", SigningRequest.id != sr_id)).all():
            sr.status = "cancelled"
            s.add(sr)
        s.commit()


def start(env, in_order=False, signers=None):
    place_all(env)
    signers = signers or unique_signers()
    r = send(env, signers=signers, sign_in_order=in_order)
    assert r.status_code == 200, r.text
    data = r.json()
    env.sent.clear()
    return data, signers


# ---- notified_at -----------------------------------------------------------

def test_everyone_is_stamped_when_emailed_at_once(env):
    data, _ = start(env)
    rows = signer_rows(data["id"])
    assert all(r.notified_at is not None for r in rows.values())


def test_ordered_request_stamps_only_the_first_then_the_next(env):
    place_all(env)
    data = send(env, signers=unique_signers(), sign_in_order=True).json()
    rows = signer_rows(data["id"])
    assert rows["CEO"].notified_at is not None
    assert rows["CFO"].notified_at is None and rows["Client"].notified_at is None

    assert webhook(env, "form.completed", rows["CEO"].docuseal_submitter_id).status_code == 200
    rows = signer_rows(data["id"])
    assert rows["CFO"].notified_at is not None
    assert rows["Client"].notified_at is None


# ---- payload ---------------------------------------------------------------

def test_payload_lists_who_is_waiting_and_for_how_long(env):
    data, _ = start(env)
    assert [w["name"] for w in data["waiting_on"]] == ["Casey CEO", "Fran CFO", "Jamie Client"]
    assert all(w["days"] == 0 for w in data["waiting_on"])

    backdate(data["id"], 4, role="CFO")
    got = env.get(f"/api/generated/{env.gid}/signature-request").json()
    by_name = {w["name"]: w["days"] for w in got["waiting_on"]}
    assert by_name["Fran CFO"] == 4 and by_name["Casey CEO"] == 0
    cfo = next(s for s in got["signers"] if s["role"] == "CFO")
    assert cfo["days_waiting"] == 4 and cfo["waiting_since"]


def test_ordered_request_only_waits_on_whoever_is_up(env):
    place_all(env)
    data = send(env, signers=unique_signers(), sign_in_order=True).json()
    assert [w["name"] for w in data["waiting_on"]] == ["Casey CEO"]


def test_signed_people_are_no_longer_waited_on(env):
    data, _ = start(env)
    rows = signer_rows(data["id"])
    assert webhook(env, "form.completed", rows["CEO"].docuseal_submitter_id).status_code == 200
    got = env.get(f"/api/generated/{env.gid}/signature-request").json()
    assert [w["name"] for w in got["waiting_on"]] == ["Fran CFO", "Jamie Client"]


# ---- manual reminders --------------------------------------------------------

def test_manual_reminder_emails_everyone_waiting(env):
    data, signers = start(env)
    r = env.post(f"/api/generated/{env.gid}/signature-request/remind")
    assert r.status_code == 200, r.text
    assert sorted(r.json()["reminded"]) == ["Casey CEO", "Fran CFO", "Jamie Client"]
    assert sorted(env.sent) == sorted(s["email"] for s in signers)
    rows = signer_rows(data["id"])
    assert all(x.reminder_count == 1 and x.last_reminded_at for x in rows.values())


def test_manual_reminder_for_one_signer(env):
    data, signers = start(env)
    r = env.post(f"/api/generated/{env.gid}/signature-request/remind", json={"position": 1})
    assert r.status_code == 200, r.text
    assert env.sent == [signers[1]["email"]]


def test_manual_reminder_has_a_cooldown(env):
    start(env)
    assert env.post(f"/api/generated/{env.gid}/signature-request/remind").status_code == 200
    env.sent.clear()
    r = env.post(f"/api/generated/{env.gid}/signature-request/remind")
    assert r.status_code == 429
    assert env.sent == []


def test_cannot_remind_someone_whose_turn_it_is_not(env):
    place_all(env)
    send(env, signers=unique_signers(), sign_in_order=True)
    env.sent.clear()
    r = env.post(f"/api/generated/{env.gid}/signature-request/remind", json={"position": 2})
    assert r.status_code == 400 and "turn" in r.json()["detail"]
    assert env.sent == []


def test_cannot_remind_someone_who_already_signed(env):
    data, _ = start(env)
    rows = signer_rows(data["id"])
    webhook(env, "form.completed", rows["CEO"].docuseal_submitter_id)
    r = env.post(f"/api/generated/{env.gid}/signature-request/remind", json={"position": 0})
    assert r.status_code == 400


def test_remind_with_nothing_pending_is_404(env):
    assert env.post(f"/api/generated/{env.gid}/signature-request/remind").status_code == 404


def test_reminder_that_cannot_be_emailed_is_reported(env, monkeypatch):
    start(env)

    def boom(*a, **k):
        raise RuntimeError("no key")

    monkeypatch.setattr(m.ee, "send_email", boom)
    r = env.post(f"/api/generated/{env.gid}/signature-request/remind")
    assert r.status_code == 502


# ---- automatic reminders -------------------------------------------------------

def test_auto_reminders_go_out_on_day_3_6_9_then_stop(env):
    data, signers = start(env)
    only_this_request(data["id"])
    t0 = datetime.utcnow()

    assert m._send_due_reminders(now=t0 + timedelta(days=2)) == 0
    assert env.sent == []

    assert m._send_due_reminders(now=t0 + timedelta(days=3, minutes=1)) == 3
    assert sorted(env.sent) == sorted(s["email"] for s in signers)

    # too soon for the next one
    env.sent.clear()
    assert m._send_due_reminders(now=t0 + timedelta(days=5)) == 0
    assert m._send_due_reminders(now=t0 + timedelta(days=6, minutes=2)) == 3
    assert m._send_due_reminders(now=t0 + timedelta(days=9, minutes=3)) == 3
    env.sent.clear()
    # three reminders sent: that's the limit
    assert m._send_due_reminders(now=t0 + timedelta(days=30)) == 0
    assert env.sent == []
    assert all(r.reminder_count == 3 for r in signer_rows(data["id"]).values())


def test_auto_reminders_skip_people_who_signed(env):
    data, signers = start(env)
    only_this_request(data["id"])
    rows = signer_rows(data["id"])
    webhook(env, "form.completed", rows["CEO"].docuseal_submitter_id)
    env.sent.clear()
    assert m._send_due_reminders(now=datetime.utcnow() + timedelta(days=4)) == 2
    assert signers[0]["email"] not in env.sent


def test_auto_reminders_in_order_only_nudge_whoever_is_up(env):
    place_all(env)
    signers = unique_signers()
    data = send(env, signers=signers, sign_in_order=True).json()
    only_this_request(data["id"])
    env.sent.clear()
    assert m._send_due_reminders(now=datetime.utcnow() + timedelta(days=4)) == 1
    assert env.sent == [signers[0]["email"]]


def test_auto_reminders_respect_the_account_toggle(env):
    data, _ = start(env)
    only_this_request(data["id"])
    assert env.patch("/api/account/notification-settings", json={"auto_remind_signers": False}).status_code == 200
    assert m._send_due_reminders(now=datetime.utcnow() + timedelta(days=4)) == 0
    assert env.sent == []
    # ...but a manual reminder still works
    assert env.post(f"/api/generated/{env.gid}/signature-request/remind").status_code == 200


def test_auto_reminders_ignore_cancelled_requests(env, monkeypatch):
    data, _ = start(env)
    only_this_request(data["id"])
    monkeypatch.setattr(m.ds, "archive_submission", lambda *_: None)
    assert env.post(f"/api/generated/{env.gid}/signature-request/cancel").status_code == 200
    assert m._send_due_reminders(now=datetime.utcnow() + timedelta(days=4)) == 0


def test_a_manual_reminder_resets_the_auto_clock(env):
    data, _ = start(env)
    only_this_request(data["id"])
    assert env.post(f"/api/generated/{env.gid}/signature-request/remind").status_code == 200
    env.sent.clear()
    # day 3 after sending, but only ~3 days minus a moment since the manual one: not due
    assert m._send_due_reminders(now=datetime.utcnow() + timedelta(days=2, hours=23)) == 0


# ---- documents list --------------------------------------------------------------

def test_documents_list_shows_who_we_are_waiting_on(env):
    data, _ = start(env)
    row = next(d for d in env.get("/api/generated").json() if d["id"] == env.gid)
    assert row["signature"]["state"] == "pending"
    assert row["signature"]["label"] == "Waiting on Casey +2 · since today"

    backdate(data["id"], 5)
    row = next(d for d in env.get("/api/generated").json() if d["id"] == env.gid)
    assert row["signature"]["label"] == "Waiting on Casey +2 · 5 days"
    assert row["signature"]["tone"] == "overdue"


def test_documents_list_single_signer_label(env):
    from test_multi_signer import place
    assert place(env, 0, "CEO").status_code == 200
    r = send(env, signers=[unique_signers()[0]])
    assert r.status_code == 200, r.text
    backdate(r.json()["id"], 1)
    row = next(d for d in env.get("/api/generated").json() if d["id"] == env.gid)
    assert row["signature"]["label"] == "Waiting on Casey · 1 day"


def test_documents_list_has_no_signature_info_when_nothing_was_sent(env):
    row = next(d for d in env.get("/api/generated").json() if d["id"] == env.gid)
    assert row["signature"] is None


def test_documents_list_shows_fully_signed(env):
    data, _ = start(env)
    for r in signer_rows(data["id"]).values():
        webhook(env, "form.completed", r.docuseal_submitter_id)
    with Session(engine) as s:
        sr = s.get(SigningRequest, data["id"])
        sr.status = "completed"
        s.add(sr)
        s.commit()
    row = next(d for d in env.get("/api/generated").json() if d["id"] == env.gid)
    assert row["signature"]["label"] == "Fully signed"


# ---- settings ---------------------------------------------------------------------

def test_auto_remind_setting_round_trips(env):
    assert env.get("/api/account/notification-settings").json()["auto_remind_signers"] is True
    r = env.patch("/api/account/notification-settings", json={"auto_remind_signers": False})
    assert r.json()["auto_remind_signers"] is False
    assert env.get("/api/account/notification-settings").json()["auto_remind_signers"] is False
