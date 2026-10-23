"""Share for review: the screen must tell the truth about whether the client
was emailed, let the sender resend, and suggest people already shared with.

Run with:  venv/bin/pytest tests/
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

from test_multi_signer import env  # noqa: E402,F401
from app import main as m  # noqa: E402

CLIENT = {"client_first_name": "Tiffany", "client_last_name": "Xia", "client_email": "tiffany@virio.ai"}


def _boom(*a, **k):
    req = httpx.Request("POST", "https://api.resend.com/emails")
    raise httpx.HTTPStatusError("403", request=req, response=httpx.Response(403, request=req))


def test_new_link_records_that_the_email_went_out(env, monkeypatch):
    sent = []
    monkeypatch.setattr(m.ee, "send_email", lambda *a, **k: sent.append(a))
    r = env.post(f"/api/generated/{env.gid}/share", json=CLIENT)
    assert r.status_code == 200, r.text
    assert r.json()["emailed_at"] and len(sent) == 1
    # reopening the modal must not email again
    again = env.post(f"/api/generated/{env.gid}/share")
    assert again.json()["emailed_at"] == r.json()["emailed_at"] and len(sent) == 1


def test_failed_email_is_reported_and_can_be_resent(env, monkeypatch):
    monkeypatch.setattr(m.ee, "send_email", _boom)
    r = env.post(f"/api/generated/{env.gid}/share", json=CLIENT)
    assert r.status_code == 200, r.text          # the link itself still gets created
    assert r.json()["emailed_at"] is None        # ...and the screen can say it wasn't emailed
    bad = env.post(f"/api/generated/{env.gid}/share/email")
    assert bad.status_code == 502 and "couldn't send" in bad.json()["detail"].lower()
    monkeypatch.setattr(m.ee, "send_email", lambda *a, **k: None)
    ok = env.post(f"/api/generated/{env.gid}/share/email")
    assert ok.status_code == 200 and ok.json()["emailed_at"]


def test_resend_needs_an_open_link(env, monkeypatch):
    monkeypatch.setattr(m.ee, "send_email", lambda *a, **k: None)
    assert env.post(f"/api/generated/{env.gid}/share/email").status_code == 404


def test_recipients_are_suggested_once_per_email(env, monkeypatch):
    monkeypatch.setattr(m.ee, "send_email", lambda *a, **k: None)
    env.post(f"/api/generated/{env.gid}/share", json=CLIENT)
    got = env.get("/api/recipients").json()
    mine = [r for r in got if r["email"].lower() == "tiffany@virio.ai"]
    assert len(mine) == 1 and mine[0]["first_name"] == "Tiffany" and mine[0]["last_name"] == "Xia"
