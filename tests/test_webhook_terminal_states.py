"""Regression tests for the webhook resurrection bug (mega-sweep H1-H3, M9).

A late or retried DocuSeal `submission.completed` webhook must never flip
a cancelled, expired, or declined signature request back to "completed",
and `form.completed` must not mutate signer rows on a non-pending request.
The normal pending -> completed path must keep working.

Run with:  venv/bin/pytest tests/
"""
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

if "app.db" not in sys.modules:
    os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="rotely_test_webhook_terminal_")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from app import main as m  # noqa: E402
from app import docuseal_engine as ds  # noqa: E402
from app.db import engine, init_db  # noqa: E402
from app.auth import hash_password  # noqa: E402
from app.models import (  # noqa: E402
    GeneratedContract, SigningRequest, SigningRequestSigner, User,
)

init_db()

SECRET = "whsec_test_resurrect"


@pytest.fixture()
def webhook_env(monkeypatch):
    """Point the webhook verifier at a test secret and neuter side effects,
    restoring everything after each test so other suites are unaffected."""
    monkeypatch.setattr(ds, "DOCUSEAL_WEBHOOK_SECRET", SECRET)
    monkeypatch.setattr(m.ds, "get_submission_documents",
                        lambda submission_id: {"documents": []})
    monkeypatch.setattr(m, "_notify", lambda *a, **k: None)


@pytest.fixture()
def client(webhook_env):
    with Session(engine) as s:
        u = User(email="resurrect-%d@x.test" % time.time_ns(), password_hash=hash_password("pw"),
                 email_verified=True, name="O")
        s.add(u)
        s.commit()
        s.refresh(u)
        uid = u.id
    c = TestClient(m.app)
    assert c.post("/api/login", json={"email": u.email, "password": "pw"}).status_code == 200
    c.owner_id = uid
    return c


def make_sr(owner_id, status, n_signers=1, sub_id=None):
    with Session(engine) as s:
        gc = GeneratedContract(owner_id=owner_id, template_name="t", name="n",
                               file_path="/tmp/x.docx", values_json="[]")
        s.add(gc)
        s.commit()
        s.refresh(gc)
        sr = SigningRequest(
            generated_contract_id=gc.id,
            docuseal_submission_id=sub_id or "sub_%s_%d" % (status, gc.id),
            status=status,
        )
        s.add(sr)
        s.commit()
        s.refresh(sr)
        submitters = []
        for i in range(n_signers):
            sg = SigningRequestSigner(
                signing_request_id=sr.id, docuseal_submitter_id=8000 + sr.id * 10 + i,
                role="Client", name="S%d" % i, email="s%d@x.test" % i,
                token="tok_%d_%d" % (sr.id, i), status="awaiting_consent",
            )
            s.add(sg)
            s.commit()
            s.refresh(sg)
            submitters.append(sg.docuseal_submitter_id)
        return sr.id, sr.docuseal_submission_id, submitters


def signed_post(client, payload):
    body = json.dumps(payload, separators=(",", ":")).encode()
    ts = str(int(time.time()))
    sig = hmac.new(SECRET.encode(), (ts + ".").encode() + body, hashlib.sha256).hexdigest()
    return client.post(
        "/api/webhooks/docuseal", content=body,
        headers={"Content-Type": "application/json",
                 "X-Docuseal-Signature": ts + "." + sig},
    )


def sr_status(sr_id):
    with Session(engine) as s:
        return s.get(SigningRequest, sr_id).status


@pytest.mark.parametrize("terminal", ["cancelled", "expired", "declined"])
def test_completed_webhook_cannot_resurrect_terminal_request(client, terminal):
    sr_id, sub_id, _ = make_sr(client.owner_id, terminal)
    r = signed_post(client, {"event_type": "submission.completed", "data": {"id": sub_id}})
    assert r.status_code == 200
    assert sr_status(sr_id) == terminal


def test_form_completed_ignored_on_declined_request(client):
    sr_id, sub_id, (submitter_id,) = make_sr(client.owner_id, "declined")
    r = signed_post(client, {"event_type": "form.completed", "data": {"id": submitter_id}})
    assert r.status_code == 200
    assert sr_status(sr_id) == "declined"
    with Session(engine) as s:
        sg = s.exec(select(SigningRequestSigner).where(
            SigningRequestSigner.docuseal_submitter_id == submitter_id)).first()
        assert sg.status == "awaiting_consent"


def test_pending_request_still_completes(client):
    sr_id, sub_id, _ = make_sr(client.owner_id, "pending")
    r = signed_post(client, {"event_type": "submission.completed", "data": {"id": sub_id}})
    assert r.status_code == 200
    assert sr_status(sr_id) == "completed"


def test_mid_flight_signer_completion_still_works(client):
    sr_id, _, (sub_a, sub_b) = make_sr(client.owner_id, "pending", n_signers=2,
                                       sub_id="sub_2sign_%d" % time.time_ns())
    r = signed_post(client, {"event_type": "form.completed", "data": {"id": sub_a}})
    assert r.status_code == 200
    with Session(engine) as s:
        sg = s.exec(select(SigningRequestSigner).where(
            SigningRequestSigner.docuseal_submitter_id == sub_a)).first()
        assert sg.status == "completed"
    assert sr_status(sr_id) == "pending"  # other signer still out
