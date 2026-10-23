"""Unit tests for the alias parsing/generation and template-matching logic
in email_engine. Sending mail and AI extraction need live API keys, so
those aren't covered here -- see main.py's inbound webhook, which is
exercised against a running server (with no keys configured, to confirm it
degrades safely) rather than in this file.

Run with:  venv/bin/pytest tests/
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import email_engine as ee


def test_alias_address_format():
    assert ee.alias_address("acmecorp", "123456") == "drafts+acmecorp+123456@rotely.ai"


def test_slugify_company_strips_non_alnum():
    assert ee.slugify_company("Acme Corp, LLC.") == "acmecorpllc"
    assert ee.slugify_company("") == "account"


def test_generate_alias_number_is_long_lowercase_alphanumeric():
    # QA: was 6 digits (1M possibilities, enumerable). Legacy 6-digit numbers
    # still PARSE (see test_parse_alias_plain_address) -- only new ones change.
    n = ee.generate_alias_number()
    assert len(n) == 12
    assert n.isalnum() and n == n.lower()


def test_parse_alias_plain_address():
    parsed = ee.parse_alias("drafts+acmecorp+123456@rotely.ai")
    assert parsed == {"company_slug": "acmecorp", "number": "123456", "continue_request_id": None}


def test_parse_alias_with_display_name():
    parsed = ee.parse_alias('"Rotely Drafts" <drafts+acmecorp+123456@rotely.ai>')
    assert parsed["company_slug"] == "acmecorp"
    assert parsed["number"] == "123456"


def test_parse_alias_case_insensitive():
    parsed = ee.parse_alias("DRAFTS+AcmeCorp+123456@ROTELY.AI")
    assert parsed["company_slug"] == "acmecorp"


def test_parse_alias_with_continuation_suffix():
    parsed = ee.parse_alias("drafts+acmecorp+123456+continue-42@rotely.ai")
    assert parsed == {"company_slug": "acmecorp", "number": "123456", "continue_request_id": 42}


def test_parse_alias_returns_none_for_unrelated_address():
    assert ee.parse_alias("someone@example.com") is None
    assert ee.parse_alias("") is None


def test_continuation_address_roundtrips_through_parse_alias():
    addr = ee.continuation_address("acmecorp", "123456", 42)
    parsed = ee.parse_alias(addr)
    assert parsed["continue_request_id"] == 42


def test_match_template_from_subject_by_name():
    templates = [
        {"id": 1, "name": "Freelance Services Agreement", "document_type": "Services Agreement"},
        {"id": 2, "name": "Standard NDA", "document_type": "NDA"},
    ]
    match = ee.match_template_from_subject("Draft: Standard NDA please", templates)
    assert match["id"] == 2


def test_match_template_from_subject_prefers_longer_more_specific_name():
    templates = [
        {"id": 1, "name": "Services Agreement", "document_type": "Services Agreement"},
        {"id": 2, "name": "Freelance Services Agreement", "document_type": "Services Agreement"},
    ]
    match = ee.match_template_from_subject("Draft: Freelance Services Agreement", templates)
    assert match["id"] == 2


def test_match_template_from_subject_no_match_returns_none():
    templates = [{"id": 1, "name": "Standard NDA", "document_type": "NDA"}]
    assert ee.match_template_from_subject("Can you help me with something", templates) is None


def test_compute_missing_required_only_flags_required_and_blank():
    placeholders = [
        {"field_key": "client_name", "required": True},
        {"field_key": "notes", "required": False},
        {"field_key": "effective_date", "required": True},
    ]
    values = {"client_name": "Acme", "effective_date": ""}
    missing = ee.compute_missing_required(placeholders, values)
    assert missing == ["effective_date"]


# --- provider switch: Resend when RESEND_API_KEY is set, else SendGrid ------

def test_send_email_uses_resend_when_its_key_is_set(monkeypatch):
    import httpx
    from app import email_engine as ee
    seen = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        seen.update(url=url, json=json, headers=headers)
        return httpx.Response(200, request=httpx.Request("POST", url))

    monkeypatch.setattr(ee, "RESEND_API_KEY", "re_test")
    monkeypatch.setattr(ee, "SENDGRID_API_KEY", "sg_test")  # Resend wins when both are set
    monkeypatch.setattr(ee, "EMAIL_FROM", "hello@example.com")
    monkeypatch.setattr(ee.httpx, "post", fake_post)
    ee.send_email("a@b.co", "Hi", "Body", reply_to="me@x.co",
                  attachments=[{"filename": "f.docx", "content_bytes": b"abc"}])
    assert seen["url"] == "https://api.resend.com/emails"
    assert seen["headers"]["Authorization"] == "Bearer re_test"
    j = seen["json"]
    assert j["to"] == ["a@b.co"] and j["subject"] == "Hi" and j["text"] == "Body"
    assert j["reply_to"] == "me@x.co" and j["from"].endswith("<hello@example.com>")
    assert j["attachments"][0]["filename"] == "f.docx"


def test_send_email_falls_back_to_sendgrid(monkeypatch):
    import httpx
    from app import email_engine as ee
    seen = {}
    monkeypatch.setattr(ee, "RESEND_API_KEY", "")
    monkeypatch.setattr(ee, "SENDGRID_API_KEY", "sg_test")
    monkeypatch.setattr(ee.httpx, "post", lambda url, **k: seen.update(url=url) or httpx.Response(202, request=httpx.Request("POST", url)))
    ee.send_email("a@b.co", "Hi", "Body")
    assert seen["url"] == "https://api.sendgrid.com/v3/mail/send"


def test_send_email_with_no_provider_raises_runtimeerror(monkeypatch):
    import pytest
    from app import email_engine as ee
    monkeypatch.setattr(ee, "RESEND_API_KEY", "")
    monkeypatch.setattr(ee, "SENDGRID_API_KEY", "")
    with pytest.raises(RuntimeError):
        ee.send_email("a@b.co", "Hi", "Body")
