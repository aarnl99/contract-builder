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
from html.parser import HTMLParser
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
# Outbound mail (Resend if RESEND_API_KEY is set, otherwise SendGrid)
# ---------------------------------------------------------------------------

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
# Resend only sends from a domain verified in its dashboard. EMAIL_FROM wins
# over the older SendGrid variable so switching providers is one env var.
EMAIL_FROM = os.environ.get("EMAIL_FROM", "")


def _from_address() -> str:
    return EMAIL_FROM or SENDGRID_FROM_EMAIL


def email_provider() -> str:
    """Which provider send_email will use right now: "resend", "sendgrid" or "" (none)."""
    if RESEND_API_KEY:
        return "resend"
    if SENDGRID_API_KEY:
        return "sendgrid"
    return ""


def send_email(
    to_address: str,
    subject: str,
    text_body: str,
    reply_to: Optional[str] = None,
    attachments: Optional[list] = None,
) -> None:
    """attachments: list of {"filename": str, "content_bytes": bytes,
    "mime_type": str}. Raises RuntimeError if no provider key is set, so
    callers can tell "not configured" apart from a real send failure (which
    raises httpx.HTTPError)."""
    # ".invalid" is reserved and can never receive mail. The sample document's
    # fake client uses one (see main.SAMPLE_CLIENT_EMAIL), so nothing the
    # sample does can ever email a real address.
    if to_address.strip().lower().endswith(".invalid"):
        return
    provider = email_provider()
    if not provider:
        raise RuntimeError("No email provider is configured (set RESEND_API_KEY or SENDGRID_API_KEY).")
    if provider == "resend":
        return _send_via_resend(to_address, subject, text_body, reply_to, attachments)
    return _send_via_sendgrid(to_address, subject, text_body, reply_to, attachments)


def _send_via_resend(to_address, subject, text_body, reply_to, attachments) -> None:
    payload = {
        "from": f"{SENDGRID_FROM_NAME} <{_from_address()}>",
        "to": [to_address],
        "subject": subject,
        "text": text_body,
    }
    if reply_to:
        payload["reply_to"] = reply_to
    if attachments:
        payload["attachments"] = [
            {"filename": a["filename"], "content": base64.b64encode(a["content_bytes"]).decode("ascii")}
            for a in attachments
        ]
    resp = httpx.post(
        "https://api.resend.com/emails",
        json=payload,
        headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
        timeout=20,
    )
    resp.raise_for_status()


# ---------------------------------------------------------------------------
# Inbound mail from Resend ("email.received" webhooks)
# ---------------------------------------------------------------------------

# The signing secret Resend shows on the webhook's page (starts "whsec_").
# When set, every inbound Resend webhook must carry a valid signature.
RESEND_WEBHOOK_SECRET = os.environ.get("RESEND_WEBHOOK_SECRET", "")


def verify_resend_signature(secret: str, svix_id: str, svix_timestamp: str, svix_signature: str,
                            body: bytes, tolerance_seconds: int = 300, now: Optional[float] = None) -> bool:
    """Resend signs webhooks with Svix: HMAC-SHA256 over "{id}.{timestamp}.{body}"
    keyed by the base64 part of the signing secret, sent base64-encoded as
    "v1,<sig>" (several, space-separated, while a secret is being rotated).
    Rejects stale timestamps so a captured request can't be replayed later."""
    import hashlib
    import hmac
    import time
    if not (secret and svix_id and svix_timestamp and svix_signature):
        return False
    try:
        ts = int(svix_timestamp)
        key = base64.b64decode(secret.split("_", 1)[1] if secret.startswith("whsec_") else secret)
    except (ValueError, TypeError, OverflowError):
        return False
    if not key:  # a mistyped secret that decodes to nothing must never validate anything
        return False
    try:
        if abs((now if now is not None else time.time()) - ts) > tolerance_seconds:
            return False
    except OverflowError:
        return False
    signed = f"{svix_id}.{svix_timestamp}.".encode() + body
    expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
    for part in svix_signature.split():
        version, _, sig = part.partition(",")
        if version == "v1" and hmac.compare_digest(sig.encode("utf-8", "replace"), expected.encode()):
            return True
    return False


def fetch_received_email(email_id: str) -> dict:
    """The webhook only carries metadata; the body has to be fetched. Needs
    an API key with full access (a send-only key can't read received mail)."""
    if not RESEND_API_KEY:
        raise RuntimeError("RESEND_API_KEY is not set, so received email can't be read.")
    if not email_id:
        raise RuntimeError("The webhook didn't say which email to read.")
    from urllib.parse import quote
    resp = httpx.get(
        f"https://api.resend.com/emails/receiving/{quote(str(email_id), safe='')}",
        headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def sender_is_authenticated(authentication) -> bool:
    """Whether the receiving server vouches that the email really came from
    the address in its From line. Resend reports spf/dkim/dmarc as "pass",
    "fail", "gray", ...; only DMARC passing counts, because DMARC is the check
    that ties the result to the domain in the From line (a DKIM pass alone can
    be for some other domain the sender controls). Missing or unclear results
    count as NOT authenticated."""
    if not isinstance(authentication, dict):
        return False
    return str(authentication.get("dmarc", "")).lower() == "pass"


_SIGN_OFFS = re.compile(r"^(thanks|thank you|best|regards|kind regards|cheers|sincerely|sent from)\b", re.IGNORECASE)
# Starts only where an address begins, so a long run of address characters is
# scanned once instead of once per character (keeps a hostile email cheap).
_ANY_EMAIL = re.compile(r"(?<![\w.+\-])[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+")
# Domains that are examples or placeholders, never a real client (our own
# emails use tiffany@example.com as the sample to follow). A domain matches
# when it is one of these or a subdomain of one.
_PLACEHOLDER_DOMAINS = ("example.com", "example.org", "example.net", "test", "invalid", "example")
MAX_REPLY_CHARS = 20000  # replies are short; anything past this is not the answer


def _is_placeholder_address(address: str) -> bool:
    domain = address.lower().rsplit("@", 1)[-1]
    return any(domain == d or domain.endswith("." + d) for d in _PLACEHOLDER_DOMAINS)


def strip_quoted_reply(text: str) -> str:
    """Just what the person typed: drops quoted lines (> ...) and everything
    from "On <date>, <someone> wrote:" or "-- Forwarded message --" onwards."""
    lines = (text or "").splitlines()
    out = []
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith(">"):
            continue
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if re.match(r"(?i)^on .+", s) and ("wrote:" in s.lower() or "wrote:" in nxt.lower()):
            break
        if re.match(r"(?i)^-{2,}\s*(original|forwarded) message", s) or re.match(r"^_{5,}$", s):
            break
        if re.match(r"(?i)^from:\s.*[@<]", s):  # Outlook-style quoted header block
            break
        out.append(line)
    return "\n".join(out).strip()


def _clean_name_part(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip(" .,;:-")
    return value.title() if value and value == value.lower() else value


# A name word: letters in any language, with hyphens or apostrophes inside
# (Mary-Jane, O'Brien, Renee, Garcia, Zoe), optionally ending in a full stop.
_NAME_WORD = re.compile(r"[^\W\d_]+(?:['\u2019\-][^\W\d_]+)*\.?")
_TITLES = {"dr", "mr", "mrs", "ms", "mx", "prof", "professor", "sir", "madam"}
_TRAILING_WORDS = {"at", "on", "is", "email", "e-mail", "address", "mail"}
_GREETING = re.compile(r"^\s*(hi|hello|hey|dear|thanks|thank you|good (?:morning|afternoon|evening))\b", re.IGNORECASE)
_LEAD_IN = re.compile(
    r"^\s*(?:please\s+)?(?:(?:can|could)\s+you\s+)?"
    r"(?:send(?:\s+(?:it|this))?(?:\s+to)?|share(?:\s+it)?(?:\s+with)?|the\s+client(?:'s)?(?:\s+name)?\s+is|"
    r"client(?:\s+name)?|name|to|for|contact)\b\s*[:\-]?\s*",
    re.IGNORECASE)


def _name_words(segment: str) -> list:
    """The words of a segment if it reads as a plain person's name, else []."""
    seg = segment.strip()
    for _ in range(3):  # "please send it to ..." may stack lead-ins
        stripped = _LEAD_IN.sub("", seg, count=1)
        if stripped == seg:
            break
        seg = stripped
    words = seg.split()
    while words and words[0].lower().rstrip(".") in _TITLES:
        words = words[1:]
    while words and words[-1].lower() in _TRAILING_WORDS:
        words = words[:-1]
    if 2 <= len(words) <= 4 and all(_NAME_WORD.fullmatch(w) for w in words):
        return words
    return []


def _name_from_line(line: str, email: str = "") -> tuple:
    """First and last name from one line such as "Tiffany Xia, tiffany@virio.ai",
    "Tiffany Xia <tiffany@virio.ai>" or "send it to Dr. Tiffany Xia at ...". Text
    in brackets (a job title) is ignored; the first comma-separated piece that
    looks like a name wins, so "Tiffany Xia, Acme Corp, t@acme.com" is Tiffany Xia."""
    cand = re.sub(re.escape(email), " ", line, flags=re.IGNORECASE) if email else line
    cand = re.sub(r"\([^)]*\)", " ", cand)
    for segment in re.split(r"[,;|<>]|\s[-\u2013\u2014]\s", cand):
        words = _name_words(segment)
        if words:
            return _clean_name_part(words[0]), _clean_name_part(" ".join(words[1:]))
    return "", ""


def _labelled_name(text: str) -> tuple:
    fm = re.search(r"first\s*name\s*[:=\-]\s*(.+?)(?=\s+last\s*name\b|[\n,;]|$)", text, re.IGNORECASE)
    lm = re.search(r"last\s*name\s*[:=\-]\s*([^\n,;]+)", text, re.IGNORECASE)
    if not (fm and lm):
        return "", ""
    first, last = fm.group(1).strip(), lm.group(1).strip()
    if all(_NAME_WORD.fullmatch(w) for w in (first.split() + last.split())) and 1 <= len(first.split()) <= 2 and 1 <= len(last.split()) <= 3:
        return _clean_name_part(first), _clean_name_part(last)
    return "", ""


def parse_recipient(text: str, exclude=()) -> dict:
    """Reads a client's first name, last name and email out of a short reply
    like "Tiffany Xia, tiffany@virio.ai" or labelled lines ("First name: ...").
    Deliberately plain text rules, not an AI: the email body can come from
    anywhere, and a wrong guess here would send a contract to the wrong
    person. The name has to be on the same line as the address or on the line
    just above it (never below, where a signature lives), and greeting lines
    never count. Anything not clearly there comes back blank so the caller asks."""
    skip = {e.lower() for e in exclude}
    body = []
    for line in (text or "")[:MAX_REPLY_CHARS].splitlines():
        if _SIGN_OFFS.match(line.strip()):
            break
        body.append(line)
    text = "\n".join(body)
    emails = [e for e in _ANY_EMAIL.findall(text)
              if e.lower() not in skip and not e.lower().endswith("@" + EMAIL_DOMAIN.lower())
              and not _is_placeholder_address(e)]
    email = emails[0] if emails else ""
    first, last = _labelled_name(text)
    if not (first and last):
        first = last = ""
        lines = text.splitlines()
        idx = next((i for i, l in enumerate(lines) if email and email.lower() in l.lower()), None)
        if idx is not None:
            first, last = _name_from_line(lines[idx], email)
            j = idx - 1  # name on the line just above the email
            if not (first and last) and j >= 0 and lines[j].strip() and not _ANY_EMAIL.search(lines[j]) \
                    and not _GREETING.match(lines[j]):
                first, last = _name_from_line(lines[j])
    return {"first_name": first, "last_name": last, "email": email}


class _TextExtractor(HTMLParser):
    """Visible text of an email, skipping scripts, styles and quoted replies
    (blockquote, nested ones included). One pass over the input, so a hostile
    pile of unclosed tags costs time in proportion to its size, not its square."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._skip = 0
        self._quote = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1
        elif tag == "blockquote":
            self._quote += 1
        elif tag == "br":
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._skip = max(0, self._skip - 1)
        elif tag == "blockquote":
            self._quote = max(0, self._quote - 1)
        elif tag in ("p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip and not self._quote:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    """Plain text from an HTML-only email, good enough to read field values from."""
    parser = _TextExtractor()
    try:
        parser.feed((html or "")[:200000])
        parser.close()
    except Exception:  # malformed markup: use whatever was read so far
        pass
    text = "".join(parser.parts)
    text = re.sub(r"[ \t\xa0]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def _send_via_sendgrid(to_address, subject, text_body, reply_to, attachments) -> None:
    payload = {
        "personalizations": [{"to": [{"email": to_address}]}],
        "from": {"email": _from_address(), "name": SENDGRID_FROM_NAME},
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
        # Newer models reject a forced tool choice, so ask for the tool in the prompt.
        tool_choice={"type": "auto"},
        messages=[
            {
                "role": "user",
                "content": (
                    "This is an email asking for a contract to be drafted. Extract values for the fields "
                    "below using only information explicitly present in the email. Never guess or invent a "
                    "value, and leave a field out entirely if the email doesn't cover it.\n\n"
                    f"Fields:\n{fields_desc}\n\nEmail:\n{body_text}\n\n"
                    "Answer only by calling the record_values tool."
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
