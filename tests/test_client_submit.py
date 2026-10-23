"""A failing email provider (bad/revoked SendGrid key -> HTTP 401) must never
break the flow it is only a side-effect of. Before this, the client's
"Finalize and submit" 500'd AFTER the review was already saved, and the page
showed a blank error box.

Run with:  venv/bin/pytest tests/
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from test_multi_signer import env  # noqa: E402,F401
from app import main as m  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import GeneratedContract, RedlineSubmission, ShareLink, User  # noqa: E402


def _http_401(*a, **k):
    req = httpx.Request("POST", "https://api.sendgrid.com/v3/mail/send")
    raise httpx.HTTPStatusError("401 Unauthorized", request=req, response=httpx.Response(401, request=req))


def _net_down(*a, **k):
    raise httpx.ConnectError("boom")


def _link(env):
    with Session(engine) as s:
        link = ShareLink(generated_contract_id=env.gid, token="tok-%d" % time.time_ns(), access_code="ABCD",
                         client_email="client@x.test", client_first_name="Jamie", client_last_name="Client")
        s.add(link)
        s.commit()
        s.refresh(link)
        return link.token, link.id


@pytest.mark.parametrize("boom", [_http_401, _net_down])
def test_finalize_survives_a_failing_email_provider(env, monkeypatch, boom):
    with Session(engine) as s:
        owner = s.get(User, s.get(GeneratedContract, env.gid).owner_id)
        owner.notify_redline_submitted = True
        s.add(owner)
        s.commit()
    monkeypatch.setattr(m.ee, "send_email", boom)
    token, link_id = _link(env)
    c = TestClient(m.app)
    r = c.post(f"/api/share/{token}/submit", json={"edits": [], "note": "Looks fine"},
               headers={"x-share-session": m._issue_share_session(link_id)})
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        subs = s.exec(select(RedlineSubmission).where(RedlineSubmission.share_link_id == link_id)).all()
        assert len(subs) == 1 and subs[0].status == "pending"


def test_password_reset_and_confirmation_survive_a_failing_provider(env, monkeypatch):
    monkeypatch.setattr(m.ee, "send_email", _http_401)
    with Session(engine) as s:
        user = s.get(User, s.get(GeneratedContract, env.gid).owner_id)
        # forgot-password answers the same way whether or not the email went out
        r = TestClient(m.app).post("/api/forgot-password", json={"email": user.email})
        assert r.status_code == 200, r.text
