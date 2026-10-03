"""
Bug tracker: a signer declining to sign used to update DB status only --
no bell notification, no email -- so the owner had no way to find out
short of opening the document and checking. These tests cover the fix in
_apply_signer_declined / _apply_submission_declined (app/main.py).

DATA_DIR is pointed at a fresh temp directory *before* app.main is
imported, since app/db.py creates its sqlite engine at import time --
this keeps these tests from ever touching the real dev database.

Run with:  venv/bin/pytest tests/
"""
import os
import sys
import tempfile
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="rotely_test_notifications_")

from sqlmodel import Session, select  # noqa: E402

from app import main as m  # noqa: E402
from app.db import engine, init_db  # noqa: E402
from app.models import (  # noqa: E402
    User, GeneratedContract, SigningRequest, SigningRequestSigner, Notification,
)

init_db()


def _make_request(session, *, notify=True):
    """One owner + one generated contract + one pending SigningRequest with
    one signer, ready to be fed into the _apply_* functions under test."""
    uid = uuid.uuid4().hex
    owner = User(email=f"owner-{uid}@example.com", password_hash="x", notify_signature_events=notify)
    session.add(owner)
    session.commit()
    session.refresh(owner)

    gc = GeneratedContract(
        owner_id=owner.id, template_name="Test Template", name="Test Contract",
        file_path="x.docx", values_json="[]",
    )
    session.add(gc)
    session.commit()
    session.refresh(gc)

    sr = SigningRequest(generated_contract_id=gc.id, docuseal_submission_id=uuid.uuid4().int % 1_000_000_000)
    session.add(sr)
    session.commit()
    session.refresh(sr)

    signer = SigningRequestSigner(
        signing_request_id=sr.id, docuseal_submitter_id=uuid.uuid4().int % 1_000_000_000,
        role="Client", name="Jamie Signer", email="jamie@example.com",
        token=f"tok-{uid}",
    )
    session.add(signer)
    session.commit()
    session.refresh(signer)

    return owner, gc, sr, signer


def _notifications_for(session, owner):
    return session.exec(select(Notification).where(Notification.user_id == owner.id)).all()


def test_signer_decline_notifies_owner_and_marks_declined():
    with Session(engine) as session:
        owner, gc, sr, signer = _make_request(session)

        m._apply_signer_declined(session, signer.docuseal_submitter_id)

        session.refresh(signer)
        session.refresh(sr)
        assert signer.status == "declined"
        assert sr.status == "declined"

        notes = _notifications_for(session, owner)
        assert len(notes) == 1
        assert notes[0].type == "signature_declined"
        assert "Jamie Signer" in notes[0].title


def test_signer_decline_respects_notify_opt_out():
    with Session(engine) as session:
        owner, gc, sr, signer = _make_request(session, notify=False)

        m._apply_signer_declined(session, signer.docuseal_submitter_id)

        session.refresh(sr)
        assert sr.status == "declined"  # status still updates regardless of the toggle
        assert _notifications_for(session, owner) == []


def test_submission_declined_notifies_owner_when_it_is_the_first_event():
    with Session(engine) as session:
        owner, gc, sr, signer = _make_request(session)

        m._apply_submission_declined(session, sr.docuseal_submission_id)

        session.refresh(sr)
        assert sr.status == "declined"
        notes = _notifications_for(session, owner)
        assert len(notes) == 1
        assert notes[0].type == "signature_declined"


def test_decline_notifies_exactly_once_however_many_webhook_events_arrive():
    # DocuSeal can deliver both form.declined (-> _apply_signer_declined)
    # and submission.declined (-> _apply_submission_declined) for the same
    # decline. Whichever lands first flips sr out of "pending" and
    # notifies; the second must find sr already "declined" and do
    # nothing, so the owner is never notified twice for one decline.
    with Session(engine) as session:
        owner, gc, sr, signer = _make_request(session)

        m._apply_signer_declined(session, signer.docuseal_submitter_id)
        m._apply_submission_declined(session, sr.docuseal_submission_id)

        assert len(_notifications_for(session, owner)) == 1

    with Session(engine) as session:
        owner, gc, sr, signer = _make_request(session)

        # Same check in the other arrival order.
        m._apply_submission_declined(session, sr.docuseal_submission_id)
        m._apply_signer_declined(session, signer.docuseal_submitter_id)

        assert len(_notifications_for(session, owner)) == 1


def test_signer_decline_is_a_no_op_once_already_declined():
    with Session(engine) as session:
        owner, gc, sr, signer = _make_request(session)

        m._apply_signer_declined(session, signer.docuseal_submitter_id)
        m._apply_signer_declined(session, signer.docuseal_submitter_id)

        assert len(_notifications_for(session, owner)) == 1
