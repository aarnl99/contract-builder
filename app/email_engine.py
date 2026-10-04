"""Everything needed for "draft this from an email":

  1. Generating and parsing the per-account drafting alias
     (drafts+{company}+{number}@{EMAIL_DOMAIN}), including the
     +continue-{request_id} suffix used to thread a reply back to the
     pending request it's answering.
  2. Sending outbound mail (the "still need a few things" reply and the
     "your draft is ready" notification) through SendGrid's Mail Send API.
  3. Matching an inbound email to one of the account's master documents by
     a keyword in the subject line, and asking an LLM to pull field values
     out of the free-form email body for that document's placeholders.

None of this touches the database -- main.py owns that -- so it can be
unit tested without a live SendGrid or Anthropic account. Functions that
need those raise a plain RuntimeError if the relevant API key isn't
configured, rather than failing in some more confusing way deeper in a
third-party client.
"""
import base64
import json
import os
import re
import secrets
import string
from typing import Optional

import httpx

EMAIL_DOMAIN = os.environ.get("EMAIL_DOMAIN", "rotely.ai")
SENDGRID_API_KEY = os.environ.get("SENDGRID_API_KEY", "")
SENDGRID_FROM_EMAIL = os.environ.get("SENDGRID_FROM_EMAIL", f"drafts@{EMAIL_DOMAIN}")
SENDGRID_FROM_NAME = os.environ.get("SENDGRID_FROM_NAME", "Rotely")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
EMAIL_AGENT_MODEL = os.environ.get("EMAIL_AGENT_MODEL", "claude-3-5-sonnet-latest")

_ALIAS_RE = re.compile(
    r"drafts\+([a-z0-9]+)\+([a-z0-9]{6,32})(?:\+continue-(\d+))?@" + re.escape(EMAIL_DOMAIN),
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Alias generation / parsing
# ---------------------------------------------------------------------------

def slugify_company(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "", (name or "").lower())
    return slug or "account"


ALIAS_NUMBER_LENGTH = 12
_ALIAS_CHARS = string.ascii_lowercase + string.digits


def generate_alias_number() -> str:
    """A random token that isn't guessable from the company name -- the
    entire point of it existing is to make the address hard to spoof.
    Security (QA): this used to be 6 digits (1M possibilities, trivially
    enumerable by anyone who knows a company slug). Now 12 chars of
    a-z0-9 (~62 bits). Existing 6-digit aliases keep working until their
    owner regenerates -- the parser below still accepts them."""
    return "".join(secrets.choice(_ALIAS_CHARS) for _ in range(ALIAS_NUMBER_LENGTH))


def alias_address(company_slug: str, number: str) -> str:
    return f"drafts+{company_slug}+{number}@{EMAIL_DOMAIN}"


def continuation_address(company_slug: str, number: str, request_id: int) -> str:
    """Reply-To address used on a "still need a few things" email, so a
    reply routes back to the same pending request instead of starting a
    new one. Gmail (and everyone else) ignores everything after the first
    "+" for delivery purposes, so mail still lands in the same inbox."""
    return f"drafts+{company_slug}+{number}+continue-{request_id}@{EMAIL_DOMAIN}"


def parse_alias(to_header: str) -> Optional[dict]:
    """Pull {company_slug, number, continue_request_id} out of a raw To:
    header, which may include a display name and other recipients. Returns
    None if no drafting alias is present."""
    if not to_header:
        return None
    m = _ALIAS_RE.search(to_header)
    if not m:
        return None
    company_slug, number, continue_id = m.groups()
    return {
        "company_slug": company_slug.lower(),
        "number": number.lower(),
        "continue_request_id": int(continue_id) if continue_id else None,
    }


# ---------------------------------------------------------------------------
# Outbound mail (SendGrid)
# ---------------------------------------------------------------------------

def send_email(
    to_address: str,
    subject: str,
    text_body: str,
    reply_to: Optional[str] = None,
    attachments: Optional[list] = None,
) -> None:
    """attachments: list of {"filename": str, "content_bytes": bytes,
    "mime_type": str}. Raises RuntimeError if SENDGRID_API_KEY isn't set,
    so callers can tell "not configured" apart from a real send failure."""
    if not SENDGRID_API_KEY:
        raise RuntimeError("SENDGRID_API_KEY is not configured.")

    payload = {
        "personalizations": [{"to": [{"email": to_address}]}],
        "from": {"email": SENDGRID_FROM_EMAIL, "name": SENDGRID_FROM_NAME},
        "subject": subject,
        "content": [{"type": "text/plain", "value": text_body}],
    }
    if reply_to:
        payload["reply_to"] = {"email": reply_to}
    if attachments:
        payload["attachments"] = [
            {
                "filename": a["filename"],
                "type": a.get("mime_type", "application/octet-stream"),
                "content": base64.b64encode(a["content_bytes"]).decode("ascii"),
                "disposition": "attachment",
            }
            for a in attachments
        ]

    resp = httpx.post(
        "https://api.sendgrid.com/v3/mail/send",
        json=payload,
        headers={"Authorization": f"Bearer {SENDGRID_API_KEY}"},
        timeout=20,
    )
    resp.raise_for_status()


# ---------------------------------------------------------------------------
# Template matching (deterministic, no AI -- a keyword in the subject line)
# ---------------------------------------------------------------------------

def match_template_from_subject(subject: str, templates: list) -> Optional[dict]:
    """templates: list of {"id", "name", "document_type", ...}. Matches if
    the template's name or document type appears in the subject line
    (case-insensitive). When more than one matches, the longest/most
    specific name wins, so "Freelance Services Agreement" beats a generic
    "Services Agreement" template if both happen to match."""
    subj = (subject or "").lower()
    candidates = [
        t for t in templates
        if (t["name"] and t["name"].lower() in subj) or (t["document_type"] and t["document_type"].lower() in subj)
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda t: len(t["name"] or ""), reverse=True)
    return candidates[0]


# ---------------------------------------------------------------------------
# Field value extraction (AI -- reads the free-form email body)
# ---------------------------------------------------------------------------

def extract_field_values(body_text: str, placeholders: list) -> dict:
    """placeholders: list of {"field_key", "label", "field_type"}. Returns
    {field_key: value} for whatever the model found explicit, confident
    support for in the email; fields not mentioned are simply left out
    rather than guessed at. Raises RuntimeError if ANTHROPIC_API_KEY isn't
    configured."""
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured.")
    from anthropic import Anthropic

    client = Anthropic(api_key=ANTHROPIC_API_KEY)
    valid_keys = {p["field_key"] for p in placeholders}
    fields_desc = "\n".join(f"- {p['field_key']} ({p['label']}, type={p['field_type']})" for p in placeholders)

    tool = {
        "name": "record_values",
        "description": "Record the field values found in the email.",
        "input_schema": {
            "type": "object",
            "properties": {
                "values": {
                    "type": "object",
                    "description": "field_key -> extracted value. Only include a field if the email explicitly gives you enough to fill it in confidently.",
                }
            },
            "required": ["values"],
        },
    }
    message = client.messages.create(
        model=EMAIL_AGENT_MODEL,
        max_tokens=1024,
        tools=[tool],
        tool_choice={"type": "tool", "name": "record_values"},
        messages=[
            {
                "role": "user",
                "content": (
                    "This is an email asking for a contract to be drafted. Extract values for the fields "
                    "below using only information explicitly present in the email. Never guess or invent a "
                    "value, and leave a field out entirely if the email doesn't cover it.\n\n"
                    f"Fields:\n{fields_desc}\n\nEmail:\n{body_text}"
                ),
            }
        ],
    )
    for block in message.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "record_values":
            values = block.input.get("values", {}) or {}
            return {k: str(v) for k, v in values.items() if k in valid_keys and str(v).strip()}
    return {}


def compute_missing_required(placeholders: list, values: dict) -> list:
    """placeholders: list of {"field_key", "required"}. Returns field_keys
    that are required but still have no value."""
    return [p["field_key"] for p in placeholders if p.get("required") and not (values.get(p["field_key"]) or "").strip()]
