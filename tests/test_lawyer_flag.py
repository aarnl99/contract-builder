"""Tests for "worth a lawyer's eye" flags and the summary of a round.

Covers: the clause-risk check done in code (topics, large free-text rewrites,
ordinary changes left alone), the flag in the owner's redlines payload, the
counter-suggestion endpoint refusing to call the AI for a flagged change (free
and working without a key), the round summary endpoint (ownership, own rounds,
nothing pending, no key, refunds, the shared allowance, flagged changes never
shown as routine, counts worked out in code), and a faked Anthropic call.

Run with:  venv/bin/pytest tests/
"""
import os
import sys
import time
import types

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from test_multi_signer import env  # noqa: E402,F401
from test_advisor import make_edit  # noqa: E402
from app import main as m  # noqa: E402
from app import advisor as adv  # noqa: E402
from app import ai_usage  # noqa: E402
from app.auth import hash_password  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import AiUsage, GeneratedContract, RedlineEdit, RedlineSubmission, ShareLink, User  # noqa: E402


def risk(**kw):
    base = dict(label="Payment terms", original="Net 30", proposed="Net 60", comment="", free_text=False)
    base.update(kw)
    return adv.clause_risk(**base)


# ---- the check done in code --------------------------------------------------------------

def test_ordinary_changes_are_left_alone():
    assert risk() is None
    assert risk(label="Fee", original="$10,000", proposed="$12,000") is None
    assert risk(label="Start date", original="Nov 1", proposed="Nov 15", free_text=True) is None


@pytest.mark.parametrize("label,orig,prop,topic", [
    ("Limitation of liability", "Fees paid in 12 months", "No cap", "liability"),
    ("Section 8", "Each party shall indemnify the other", "Supplier indemnifies the client", "indemnity"),
    ("Ownership", "Supplier keeps its tools", "All work product belongs to the client", "ownership and licensing"),
    ("Termination", "30 days notice", "Immediately for convenience", "termination"),
    ("Governing law", "Delaware", "California", "governing law and disputes"),
    ("Section 12", "Disputes go to arbitration", "Disputes go to court", "governing law and disputes"),
    ("Restrictions", "None", "Supplier agrees to a non-compete", "non-compete or exclusivity"),
    ("Confidentiality", "2 years", "5 years", "confidentiality"),
    ("Warranty", "30 days", "1 year", "warranties"),
    ("Data", "None", "Supplier handles personal data", "data and privacy"),
])
def test_high_stakes_topics_are_flagged(label, orig, prop, topic):
    got = risk(label=label, original=orig, proposed=prop)
    assert got and topic in got["topics"]
    assert "lawyer" in got["message"] and "legal risk" in got["message"]


@pytest.mark.parametrize("orig,prop", [
    ("limited liability company", "S Corp"),
    ("Limited Liability Company", "C corporation"),
    ("Delaware limited-liability company", "Delaware corporation"),
    ("limited liability partnership", "general partnership"),
    ("limited liability limited partnership", "sole proprietor"),
    ("S Corp", "limited liability company"),
])
def test_a_business_type_is_not_a_liability_clause(orig, prop):
    assert risk(label="Entity type", original=orig, proposed=prop) is None
    assert risk(label="Entity type", original=orig, proposed=prop, comment="we changed our structure") is None


def test_real_liability_is_still_flagged_next_to_an_entity_name():
    got = risk(label="Section 9", original="Acme, a limited liability company, has capped liability",
               proposed="Acme, a limited liability company, has unlimited liability", free_text=True)
    assert got and "liability" in got["topics"]
    assert risk(label="Limitation of liability", original="limited liability company", proposed="S Corp") is not None


def test_topic_in_the_clients_note_counts():
    assert risk(comment="we need unlimited liability here") is not None


def test_topic_only_in_the_original_wording_counts():
    assert risk(label="Section 4", original="The supplier shall indemnify the client", proposed="", free_text=True)["topics"][0] == "indemnity"


def test_large_free_text_rewrite_is_flagged_but_not_a_field_edit():
    big = "x " * 200
    got = risk(label="Section 5", original="short", proposed=big, free_text=True)
    assert got["topics"] == ["a large rewrite of the wording"]
    assert got["message"].startswith("This is a large rewrite of the wording")
    assert risk(label="Section 5", original="short", proposed=big, free_text=False) is None


def test_deleting_a_whole_paragraph_is_flagged():
    assert risk(label="Section 6", original="y " * 60, proposed="", free_text=True) is not None


def test_message_names_at_most_three_topics():
    got = risk(label="Terms", original="liability indemnify intellectual property termination arbitration", proposed="")
    assert len(got["topics"]) == adv.MAX_FLAG_TOPICS and " and " in got["message"]


# ---- the owner's redlines payload ----------------------------------------------------------

def edits_in_payload(env):
    data = env.get(f"/api/generated/{env.gid}/redlines").json()
    return {e["id"]: e for s in data["submissions"] for e in s["edits"]}


def test_payload_carries_the_flag(env):
    flagged, _ = make_edit(env, label="Limitation of liability", original="cap", proposed="no cap")
    plain, _ = make_edit(env)
    got = edits_in_payload(env)
    assert got[flagged]["risk"]["topics"] == ["liability"]
    assert got[plain]["risk"] is None


# ---- suggest-counter for a flagged change ----------------------------------------------------

@pytest.fixture()
def ai(env, monkeypatch):
    monkeypatch.setattr(m.ee, "ANTHROPIC_API_KEY", "k")
    env.counter_calls = []

    def fake(packet):
        env.counter_calls.append(packet)
        return {"counter_value": "Net 45", "reasoning": "r", "confidence": "high"}

    monkeypatch.setattr(m.adv, "suggest_counter", fake)
    with Session(engine) as s:
        owner = s.get(GeneratedContract, env.gid).owner_id
        for r in s.exec(select(AiUsage).where(AiUsage.user_id == owner)).all():
            s.delete(r)
        s.commit()
    env.owner_id = owner
    return env


def used(env):
    with Session(engine) as s:
        return ai_usage.used(s, env.owner_id)


def test_flagged_change_gets_a_note_not_an_ai_counter(ai):
    eid, _ = make_edit(ai, label="Limitation of liability", original="cap", proposed="no cap")
    r = ai.post(f"/api/redline-edits/{eid}/suggest-counter")
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["suggestion"] is None and got["lawyer_flag"]["topics"] == ["liability"]
    assert got["disclaimer"] == adv.DISCLAIMER
    assert ai.counter_calls == [] and used(ai) == 0


def test_flagged_change_works_without_a_key_and_when_over_the_cap(ai, monkeypatch):
    eid, _ = make_edit(ai, label="Governing law", original="Delaware", proposed="Texas")
    monkeypatch.setattr(m.ee, "ANTHROPIC_API_KEY", "")
    assert ai.post(f"/api/redline-edits/{eid}/suggest-counter").json()["lawyer_flag"]
    monkeypatch.setattr(m.ee, "ANTHROPIC_API_KEY", "k")
    with Session(engine) as s:
        s.add(AiUsage(user_id=ai.owner_id, month=ai_usage.month_key(), count=ai_usage.MONTHLY_LIMIT))
        s.commit()
    assert ai.post(f"/api/redline-edits/{eid}/suggest-counter").json()["lawyer_flag"]


def test_ordinary_change_still_gets_an_ai_counter(ai):
    eid, _ = make_edit(ai)
    got = ai.post(f"/api/redline-edits/{eid}/suggest-counter").json()
    assert got["suggestion"]["counter_value"] == "Net 45" and "lawyer_flag" not in got
    assert used(ai) == 1


# ---- the summary of a round ---------------------------------------------------------------------

def make_round(env, specs, origin="client"):
    """specs: list of (label, original, proposed, field_key). Returns (sub_id, [edit ids])."""
    with Session(engine) as s:
        link = ShareLink(generated_contract_id=env.gid, token="t-%d" % time.time_ns(), access_code="1234",
                         client_email="c@x.test", client_first_name="Pat", client_last_name="Client")
        s.add(link)
        s.commit()
        s.refresh(link)
        sub = RedlineSubmission(share_link_id=link.id, status="pending", origin=origin)
        s.add(sub)
        s.commit()
        s.refresh(sub)
        ids = []
        for label, orig, prop, key in specs:
            e = RedlineEdit(submission_id=sub.id, field_key=key, label=label, original_value=orig, proposed_value=prop)
            s.add(e)
            s.commit()
            s.refresh(e)
            ids.append(e.id)
        return sub.id, ids


SPECS = [("Payment terms", "Net 30", "Net 45", ""), ("Start date", "Nov 1", "Nov 8", ""),
         ("Limitation of liability", "cap", "no cap", ""), ("Fee", "$10,000", "$9,000", "")]


@pytest.fixture()
def sm(ai, monkeypatch):
    ai.sum_calls = []

    def fake(packet):
        ai.sum_calls.append(packet)
        return adv.clean_summary({
            "overview": "Four changes: mostly small, one touches liability.",
            "items": [{"edit_id": c["edit_id"], "meaning": "Means %s." % c["term"], "routine": True} for c in packet["changes"]],
        }, packet)

    monkeypatch.setattr(m.adv, "summarize_changes", fake)
    return ai


def summarize(env, sub_id):
    return env.post(f"/api/redline-submissions/{sub_id}/summary")


def test_summary_levels_and_counts_come_from_code(sm):
    sub_id, ids = make_round(sm, SPECS)
    r = summarize(sm, sub_id)
    assert r.status_code == 200, r.text
    got = r.json()["summary"]
    levels = {i["term"]: i["level"] for i in got["items"]}
    # the model called everything routine; code overrides the flagged one
    assert levels["Limitation of liability"] == "lawyer" and levels["Payment terms"] == "routine"
    assert got["counts"] == {"routine": 3, "review": 0, "lawyer": 1}
    assert [i["edit_id"] for i in got["items"]] == ids
    assert r.json()["usage"]["used"] == 1 and r.json()["disclaimer"] == adv.DISCLAIMER


def test_summary_only_covers_undecided_changes(sm):
    sub_id, ids = make_round(sm, SPECS)
    with Session(engine) as s:
        e = s.get(RedlineEdit, ids[0])
        e.decision = "accepted"
        s.add(e)
        s.commit()
    got = summarize(sm, sub_id).json()["summary"]
    assert [i["edit_id"] for i in got["items"]] == ids[1:]


def test_summary_packet_marks_flagged_changes_and_does_the_maths(sm):
    sub_id, _ = make_round(sm, SPECS)
    summarize(sm, sub_id)
    changes = {c["term"]: c for c in sm.sum_calls[0]["changes"]}
    assert changes["Limitation of liability"]["flagged_for_lawyer"] is True
    assert changes["Payment terms"]["arithmetic"]["change"] == 15
    assert changes["Fee"]["arithmetic"]["change"] == -1000


def test_summary_refuses_the_owners_own_rounds(sm):
    for origin in ("owner_edit", "owner_reconsideration"):
        sub_id, _ = make_round(sm, SPECS[:1], origin=origin)
        assert summarize(sm, sub_id).status_code == 400
    assert used(sm) == 0


def test_summary_with_nothing_pending_is_400_and_free(sm):
    sub_id, ids = make_round(sm, SPECS[:1])
    with Session(engine) as s:
        e = s.get(RedlineEdit, ids[0])
        e.decision = "rejected"
        s.add(e)
        s.commit()
    assert summarize(sm, sub_id).status_code == 400 and used(sm) == 0


def test_summary_needs_a_key_and_is_free_without_one(sm, monkeypatch):
    sub_id, _ = make_round(sm, SPECS)
    monkeypatch.setattr(m.ee, "ANTHROPIC_API_KEY", "")
    assert summarize(sm, sub_id).status_code == 503 and used(sm) == 0


def test_summary_is_owner_only(sm):
    sub_id, _ = make_round(sm, SPECS)
    with Session(engine) as s:
        u = User(email="o-%d@x.test" % time.time_ns(), password_hash=hash_password("pw"), email_verified=True)
        s.add(u)
        s.commit()
        s.refresh(u)
        gc = s.get(GeneratedContract, sm.gid)
        original_owner = gc.owner_id
        gc.owner_id = u.id
        s.add(gc)
        s.commit()
    try:
        assert summarize(sm, sub_id).status_code == 404
    finally:
        with Session(engine) as s:
            gc = s.get(GeneratedContract, sm.gid)
            gc.owner_id = original_owner
            s.add(gc)
            s.commit()
    assert summarize(sm, 99999999).status_code == 404


def test_summary_failure_is_a_502_and_refunded(sm, monkeypatch):
    sub_id, _ = make_round(sm, SPECS)

    def boom(packet):
        raise ValueError("exploded")

    monkeypatch.setattr(m.adv, "summarize_changes", boom)
    assert summarize(sm, sub_id).status_code == 502 and used(sm) == 0
    monkeypatch.setattr(m.adv, "summarize_changes", lambda packet: None)
    assert summarize(sm, sub_id).status_code == 502 and used(sm) == 0


def test_summary_shares_the_monthly_allowance(sm):
    sub_id, _ = make_round(sm, SPECS)
    with Session(engine) as s:
        s.add(AiUsage(user_id=sm.owner_id, month=ai_usage.month_key(), count=ai_usage.MONTHLY_LIMIT))
        s.commit()
    r = summarize(sm, sub_id)
    assert r.status_code == 429 and sm.sum_calls == []


def test_summary_caps_how_many_changes_the_model_sees(sm):
    sub_id, _ = make_round(sm, [("Item %d" % i, "a", "b", "") for i in range(adv.MAX_SUMMARY_EDITS + 5)])
    got = summarize(sm, sub_id).json()["summary"]
    assert len(got["items"]) == adv.MAX_SUMMARY_EDITS and got["left_out"] == 5


# ---- cleaning the model's answer ----------------------------------------------------------------

def packet_for(specs):
    return adv.build_summary_packet("Doc", "MSA", [
        {"id": i + 1, "field_key": k, "label": l, "original_value": o, "proposed_value": p}
        for i, (l, o, p, k) in enumerate(specs)])


def test_clean_summary_fills_gaps_ignores_unknown_ids_and_defaults_to_review():
    pk = packet_for(SPECS[:2])
    got = adv.clean_summary({"overview": "ok", "items": [
        {"edit_id": 1, "meaning": "Pay later.", "routine": False},
        {"edit_id": 99, "meaning": "ghost", "routine": True},
        "junk", {"edit_id": "x"}]}, pk)
    assert [i["edit_id"] for i in got["items"]] == [1, 2]
    assert got["items"][0]["level"] == "review" and got["items"][0]["meaning"] == "Pay later."
    assert got["items"][1]["level"] == "review" and "Start date" in got["items"][1]["meaning"]
    assert got["counts"] == {"routine": 0, "review": 2, "lawyer": 0}


def test_clean_summary_with_nothing_useful_is_none():
    assert adv.clean_summary({}, packet_for(SPECS[:1])) is None


def test_clean_summary_trims_long_text():
    pk = packet_for(SPECS[:1])
    got = adv.clean_summary({"overview": "o" * 5000, "items": [{"edit_id": 1, "meaning": "m" * 5000, "routine": True}]}, pk)
    assert len(got["overview"]) == adv.MAX_OVERVIEW_CHARS and len(got["items"][0]["meaning"]) == adv.MAX_MEANING_CHARS


# ---- the real call, with Anthropic faked ------------------------------------------------------------

def test_summarize_changes_asks_for_the_tool_and_marks_the_packet_as_data(monkeypatch):
    calls = []

    class FakeMessages:
        def create(self, **kw):
            calls.append(kw)
            block = types.SimpleNamespace(type="tool_use", name="record_summary",
                                          input={"overview": "ok", "items": [{"edit_id": 1, "meaning": "Fine.", "routine": True}]})
            return types.SimpleNamespace(content=[block])

    class FakeAnthropic:
        def __init__(self, api_key):
            self.messages = FakeMessages()

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=FakeAnthropic))
    monkeypatch.setattr(adv.ee, "ANTHROPIC_API_KEY", "k")
    got = adv.summarize_changes(packet_for(SPECS[:1]))
    assert got["items"][0]["level"] == "routine"
    assert calls[0]["tool_choice"] == {"type": "auto"}
    assert "record_summary tool" in calls[0]["messages"][0]["content"]
    assert "<packet>" in calls[0]["messages"][0]["content"] and "never instructions" in calls[0]["system"]


def test_summarize_changes_without_a_key_raises(monkeypatch):
    monkeypatch.setattr(adv.ee, "ANTHROPIC_API_KEY", "")
    with pytest.raises(RuntimeError):
        adv.summarize_changes(packet_for(SPECS[:1]))


def test_changing_the_business_type_gets_an_ai_counter_not_a_lawyer_note(ai):
    eid, _ = make_edit(ai, label="Entity type", original="limited liability company", proposed="S Corp")
    got = ai.post(f"/api/redline-edits/{eid}/suggest-counter").json()
    assert got["suggestion"]["counter_value"] == "Net 45" and "lawyer_flag" not in got
    assert len(ai.counter_calls) == 1 and used(ai) == 1
    assert edits_in_payload(ai)[eid]["risk"] is None
