"""Unit tests for docuseal_engine's webhook signature verification --
the one piece of this module that's pure logic with no live API call, same
as test_email_engine.py only covers email_engine's alias parsing and not
its actual SendGrid send. Creating/archiving a real submission needs a live
DocuSeal account, so that's exercised by hand against the real API instead
of in this committed suite.

Run with:  venv/bin/pytest tests/
"""
import hashlib
import hmac
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import jwt as pyjwt

from app import docuseal_engine as ds

SECRET = "whsec_test_secret_value"
BODY = b'{"event_type":"submission.completed","data":{"id":1}}'


def _sign(body: bytes, secret: str, timestamp: int) -> str:
    ts = str(timestamp)
    sig = hmac.new(secret.encode("utf-8"), f"{ts}.".encode("utf-8") + body, hashlib.sha256).hexdigest()
    return f"{ts}.{sig}"


def test_valid_signature_verifies():
    header = _sign(BODY, SECRET, int(time.time()))
    assert ds.verify_webhook_signature(BODY, header, SECRET) is True


def test_wrong_secret_rejected():
    header = _sign(BODY, SECRET, int(time.time()))
    assert ds.verify_webhook_signature(BODY, header, "whsec_wrong") is False


def test_tampered_body_rejected():
    header = _sign(BODY, SECRET, int(time.time()))
    assert ds.verify_webhook_signature(BODY + b"tampered", header, SECRET) is False


def test_stale_timestamp_rejected():
    header = _sign(BODY, SECRET, int(time.time()) - 400)  # outside the 300s default tolerance
    assert ds.verify_webhook_signature(BODY, header, SECRET) is False


def test_missing_header_rejected():
    assert ds.verify_webhook_signature(BODY, "", SECRET) is False


def test_malformed_header_rejected():
    assert ds.verify_webhook_signature(BODY, "not-a-valid-header", SECRET) is False


def test_non_numeric_timestamp_rejected():
    assert ds.verify_webhook_signature(BODY, "not-a-number.somesignature", SECRET) is False


def test_empty_secret_always_rejects():
    # Matches main.py's docuseal_webhook route: an unconfigured
    # DOCUSEAL_WEBHOOK_SECRET must fail closed (401 everything), never
    # silently accept an unverifiable payload.
    header = _sign(BODY, SECRET, int(time.time()))
    assert ds.verify_webhook_signature(BODY, header, "") is False


# mint_builder_token is pure logic (just JWT signing, no network call), so
# it's covered here like the webhook verification above -- creating an
# actual template/submission from a template still needs a live DocuSeal
# account and is exercised by hand against the real API, same as before.

def test_mint_builder_token_payload():
    original_key = ds.DOCUSEAL_API_KEY
    ds.DOCUSEAL_API_KEY = "test_api_key_for_unit_test_only_do_not_use"
    try:
        token = ds.mint_builder_token(template_id=42, name="Test Doc")
        decoded = pyjwt.decode(token, ds.DOCUSEAL_API_KEY, algorithms=["HS256"])
        assert decoded["template_id"] == 42
        assert decoded["name"] == "Test Doc"
        assert decoded["user_email"] == ds.DOCUSEAL_ACCOUNT_EMAIL
    finally:
        ds.DOCUSEAL_API_KEY = original_key


def test_mint_builder_token_requires_api_key():
    original_key = ds.DOCUSEAL_API_KEY
    ds.DOCUSEAL_API_KEY = ""
    try:
        try:
            ds.mint_builder_token(template_id=1, name="x")
            assert False, "expected RuntimeError when DOCUSEAL_API_KEY is unset"
        except RuntimeError:
            pass
    finally:
        ds.DOCUSEAL_API_KEY = original_key
