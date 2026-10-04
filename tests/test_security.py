"""
Regression tests for the QA security findings (Oct 2026 round):
  - Host-header reset-link poisoning        (main._base_url)
  - no login / forgot-password rate limit   (main.login, main.forgot_password, rate_limit)
  - guessable 6-digit email alias           (email_engine)
  - zip-bomb .docx upload gap               (docx_engine.validate_docx_archive)
  - stored XSS via innerHTML in app.js      (static check; see test at bottom)

DATA_DIR must point at a temp dir before app.db is first imported (it builds
its sqlite engine at import time), so this never touches a real database.

Run with:  venv/bin/pytest tests/
"""
import io
import os
import sys
import tempfile
import uuid
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

if "app.db" not in sys.modules:
    os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="rotely_test_security_")

import pytest  # noqa: E402
from starlette.requests import Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import Session  # noqa: E402

from app import main as m  # noqa: E402
from app import email_engine as ee  # noqa: E402
from app import docx_engine as de  # noqa: E402
from app import rate_limit as rl  # noqa: E402
from app.auth import hash_password  # noqa: E402
from app.db import engine, init_db  # noqa: E402
from app.models import User  # noqa: E402

init_db()


@pytest.fixture(autouse=True)
def _fresh_limits():
    rl.reset_all()
    yield
    rl.reset_all()


def _req(host: str, scheme: str = "https") -> Request:
    return Request({
        "type": "http", "scheme": scheme, "method": "POST", "path": "/", "query_string": b"",
        "server": (host, 443), "headers": [(b"host", host.encode())],
    })


def _make_user(password="correct-horse-battery", verified=True) -> User:
    with Session(engine) as s:
        u = User(
            email=f"sec-{uuid.uuid4().hex}@example.com", password_hash=hash_password(password),
            email_verified=verified,
        )
        s.add(u)
        s.commit()
        s.refresh(u)
        return u


# ---------------------------------------------------------------- Host header

def test_base_url_ignores_attacker_host_header():
    assert m._base_url(_req("evil.example")) == m._canonical_base_url()
    assert m._base_url(_req("evil.example:8443")) == m._canonical_base_url()


def test_base_url_keeps_legitimate_hosts():
    canon_host = m._canonical_base_url().split("://", 1)[1]
    assert m._base_url(_req(canon_host)) == f"https://{canon_host}"
    assert m._base_url(_req("localhost", "http")) == "http://localhost"


def test_reset_email_link_not_poisoned_by_host_header(monkeypatch):
    user = _make_user()
    sent = []
    monkeypatch.setattr(m.ee, "send_email", lambda to, subj, body, **kw: sent.append((to, body)))
    with TestClient(m.app) as c:
        r = c.post("/api/forgot-password", json={"email": user.email}, headers={"Host": "evil.example"})
    assert r.status_code == 200
    assert sent, "reset email should have been sent"
    assert "evil.example" not in sent[0][1]
    assert m._canonical_base_url() + "/reset-password/" in sent[0][1]


# ---------------------------------------------------------------- rate limits

def test_rate_limiter_window_math():
    key = "t:" + uuid.uuid4().hex
    for _ in range(3):
        rl.record(key, 60, now=100.0)
    assert rl.retry_after(key, 3, 60, now=101.0) > 0
    assert rl.retry_after(key, 4, 60, now=101.0) == 0       # under a higher limit
    assert rl.retry_after(key, 3, 60, now=161.0) == 0       # window has slid past
    rl.clear(key)
    assert rl.retry_after(key, 3, 60, now=101.0) == 0


def test_login_locks_out_after_repeated_failures():
    user = _make_user()
    with TestClient(m.app) as c:
        for _ in range(m.LOGIN_MAX_FAILS_PER_EMAIL):
            assert c.post("/api/login", json={"email": user.email, "password": "nope"}).status_code == 401
        r = c.post("/api/login", json={"email": user.email, "password": "nope"})
        assert r.status_code == 429
        assert int(r.headers["Retry-After"]) > 0
        # Even the RIGHT password is refused while locked -- otherwise the
        # lockout wouldn't slow a guesser down at all.
        r = c.post("/api/login", json={"email": user.email, "password": "correct-horse-battery"})
        assert r.status_code == 429


def test_successful_login_resets_the_failure_count():
    user = _make_user()
    with TestClient(m.app) as c:
        for _ in range(m.LOGIN_MAX_FAILS_PER_EMAIL - 1):
            assert c.post("/api/login", json={"email": user.email, "password": "nope"}).status_code == 401
        assert c.post("/api/login", json={"email": user.email, "password": "correct-horse-battery"}).status_code == 200
        # counter cleared: another full batch of failures is allowed again
        for _ in range(m.LOGIN_MAX_FAILS_PER_EMAIL - 1):
            assert c.post("/api/login", json={"email": user.email, "password": "nope"}).status_code == 401


def test_forgot_password_is_rate_limited_per_email():
    email = f"nobody-{uuid.uuid4().hex}@example.com"
    with TestClient(m.app) as c:
        codes = [c.post("/api/forgot-password", json={"email": email}).status_code
                 for _ in range(m.FORGOT_MAX_PER_EMAIL + 2)]
    assert codes[:m.FORGOT_MAX_PER_EMAIL] == [200] * m.FORGOT_MAX_PER_EMAIL
    assert codes[-1] == 429


# ---------------------------------------------------------------- email alias

def test_new_alias_numbers_are_long_and_random():
    nums = {ee.generate_alias_number() for _ in range(50)}
    assert len(nums) == 50
    assert all(len(n) == ee.ALIAS_NUMBER_LENGTH == 12 for n in nums)


def test_alias_parser_accepts_new_and_legacy_numbers():
    new = ee.alias_address("acme", "k3j9x0q7m2ab")
    assert ee.parse_alias(f"Drafts <{new}>")["number"] == "k3j9x0q7m2ab"
    legacy = ee.alias_address("acme", "123456")
    p = ee.parse_alias(legacy)
    assert p["number"] == "123456" and p["company_slug"] == "acme"
    cont = ee.continuation_address("acme", "k3j9x0q7m2ab", 7)
    assert ee.parse_alias(cont)["continue_request_id"] == 7
    assert ee.parse_alias("drafts+acme+12@" + ee.EMAIL_DOMAIN) is None  # too short to be valid


# ---------------------------------------------------------------- zip bomb

def _zip(path, entries):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)


def test_normal_docx_passes_archive_validation(tmp_path):
    from docx import Document
    p = tmp_path / "ok.docx"
    d = Document()
    d.add_paragraph("hello")
    d.save(str(p))
    de.validate_docx_archive(str(p))  # must not raise


def test_non_zip_rejected(tmp_path):
    p = tmp_path / "x.docx"
    p.write_bytes(b"this is not a zip")
    with pytest.raises(de.UnsafeDocx):
        de.validate_docx_archive(str(p))


def test_huge_single_entry_rejected(tmp_path):
    p = tmp_path / "bomb.docx"
    _zip(str(p), {"word/document.xml": b"0" * (de.MAX_DOCX_ENTRY_UNCOMPRESSED + 1024)})
    assert os.path.getsize(p) < 200 * 1024  # tiny on disk -- sails past the upload byte cap
    with pytest.raises(de.UnsafeDocx):
        de.validate_docx_archive(str(p))


def test_extreme_compression_ratio_rejected(tmp_path):
    p = tmp_path / "ratio.docx"
    _zip(str(p), {"word/document.xml": b"0" * (8 * 1024 * 1024)})  # under the size caps, ratio ~1000
    with pytest.raises(de.UnsafeDocx):
        de.validate_docx_archive(str(p))


def test_total_uncompressed_cap_rejected(tmp_path):
    p = tmp_path / "many.docx"
    with zipfile.ZipFile(str(p), "w", zipfile.ZIP_STORED) as z:
        # stored (uncompressed) so size == compressed size: only the TOTAL cap can trigger
        for i in range(4):
            z.writestr(f"word/part{i}.bin", os.urandom(1024) * 1024 * 40)  # 40MB each = 160MB total
    with pytest.raises(de.UnsafeDocx):
        de.validate_docx_archive(str(p))


def test_upload_endpoint_rejects_zip_bomb(tmp_path):
    user = _make_user()
    bomb = io.BytesIO()
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", b"0" * (de.MAX_DOCX_ENTRY_UNCOMPRESSED + 1024))
    with TestClient(m.app) as c:
        assert c.post("/api/login", json={"email": user.email, "password": "correct-horse-battery"}).status_code == 200
        r = c.post(
            "/api/templates",
            files={"file": ("bomb.docx", bomb.getvalue(),
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
            data={"name": "bomb", "document_type": "Other"},
        )
    assert r.status_code == 400, r.text
    assert "unreasonably large" in r.json()["detail"] or "suspicious" in r.json()["detail"]


# ---------------------------------------------------------------- XSS (static guard)

def test_owner_detail_panel_never_builds_value_rows_with_innerhtml():
    # The stored-XSS chain: client redline text -> accepted values -> this
    # panel. Rows must be DOM text nodes, never an HTML string.
    js = open(os.path.join(os.path.dirname(__file__), "..", "app", "static", "app.js"), encoding="utf-8").read()
    assert "valuesHtml" not in js
    assert '${v.label}' not in js and '${v.value' not in js


def test_rate_limit_import_does_not_shadow_redline_engine():
    # main.py imports redline_engine as `rl`; the limiter must use another
    # name or every redline code path would call the wrong module.
    from app import main as m
    assert hasattr(m.rl, "evaluate_edit")
    assert hasattr(m, "ratelimit") and hasattr(m.ratelimit, "check")
