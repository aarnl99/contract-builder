"""
DocuSeal e-signature integration.

Responsibilities:
  1. Send a finished, redline-settled .docx out for signature as a one-off
     DocuSeal submission (POST /submissions/docx) -- no persistent DocuSeal
     "template" object is created or reused; every signature request is its
     own standalone submission, matching how GeneratedContract rows already
     work (each one is its own row, never overwritten).
  2. Verify DocuSeal's webhook HMAC signature, so main.py's webhook route
     can trust a payload actually came from DocuSeal before acting on it.
  3. Fetch submission status and download the final signed document(s) once
     complete.

None of this touches the database -- main.py owns that -- so it can be unit
tested without a live DocuSeal account. Functions that call the API raise a
plain RuntimeError if DOCUSEAL_API_KEY isn't configured, matching
email_engine.py's convention for SENDGRID_API_KEY, and otherwise let
httpx.HTTPStatusError propagate on a non-2xx response (e.g. a free-tier
account hitting this Pro-only endpoint) -- callers need to know a signature
request was never actually created, not have that silently swallowed.

DocuSeal's own signing-request emails are always disabled (send_email=False,
both at the submission level and per-submitter) -- main.py sends its own
branded email with a link to Rotely's own consent/photo-capture page first
(see /sign/{token} in main.py), and only reveals the actual DocuSeal signing
form after that consent step. See the e-signature design notes (bug tracker
/ roadmap docs) for why: a bare photo isn't identity verification, it's a
deterrent/record, and DocuSeal itself never needs to know it happened.
"""
import base64
import hashlib
import hmac
import os
import time
from typing import Dict, List, Optional

import httpx

DOCUSEAL_API_KEY = os.environ.get("DOCUSEAL_API_KEY", "")
DOCUSEAL_BASE_URL = os.environ.get("DOCUSEAL_BASE_URL", "https://api.docuseal.com").rstrip("/")
DOCUSEAL_WEBHOOK_SECRET = os.environ.get("DOCUSEAL_WEBHOOK_SECRET", "")

_TIMEOUT = 30


def _headers() -> dict:
    if not DOCUSEAL_API_KEY:
        raise RuntimeError("DOCUSEAL_API_KEY is not configured.")
    return {"X-Auth-Token": DOCUSEAL_API_KEY, "Content-Type": "application/json"}


def create_submission_from_docx(
    *, name: str, file_bytes: bytes, file_name: str, submitters: List[Dict],
    variables: Optional[Dict] = None,
) -> dict:
    """submitters: list of {"role", "email", "name", "external_id"}.
    `order` is left at DocuSeal's default ("preserved"), so a second signer
    only gets access once the first has completed -- the normal shape for a
    two-party contract. Returns the parsed JSON submission response (a list
    of per-submitter records, each with its own "slug"/"embed_src")."""
    payload = {
        "name": name,
        "send_email": False,
        "documents": [{"name": file_name, "file": base64.b64encode(file_bytes).decode("ascii")}],
        "submitters": [
            {
                "role": s["role"],
                "email": s["email"],
                "name": s.get("name", ""),
                "send_email": False,
                "external_id": s.get("external_id", ""),
            }
            for s in submitters
        ],
    }
    if variables:
        payload["variables"] = variables
    resp = httpx.post(f"{DOCUSEAL_BASE_URL}/submissions/docx", json=payload, headers=_headers(), timeout=_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def get_submission(submission_id: int) -> dict:
    resp = httpx.get(f"{DOCUSEAL_BASE_URL}/submissions/{submission_id}", headers=_headers(), timeout=_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def get_submission_documents(submission_id: int) -> dict:
    """Document URLs returned here expire ~40 minutes after being issued
    (a DocuSeal platform limit, not ours) -- callers must download the
    bytes immediately and never persist the URL itself. See main.py's
    DocuSeal webhook handler, which calls this and downloads the signed
    file into Rotely's own uploads dir the moment a submission completes."""
    resp = httpx.get(f"{DOCUSEAL_BASE_URL}/submissions/{submission_id}/documents", headers=_headers(), timeout=_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def archive_submission(submission_id: int) -> dict:
    resp = httpx.delete(f"{DOCUSEAL_BASE_URL}/submissions/{submission_id}", headers=_headers(), timeout=_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def download_document(url: str) -> bytes:
    """Downloads a (short-lived) signed-document URL returned by
    get_submission_documents. Deliberately not sent with the
    DOCUSEAL_API_KEY header -- these URLs are themselves the credential,
    same as the ones DocuSeal includes directly in its webhook payloads."""
    resp = httpx.get(url, timeout=_TIMEOUT)
    resp.raise_for_status()
    return resp.content


def verify_webhook_signature(raw_body: bytes, signature_header: str, secret: str, tolerance_seconds: int = 300) -> bool:
    """Verifies DocuSeal's `X-Docuseal-Signature: {timestamp}.{signature}`
    HMAC-SHA256 header against the raw request body -- see
    https://www.docuseal.com/docs/webhooks#how-to-verify-webhooks-with-hmac-signatures.
    Must be called with the exact raw bytes received on the wire; a
    re-serialized JSON object will not match even if semantically
    identical to what DocuSeal sent. Returns False (never raises) for a
    missing/malformed header, an expired timestamp, or a wrong secret, so
    main.py's webhook route can treat any False the same way: reject with
    401 and do nothing else."""
    if not secret or not signature_header or "." not in signature_header:
        return False
    timestamp_str, _, signature = signature_header.partition(".")
    try:
        timestamp = int(timestamp_str)
    except ValueError:
        return False
    if abs(time.time() - timestamp) > tolerance_seconds:
        return False
    expected = hmac.new(
        secret.encode("utf-8"), f"{timestamp_str}.".encode("utf-8") + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
