"""Inbound email drafting through Resend: the signature check, reading the
body (the webhook only carries metadata), and that a forwarded email lands on
the right account. The older SendGrid form path must keep working.

Run with:  venv/bin/pytest tests/
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from test_multi_signer import env  # noqa: E402,F401
from app import email_engine as ee  # noqa: E402
from app import main as m  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import GeneratedContract, User  # noqa: E402
from sqlmodel import Session  # noqa: E402

KEY = base64.b64encode(b"super-secret-bytes").decode()
SIGNING = "whsec_" + KEY
PATH_SECRET = "path-secret-xyz"


def sign(body: bytes, msg_id="msg_1", ts=None, key=KEY):
    ts = str(int(ts if ts is not None else time.time()))
    mac = hmac.new(base64.b64decode(key), f"{msg_id}.{ts}.".encode() + body, hashlib.sha256).digest()
    return {"svix-id": msg_id, "svix-timestamp": ts, "svix-signature": "v1," + base64.b64encode(mac).decode(),
            "content-type": "application/json"}


# --- signature -------------------------------------------------------------

def test_valid_signature_passes_and_tampering_fails():
    body = b'{"type":"email.received"}'
    h = sign(body)
    assert ee.verify_resend_signature(SIGNING, h["svix-id"], h["svix-timestamp"], h["svix-signature"], body)
    assert not ee.verify_resend_signature(SIGNING, h["svix-id"], h["svix-timestamp"], h["svix-signature"], body + b" ")
    other = "whsec_" + base64.b64encode(b"different").decode()
    assert not ee.verify_resend_signature(other, h["svix-id"], h["svix-timestamp"], h["svix-signature"], body)


def test_old_signatures_are_rejected_and_rotation_lists_are_accepted():
    body = b"{}"
    old = sign(body, ts=time.time() - 3600)
    assert not ee.verify_resend_signature(SIGNING, old["svix-id"], old["svix-timestamp"], old["svix-signature"], body)
    good = sign(body)
    rotated = "v1,AAAA " + good["svix-signature"]
    assert ee.verify_resend_signature(SIGNING, good["svix-id"], good["svix-timestamp"], rotated, body)
    assert not ee.verify_resend_signature(SIGNING, "", good["svix-timestamp"], good["svix-signature"], body)


def test_html_only_emails_become_readable_text():
    text = ee.html_to_text("<style>x{}</style><p>Client: <b>Acme &amp; Co</b></p><div>Term: 12 months</div>")
    assert "Client: Acme & Co" in text and "Term: 12 months" in text and "<" not in text


# --- the webhook -----------------------------------------------------------

@pytest.fixture()
def hook(env, monkeypatch):
    monkeypatch.setattr(m, "INBOUND_WEBHOOK_SECRET", PATH_SECRET)
    monkeypatch.setattr(ee, "RESEND_WEBHOOK_SECRET", SIGNING)
    address = env.get("/api/account/email-alias").json()["address"]
    got = []
    monkeypatch.setattr(m, "_process_draft_request",
                        lambda session, user, req, subject, body: got.append(
                            {"user": user.id, "from": req.from_address, "subject": subject, "body": body}))
    monkeypatch.setattr(ee, "fetch_received_email", lambda email_id: {
        "text": "Client is Acme", "html": "<p>ignored</p>", "authentication": {"spf": "pass", "dkim": "pass", "dmarc": "pass"}})
    with Session(engine) as s:
        env.owner_email = s.get(User, s.get(GeneratedContract, env.gid).owner_id).email
    env.address, env.got = address, got
    return env


def post(env, payload, headers=None, path=PATH_SECRET):
    body = json.dumps(payload).encode()
    return TestClient(m.app).post(f"/api/email/inbound/{path}", content=body, headers=headers or sign(body))


def received(address, **over):
    data = {"email_id": "e1", "from": "Boss <boss@acme.test>", "to": [address], "received_for": [],
            "subject": "NDA for Acme"}
    data.update(over)
    return {"type": "email.received", "data": data}


def test_forwarded_email_reaches_the_right_account(hook):
    r = post(hook, received(hook.address, **{"from": f"Boss <{hook.owner_email}>"}))
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert len(hook.got) == 1
    g = hook.got[0]
    assert g["from"] == hook.owner_email and g["subject"] == "NDA for Acme" and g["body"] == "Client is Acme"


def test_html_body_is_used_when_there_is_no_text_part(hook, monkeypatch):
    monkeypatch.setattr(ee, "fetch_received_email", lambda email_id: {"text": None, "html": "<p>Client: Acme</p>", "authentication": {"dmarc": "pass"}})
    post(hook, received(hook.address, **{"from": hook.owner_email}))
    assert hook.got[0]["body"] == "Client: Acme"


def test_bad_signature_is_refused_and_nothing_is_drafted(hook):
    body = json.dumps(received(hook.address)).encode()
    forged = sign(body, key=base64.b64encode(b"attacker").decode())
    r = TestClient(m.app).post(f"/api/email/inbound/{PATH_SECRET}", content=body, headers=forged)
    assert r.status_code == 401 and hook.got == []


def test_wrong_path_secret_is_a_404(hook):
    assert post(hook, received(hook.address), path="nope").status_code == 404 and hook.got == []


def test_other_event_types_are_ignored(hook):
    r = post(hook, {"type": "email.delivered", "data": {}})
    assert r.status_code == 200 and r.json()["ignored"] == "email.delivered" and hook.got == []


def test_unreadable_body_asks_resend_to_retry(hook, monkeypatch):
    def boom(email_id):
        raise httpx.ConnectError("down")
    monkeypatch.setattr(ee, "fetch_received_email", boom)
    assert post(hook, received(hook.address)).status_code == 502 and hook.got == []


def test_unknown_address_is_not_drafted(hook):
    r = post(hook, received("drafts+nobody+abcdef123456@" + ee.EMAIL_DOMAIN))
    assert r.json()["ok"] is False and hook.got == []


def test_sendgrid_form_posts_still_work(hook, monkeypatch):
    monkeypatch.setattr(ee, "RESEND_WEBHOOK_SECRET", "")  # the legacy path exists only where no Resend signing secret is set
    r = TestClient(m.app).post(f"/api/email/inbound/{PATH_SECRET}", data={
        "to": hook.address, "from": hook.owner_email, "subject": "NDA for Acme", "text": "Client is Acme",
        "dkim": "{@%s : pass}" % hook.owner_email.split("@")[1]})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert hook.got[0]["body"] == "Client is Acme"
