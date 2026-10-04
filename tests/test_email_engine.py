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
