"""The sample document: a made-up contract and client to practice on. It is a
real template and drafted contract (so every real screen works on it), but it
never emails anyone, never uses up the monthly plan, and can't be sent for
signature.

Run with:  venv/bin/pytest tests/
"""
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

if "app.db" not in sys.modules:
    os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="rotely_test_sample_")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from app import email_engine as ee  # noqa: E402
from app import main as m  # noqa: E402
from app.auth import hash_password  # noqa: E402
from app.db import engine, init_db  # noqa: E402
from app.models import GeneratedContract, Notification, RedlineEdit, ShareLink, Template, User  # noqa: E402

init_db()


@pytest.fixture()
def env():
    with Session(engine) as s:
        u = User(email="sample-%d@x.test" % time.time_ns(), password_hash=hash_password("pw"), email_verified=True, name="Sam Owner")
        s.add(u)
        s.commit()
        s.refresh(u)
        email = u.email
    c = TestClient(m.app)
    assert c.post("/api/login", json={"email": email, "password": "pw"}).status_code == 200
    return c


def test_starts_empty_and_can_be_created(env):
    assert env.get("/api/sample").json() == {"exists": False}
    r = env.post("/api/sample")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["exists"] and d["generated_id"] and d["template_id"] and d["access_code"] == "SAMPLE24"
    assert "/share/" in d["share_url"]
    assert env.get("/api/sample").json()["generated_id"] == d["generated_id"]


def test_sample_has_three_pending_redlines_and_a_bell(env):
    d = env.post("/api/sample").json()
    subs = env.get(f"/api/generated/{d['generated_id']}/redlines").json()["submissions"]
    assert len(subs) == 1
    edits = subs[0]["edits"]
    assert [e["label"] for e in edits] == ["Payment terms", "Confidentiality period", "Governing law"]
    assert all(e["decision"] == "pending" for e in edits)
    assert edits[0]["original_value"] == "thirty (30) days of receipt"
    assert edits[2]["original_value"] == edits[2]["proposed_value"] == "Delaware"  # a comment-only change
    doc = env.get(f"/api/generated/{d['generated_id']}").json()
    assert doc["is_sample"] is True and doc["status"]["key"] == "submitted"
    notes = env.get("/api/notifications").json()["notifications"]
    assert any(n["type"] == "redline_submitted" and n["generated_contract_id"] == d["generated_id"] for n in notes)


def test_flagged_in_lists(env):
    env.post("/api/sample")
    assert [t["is_sample"] for t in env.get("/api/templates").json()] == [True]
    assert [g["is_sample"] for g in env.get("/api/generated").json()] == [True]


def test_reset_replaces_and_remove_cleans_up(env):
    first = env.post("/api/sample").json()
    env.post("/api/sample")
    docs = env.get("/api/generated").json()
    tpls = env.get("/api/templates").json()
    assert len(docs) == 1 and len(tpls) == 1  # reset, not duplicated
    assert env.delete("/api/sample").json() == {"ok": True}
    assert env.get("/api/sample").json() == {"exists": False}
    assert env.get("/api/generated").json() == [] and env.get("/api/templates").json() == []
    assert env.get("/api/notifications").json()["notifications"] == []
    assert first["exists"]


def test_does_not_touch_the_plan_and_cannot_be_signed(env):
    d = env.post("/api/sample").json()
    before = env.get("/api/me").json()["plan"]["used"]
    # drafting from the sample template is free
    tpl = env.get("/api/templates").json()[0]
    vals = {"provider_name": "A", "client_name": "B", "start_date": "today", "monthly_fee": "$1"}
    r = env.post(f"/api/templates/{d['template_id']}/generate", json={"values": vals, "parties": ["A", "B"]})
    assert r.status_code == 200, r.text
    assert env.get("/api/me").json()["plan"]["used"] == before
    assert tpl["is_sample"]
    # and neither it nor a draft from it can go out for signature
    for gid in (d["generated_id"], r.json()["generated_id"]):
        s = env.post(f"/api/generated/{gid}/signature-request", json={"signers": [{"name": "A", "email": "a@x.test", "role": "Client"}]})
        assert s.status_code == 400 and "sample" in s.json()["detail"].lower()


def test_responding_to_the_sample_sends_no_email(env, monkeypatch):
    sent = []
    monkeypatch.setattr(ee, "email_provider", lambda: "resend")
    monkeypatch.setattr(ee, "_send_via_resend", lambda *a, **k: sent.append(a[0]))
    d = env.post("/api/sample").json()
    sub = env.get(f"/api/generated/{d['generated_id']}/redlines").json()["submissions"][0]
    r = env.post(f"/api/redline-submissions/{sub['id']}/respond",
                 json={"decisions": [{"edit_id": e["id"], "decision": "accepted"} for e in sub["edits"][:2]]})
    assert r.status_code == 200, r.text
    assert sent == []  # the made-up client's address can never receive mail
    # a real address still gets mail through the same function
    ee.send_email("real@example.com", "hi", "body")
    assert sent == ["real@example.com"]


def test_apply_accepted_changes_keeps_working_on_the_sample(env):
    d = env.post("/api/sample").json()
    sub = env.get(f"/api/generated/{d['generated_id']}/redlines").json()["submissions"][0]
    assert env.post(f"/api/redline-submissions/{sub['id']}/respond",
                    json={"decisions": [{"edit_id": e["id"], "decision": "accepted"} for e in sub["edits"][:2]]}).status_code == 200
    r = env.post(f"/api/redline-submissions/{sub['id']}/apply")
    assert r.status_code == 200, r.text
    docs = env.get("/api/generated").json()
    assert len(docs) == 2 and all(g["is_sample"] for g in docs)
    # resetting still clears the new revision too
    env.post("/api/sample")
    assert len(env.get("/api/generated").json()) == 1


def test_other_users_do_not_see_it(env):
    env.post("/api/sample")
    other = TestClient(m.app)
    with Session(engine) as s:
        u = User(email="other-%d@x.test" % time.time_ns(), password_hash=hash_password("pw"), email_verified=True, name="Other")
        s.add(u)
        s.commit()
        email = u.email
    other.post("/api/login", json={"email": email, "password": "pw"})
    assert other.get("/api/sample").json() == {"exists": False}
    assert other.get("/api/generated").json() == []
