import os
import re
import json
import base64
import hashlib
import shutil
import secrets
import string
import threading
import httpx
from collections import Counter
from datetime import datetime, timedelta
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from sqlmodel import Session, select
from pydantic import BaseModel
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from .db import init_db, get_session, UPLOADS_DIR, DATA_DIR
from .models import (
    User, Template, Placeholder, GeneratedContract, GenerationEvent, PLAN_LIMITS, DEFAULT_PLAN, DOCUMENT_TYPES,
    ShareLink, ShareLinkView, RedlineSubmission, RedlineEdit, RedlineComment, EmailAlias, EmailDraftRequest, Notification,
    SigningRequest, SigningRequestSigner,
)
from .auth import hash_password, verify_password, validate_password_strength, get_current_user, get_optional_user
from . import docx_engine as de
from . import redline_engine as rl
from . import email_engine as ee
from . import docuseal_engine as ds
from . import rate_limit as ratelimit

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SECRET_KEY_PATH = os.path.join(BASE_DIR, "secret.key")


def _load_or_create_secret() -> str:
    # In production, set SESSION_SECRET_KEY as an environment variable so all
    # processes share it and sessions survive redeploys. Falls back to a
    # file on disk for local development.
    env_key = os.environ.get("SESSION_SECRET_KEY")
    if env_key:
        return env_key
    if os.path.exists(SECRET_KEY_PATH):
        return open(SECRET_KEY_PATH).read().strip()
    key = secrets.token_hex(32)
    with open(SECRET_KEY_PATH, "w") as f:
        f.write(key)
    return key


SECRET_KEY = _load_or_create_secret()
INBOUND_WEBHOOK_SECRET = os.environ.get("INBOUND_WEBHOOK_SECRET", "")
# The one account that can see /api/admin/* and the #/admin page. Not a DB
# column -- just an email compared at request time -- so promoting the
# owner never needs a migration against the already-live database.
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "aaronkluan@gmail.com").strip().lower()

# Google "Sign in with Google" -- standard server-side OAuth Authorization
# Code flow. Both of these are already set in the Render environment; the
# redirect URI registered on the Google Cloud OAuth client is
# {origin}/api/auth/google/callback, so that route path is load-bearing --
# changing it also means updating the client's Authorized redirect URIs in
# Google Cloud Console.
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")

# Rotely is invite-only during the friends-and-family beta: creating a new
# account (either path -- email/password or Google) requires this code.
# Logging into an account that already exists never requires it. Settable
# via env so it can be rotated/removed without a code change.
#
# No hardcoded fallback here on purpose: this file is a public repo, so any
# literal default string compiled in is public knowledge the moment someone
# reads the source, regardless of whether Render's own env var is ever set.
# An empty SIGNUP_ACCESS_CODE fails signup CLOSED (see
# _check_signup_access_code and the Google OAuth callback below) instead of
# silently falling open to a committed code.
SIGNUP_ACCESS_CODE = os.environ.get("SIGNUP_ACCESS_CODE", "")

app = FastAPI(title="Rotely")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, same_site="lax")

# A fresh random token each time this process starts (i.e. every deploy, since
# Render restarts the process). The SPA is a single HTML page whose JS is
# fetched once and never re-fetched until the tab is hard-refreshed -- a tab
# left open across a deploy silently keeps running the old code with no
# indication anything shipped. app.js polls /api/version and prompts a
# refresh the moment this value changes, so "why isn't my fix showing up"
# stops being a recurring support question.
APP_BOOT_ID = secrets.token_hex(8)


@app.get("/api/version")
def get_app_version():
    return {"boot_id": APP_BOOT_ID}

# Short-lived signed tokens proving a share-link visitor entered the right
# access code. Not stored server-side -- just a signed, timestamped blob the
# browser holds for the rest of that visit. max_age enforces "you re-enter
# the code on your next visit" without needing a database row per session.
SHARE_SESSION_MAX_AGE = 2 * 60 * 60  # 2 hours
_share_serializer = URLSafeTimedSerializer(SECRET_KEY, salt="share-session")


def _issue_share_session(share_link_id: int) -> str:
    return _share_serializer.dumps({"share_link_id": share_link_id})


def _verify_share_session(token: str, share_link_id: int) -> bool:
    try:
        data = _share_serializer.loads(token, max_age=SHARE_SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return False
    return data.get("share_link_id") == share_link_id


@app.on_event("startup")
def on_startup():
    init_db()


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------

class RegisterBody(BaseModel):
    email: str
    password: str
    name: str = ""
    access_code: str = ""


class LoginBody(BaseModel):
    email: str
    password: str


class ResendVerificationBody(BaseModel):
    email: str


RESEND_VERIFICATION_COOLDOWN = 60  # seconds -- keeps "resend" from being spammed


DEFAULT_PUBLIC_BASE_URL = "https://userotely.com"


def _canonical_base_url() -> str:
    return (os.environ.get("PUBLIC_BASE_URL") or DEFAULT_PUBLIC_BASE_URL).strip().rstrip("/")


def _allowed_hosts() -> set:
    """Hosts we're willing to build outbound links from: the canonical origin's
    host, plus localhost-style dev hosts, plus anything in ALLOWED_HOSTS
    (comma-separated, e.g. a staging domain)."""
    hosts = {"localhost", "127.0.0.1", "testserver", "localhost:8000", "127.0.0.1:8000"}
    canon = _canonical_base_url()
    hosts.add(canon.split("://", 1)[-1].lower())
    for h in (os.environ.get("ALLOWED_HOSTS") or "").split(","):
        h = h.strip().lower()
        if h:
            hosts.add(h)
    return hosts


def _base_url(request: Request) -> str:
    """Absolute origin for building links that go out in email (e.g. the
    verify-email link), since those are opened outside this app's own
    hash-routed pages and need a real, fully-qualified URL."""
    # Security (QA): this used to trust the request's Host header outright, so
    # anyone could POST /api/forgot-password with `Host: evil.example` and the
    # reset email -- sent to the VICTIM -- would carry a link to the attacker's
    # domain (password-reset poisoning). Now the origin is only taken from the
    # request when its host is on an allowlist; otherwise we fall back to the
    # configured canonical origin.
    host = (request.url.netloc or "").lower()
    if host in _allowed_hosts():
        return f"{request.url.scheme}://{request.url.netloc}"
    return _canonical_base_url()


def _send_verification_email(request: Request, user: User) -> None:
    link = f"{_base_url(request)}/verify-email/{user.verification_token}"
    body = (
        f"Hi{' ' + user.name if user.name else ''},\n\n"
        "Please confirm your email address to finish setting up your Rotely account:\n\n"
        f"{link}\n\n"
        "If you didn't create this account, you can ignore this email.\n\n"
        "- Rotely"
    )
    try:
        ee.send_email(user.email, "Confirm your email for Rotely", body)
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured yet -- account still exists, just no email goes out


def _check_signup_access_code(code: str) -> None:
    """Bug tracker #54: SIGNUP_ACCESS_CODE used to fall back to a hardcoded
    default ("userotelynow") when the env var wasn't set -- since this repo
    is public, that default was public knowledge regardless of whether
    Render's own env var was ever configured, making the invite gate no
    gate at all. Fails closed instead: a missing SIGNUP_ACCESS_CODE blocks
    every signup (a distinct, honest 503) rather than silently accepting a
    code anyone could read in the source."""
    if not SIGNUP_ACCESS_CODE:
        raise HTTPException(503, "Invite signups aren't configured yet. Contact the Rotely team.")
    if code.strip().lower() != SIGNUP_ACCESS_CODE.lower():
        raise HTTPException(400, "That access code isn't valid. Double-check it and try again.")


@app.post("/api/register")
def register(body: RegisterBody, request: Request, session: Session = Depends(get_session)):
    _check_signup_access_code(body.access_code)
    email = body.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "Please provide a valid email address")
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Please provide your full name")
    password_error = validate_password_strength(body.password)
    if password_error:
        raise HTTPException(400, password_error)
    existing = session.exec(select(User).where(User.email == email)).first()
    if existing:
        raise HTTPException(400, "An account with that email already exists")

    user = User(
        email=email, password_hash=hash_password(body.password), name=name,
        email_verified=False, verification_token=secrets.token_urlsafe(32),
        verification_sent_at=datetime.utcnow(),
    )
    session.add(user)
    session.commit()
    session.refresh(user)

    _send_verification_email(request, user)
    # Deliberately NOT logging them in here -- email_verified is False, so
    # even if a client tried to use a returned session it wouldn't help;
    # login stays blocked until they click the link.
    return {"registered": True, "email": user.email}


LOGIN_WINDOW = 15 * 60       # seconds
LOGIN_MAX_FAILS_PER_EMAIL = 8   # per account, from anywhere
LOGIN_MAX_FAILS_PER_IP = 30     # per client IP, across accounts
FORGOT_MAX_PER_IP = 10
FORGOT_MAX_PER_EMAIL = 5


def _client_ip(request: Request) -> str:
    """Best-effort client IP behind Render's proxy: the right-most
    X-Forwarded-For entry is the one the platform's own proxy appended (the
    left side is client-controlled and spoofable)."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        last = xff.split(",")[-1].strip()
        if last:
            return last
    return request.client.host if request.client else "unknown"


def _too_many(retry_after_s: int):
    return HTTPException(
        429, "Too many attempts. Please wait a few minutes and try again.",
        headers={"Retry-After": str(retry_after_s)},
    )


@app.post("/api/login")
def login(body: LoginBody, request: Request, session: Session = Depends(get_session)):
    email = body.email.strip().lower()
    ip = _client_ip(request)
    # Security (QA): there was no brake on password guessing at all. Failed
    # attempts are counted per account AND per IP; a success clears the
    # account counter so a real user who finally types it right isn't penalised.
    wait = ratelimit.check([
        (f"login:email:{email}", LOGIN_MAX_FAILS_PER_EMAIL, LOGIN_WINDOW),
        (f"login:ip:{ip}", LOGIN_MAX_FAILS_PER_IP, LOGIN_WINDOW),
    ])
    if wait:
        raise _too_many(wait)
    user = session.exec(select(User).where(User.email == email)).first()
    if not user or not verify_password(body.password, user.password_hash):
        ratelimit.record(f"login:email:{email}", LOGIN_WINDOW)
        ratelimit.record(f"login:ip:{ip}", LOGIN_WINDOW)
        raise HTTPException(401, "Invalid email or password")
    ratelimit.clear(f"login:email:{email}")
    if not user.email_verified:
        raise HTTPException(403, {"code": "email_not_verified", "message": "Please verify your email before logging in."})
    if user.is_suspended:
        raise HTTPException(403, {"code": "account_suspended", "message": "This account has been suspended. Contact support if you think this is a mistake."})
    request.session["user_id"] = user.id
    return {"id": user.id, "email": user.email, "name": user.name}


@app.get("/verify-email/{token}")
def verify_email(token: str, session: Session = Depends(get_session)):
    """Real (non-hash) route since this link is opened from an email client,
    not from within the app. Redirects back into the SPA either way so the
    person always lands somewhere that explains what happened."""
    user = session.exec(select(User).where(User.verification_token == token, User.verification_token != "")).first()
    if not user:
        return RedirectResponse(url="/#/login?verify_error=1")
    user.email_verified = True
    user.verification_token = ""
    session.add(user)
    session.commit()
    return RedirectResponse(url="/#/login?verified=1")


RESET_TOKEN_MAX_AGE = 60 * 60  # 1 hour -- a reset link stops working after this
RESET_REQUEST_COOLDOWN = 60  # seconds -- keeps "forgot password" from being spammed, same as resend-verification


@app.get("/reset-password/{token}")
def reset_password_link(token: str, session: Session = Depends(get_session)):
    """Real (non-hash) route opened from the reset email, same reasoning as
    /verify-email above. Doesn't consume the token -- just checks it's still
    valid and hands off into the SPA's set-new-password screen, which is
    what actually spends it via POST /api/reset-password."""
    user = session.exec(select(User).where(User.reset_token == token, User.reset_token != "")).first()
    valid = bool(user and user.reset_sent_at and (datetime.utcnow() - user.reset_sent_at).total_seconds() < RESET_TOKEN_MAX_AGE)
    if not valid:
        return RedirectResponse(url="/#/login?reset_error=1")
    return RedirectResponse(url=f"/#/reset-password?token={token}")


@app.post("/api/resend-verification")
def resend_verification(body: ResendVerificationBody, request: Request, session: Session = Depends(get_session)):
    email = body.email.strip().lower()
    user = session.exec(select(User).where(User.email == email)).first()
    # Always return the same generic response whether or not the account
    # exists or is already verified, so this endpoint can't be used to probe
    # which emails have accounts.
    if user and not user.email_verified:
        if not user.verification_sent_at or (datetime.utcnow() - user.verification_sent_at).total_seconds() >= RESEND_VERIFICATION_COOLDOWN:
            user.verification_token = user.verification_token or secrets.token_urlsafe(32)
            user.verification_sent_at = datetime.utcnow()
            session.add(user)
            session.commit()
            _send_verification_email(request, user)
    return {"ok": True}


class ForgotPasswordBody(BaseModel):
    email: str


def _send_reset_email(request: Request, user: User) -> None:
    link = f"{_base_url(request)}/reset-password/{user.reset_token}"
    body = (
        f"Hi{' ' + user.name if user.name else ''},\n\n"
        "Someone (hopefully you) asked to reset the password on your Rotely account. "
        f"This link works for the next hour:\n\n{link}\n\n"
        "If you didn't request this, you can safely ignore this email -- your password hasn't changed.\n\n"
        "- Rotely"
    )
    try:
        ee.send_email(user.email, "Reset your Rotely password", body)
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured yet -- the token still works if they already have the link some other way


@app.post("/api/forgot-password")
def forgot_password(body: ForgotPasswordBody, request: Request, session: Session = Depends(get_session)):
    email = body.email.strip().lower()
    ip = _client_ip(request)
    # Security (QA): every request counts (not just failures) -- this endpoint
    # sends email, so it's both a spam cannon and an enumeration surface.
    wait = ratelimit.check([
        (f"forgot:email:{email}", FORGOT_MAX_PER_EMAIL, LOGIN_WINDOW),
        (f"forgot:ip:{ip}", FORGOT_MAX_PER_IP, LOGIN_WINDOW),
    ])
    if wait:
        raise _too_many(wait)
    ratelimit.record(f"forgot:email:{email}", LOGIN_WINDOW)
    ratelimit.record(f"forgot:ip:{ip}", LOGIN_WINDOW)
    user = session.exec(select(User).where(User.email == email)).first()
    # Same generic response either way, whether or not the account exists --
    # this endpoint must not be usable to probe which emails have accounts.
    if user:
        if not user.reset_sent_at or (datetime.utcnow() - user.reset_sent_at).total_seconds() >= RESET_REQUEST_COOLDOWN:
            user.reset_token = secrets.token_urlsafe(32)
            user.reset_sent_at = datetime.utcnow()
            session.add(user)
            session.commit()
            _send_reset_email(request, user)
    return {"ok": True}


class ResetPasswordBody(BaseModel):
    token: str
    password: str


@app.post("/api/reset-password")
def reset_password(body: ResetPasswordBody, request: Request, session: Session = Depends(get_session)):
    user = session.exec(select(User).where(User.reset_token == body.token, User.reset_token != "")).first()
    if not user or not user.reset_sent_at or (datetime.utcnow() - user.reset_sent_at).total_seconds() >= RESET_TOKEN_MAX_AGE:
        raise HTTPException(400, "That reset link is invalid or has expired. Request a new one.")
    password_error = validate_password_strength(body.password)
    if password_error:
        raise HTTPException(400, password_error)

    user.password_hash = hash_password(body.password)
    user.reset_token = ""
    user.reset_sent_at = None
    # A password reset is also good proof of email ownership -- verify and
    # lift any suspension hold isn't implied by this, but an unverified
    # account that successfully resets its password can log in from here on.
    user.email_verified = True
    session.add(user)
    session.commit()

    if not user.is_suspended:
        request.session["user_id"] = user.id
    return {"ok": True, "logged_in": not user.is_suspended}


@app.get("/api/auth/google/start")
def google_auth_start(request: Request, access_code: str = ""):
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(503, "Google sign-in isn't configured on this deploy.")
    state = secrets.token_urlsafe(24)
    request.session["google_oauth_state"] = state
    # Stashed for the callback, which is the only place we know whether this
    # sign-in is creating a brand-new account (see google_auth_callback) --
    # an existing account signing back in never needs this.
    request.session["google_oauth_access_code"] = access_code.strip()
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": f"{_base_url(request)}/api/auth/google/callback",
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    }
    url = f"https://accounts.google.com/o/oauth2/v2/auth?{httpx.QueryParams(params)}"
    return RedirectResponse(url=url)


@app.get("/api/auth/google/callback")
def google_auth_callback(request: Request, code: str = "", state: str = "", error: str = "", session: Session = Depends(get_session)):
    """Standard OAuth Authorization Code exchange: trade the one-time code
    for tokens, fetch the person's Google profile, then log them in --
    creating an account on the fly if this is their first time, matched by
    email against any existing password-based account so the two sign-in
    paths converge on one account rather than silently creating a
    duplicate."""
    expected_state = request.session.pop("google_oauth_state", None)
    if error or not code or not state or state != expected_state:
        return RedirectResponse(url="/#/login?google_error=1")
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        return RedirectResponse(url="/#/login?google_error=1")

    try:
        token_res = httpx.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": f"{_base_url(request)}/api/auth/google/callback",
                "grant_type": "authorization_code",
            },
            timeout=10,
        )
        token_res.raise_for_status()
        access_token = token_res.json()["access_token"]

        profile_res = httpx.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        profile_res.raise_for_status()
        profile = profile_res.json()
    except (httpx.HTTPError, KeyError):
        return RedirectResponse(url="/#/login?google_error=1")

    email = (profile.get("email") or "").strip().lower()
    if not email or not profile.get("verified_email", True):
        return RedirectResponse(url="/#/login?google_error=1")
    google_sub = profile.get("id", "")
    name = profile.get("name", "") or email.split("@")[0]

    user = session.exec(select(User).where(User.email == email)).first()
    pending_access_code = request.session.pop("google_oauth_access_code", "")
    if not user:
        # Bug tracker #54: same fail-closed fix as _check_signup_access_code
        # -- an unset SIGNUP_ACCESS_CODE must block new-account creation,
        # never fall back to a string anyone can read in this public repo.
        if not SIGNUP_ACCESS_CODE or pending_access_code.strip().lower() != SIGNUP_ACCESS_CODE.lower():
            return RedirectResponse(url="/#/register?google_error=1&reason=access_code")
        user = User(
            email=email, password_hash=hash_password(secrets.token_urlsafe(32)), name=name,
            email_verified=True, google_sub=google_sub,
        )
        session.add(user)
        session.commit()
        session.refresh(user)
    elif not user.google_sub:
        user.google_sub = google_sub
        user.email_verified = True  # Google already verified this address
        session.add(user)
        session.commit()

    if user.is_suspended:
        return RedirectResponse(url="/#/login?google_error=1")
    request.session["user_id"] = user.id
    return RedirectResponse(url="/#/draft")


@app.post("/api/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


def _month_start() -> datetime:
    now = datetime.utcnow()
    return datetime(now.year, now.month, 1)


def _usage_this_month(session: Session, user_id: int) -> int:
    # Counts from the immutable GenerationEvent log, not live GeneratedContract
    # rows -- a generated document can be permanently deleted later, and that
    # must not retroactively free up the quota it already used this month.
    # See GenerationEvent's docstring in models.py.
    rows = session.exec(
        select(GenerationEvent).where(
            GenerationEvent.owner_id == user_id,
            GenerationEvent.created_at >= _month_start(),
        )
    ).all()
    return len(rows)


def _log_generation_event(session: Session, owner_id: int, generated_contract_id: Optional[int]) -> None:
    """Call once for every successful path that creates a new
    GeneratedContract row AND should count against the monthly plan limit:
    fresh draft, owner edit, inbound-email draft. NOT for a deduped repeat
    that hands back an existing row without creating a new one, and NOT for
    an applied redline round (see apply_redline_submission's docstring --
    that's finishing a document already in progress, not starting a new
    one; bug tracker #29)."""
    session.add(GenerationEvent(owner_id=owner_id, generated_contract_id=generated_contract_id))


def _plan_info(session: Session, user: User) -> dict:
    limit = PLAN_LIMITS.get(user.plan, PLAN_LIMITS[DEFAULT_PLAN])
    used = _usage_this_month(session, user.id)
    return {
        "plan": user.plan,
        "limit": limit,
        "used": used,
        "remaining": None if limit is None else max(0, limit - used),
    }


# Bug tracker #39: per-user locks guarding generate_contract's dedup+quota
# check against its own commit (see the long comment at that call site).
# One Lock object per user who has ever generated a document, for the life
# of the process -- unbounded growth in principle, but trivial in practice
# (a plain threading.Lock is a few dozen bytes, and this is a small app,
# not something serving millions of distinct users per process lifetime).
_generation_locks: dict[int, threading.Lock] = {}
_generation_locks_guard = threading.Lock()


def _generation_lock_for(user_id: int) -> threading.Lock:
    with _generation_locks_guard:
        lock = _generation_locks.get(user_id)
        if lock is None:
            lock = threading.Lock()
            _generation_locks[user_id] = lock
        return lock


# Bug tracker #48: mark_placeholder's field_key uniqueness is only enforced
# by a check-then-insert (_unique_field_key SELECTs existing keys, the
# caller INSERTs several lines later, with a docx load/mutate/save in
# between) and Placeholder.field_key has no DB-level unique constraint. Two
# genuinely concurrent /mark requests on the same template (double-submit,
# two tabs) can both compute the same field_key and both insert it -- and,
# separately, both read-modify-write the same working_path .docx file, so
# whichever save lands second silently clobbers the first mark. Same shape
# of bug as #39/#42, same fix: a per-template lock around the whole
# read-check-mutate-write-commit critical section.
_template_mutation_locks: dict[int, threading.Lock] = {}
_template_mutation_locks_guard = threading.Lock()


def _template_mutation_lock_for(template_id: int) -> threading.Lock:
    with _template_mutation_locks_guard:
        lock = _template_mutation_locks.get(template_id)
        if lock is None:
            lock = threading.Lock()
            _template_mutation_locks[template_id] = lock
        return lock


# Bug tracker #51: create_signature_request's "is one already pending for
# this document?" check and its eventual SigningRequest insert had no lock
# between them -- same shape as #39/#42/#48. Two genuinely concurrent
# sends (two tabs, or a client/owner double-submit racing the frontend's
# own disable-while-sending guard) could both pass the check and both
# create a live SigningRequest + DocuSeal submission for the same
# document. Worse than those other three: get_signature_request and
# cancel_signature_request only ever look at the single newest/first
# matching row, so the earlier one becomes a permanently invisible, still-
# pending, uncancelable-in-app signing request that already emailed the
# client a separate signing link. Reproduced live with two genuinely
# concurrent HTTP requests against a real running server: both committed
# separate SigningRequest rows. Same fix shape: a per-document lock around
# the whole check-through-create critical section.
_signature_request_locks: dict[int, threading.Lock] = {}
_signature_request_locks_guard = threading.Lock()


def _signature_request_lock_for(generated_id: int) -> threading.Lock:
    with _signature_request_locks_guard:
        lock = _signature_request_locks.get(generated_id)
        if lock is None:
            lock = threading.Lock()
            _signature_request_locks[generated_id] = lock
        return lock


def _is_admin(user: Optional[User]) -> bool:
    return bool(user) and user.email.strip().lower() == ADMIN_EMAIL


def get_admin_user(user: User = Depends(get_current_user)) -> User:
    """Same 401-if-logged-out behavior as get_current_user, plus a 403 for
    every account except the owner's. Kept separate from get_current_user
    (rather than an is_admin flag checked ad hoc) so every /api/admin/*
    route gets the same gate from one place."""
    if not _is_admin(user):
        raise HTTPException(403, "Not authorized")
    return user


@app.get("/api/me")
def me(user: Optional[User] = Depends(get_optional_user), session: Session = Depends(get_session)):
    if not user:
        return {"user": None}
    return {
        "user": {"id": user.id, "email": user.email, "name": user.name},
        "plan": _plan_info(session, user),
        "is_admin": _is_admin(user),
    }


class PlanBody(BaseModel):
    plan: str


@app.post("/api/account/plan")
def set_plan(body: PlanBody, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    if body.plan not in PLAN_LIMITS:
        raise HTTPException(400, f"Unknown plan. Choose one of: {', '.join(PLAN_LIMITS)}")
    user.plan = body.plan
    session.add(user)
    session.commit()
    return {"plan": _plan_info(session, user)}


def _notification_settings_payload(user: User) -> dict:
    return {
        "redline_submitted": user.notify_redline_submitted,
        "redline_comment": user.notify_redline_comment,
        "signature_events": user.notify_signature_events,
    }


@app.get("/api/account/notification-settings")
def get_notification_settings(user: User = Depends(get_current_user)):
    return _notification_settings_payload(user)


class NotificationSettingsBody(BaseModel):
    redline_submitted: Optional[bool] = None
    redline_comment: Optional[bool] = None
    signature_events: Optional[bool] = None


@app.patch("/api/account/notification-settings")
def set_notification_settings(
    body: NotificationSettingsBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Per-type opt-out. redline_submitted gates both the bell and a
    matching email; redline_comment gates the in-app bell only (comment-
    thread replies never send email -- see post_share_edit_comment).
    signature_events gates a signer finishing (bell only) and the whole
    request being fully signed (bell + the "Fully signed" email -- see
    _apply_signer_completed/_apply_submission_completed). Each field is
    optional so the client can flip just one toggle at a time without
    having to resend the other current values."""
    if body.redline_submitted is not None:
        user.notify_redline_submitted = body.redline_submitted
    if body.redline_comment is not None:
        user.notify_redline_comment = body.redline_comment
    if body.signature_events is not None:
        user.notify_signature_events = body.signature_events
    session.add(user)
    session.commit()
    return _notification_settings_payload(user)


# ---------------------------------------------------------------------------
# Notifications -- the bell in the topbar. The things that create a row: a
# client submitting redlines, a client commenting on a redline, a signer
# finishing their signature, and a signature request being fully signed by
# everyone (see _notify's call sites) -- each individually mutable via
# /api/account/notification-settings above. (A past type,
# "response_acknowledged" -- a client viewing the owner's accept/reject/
# counter response -- used to fire here too; it was removed because it
# produced too much low-value email volume. Older rows of that type may
# still exist and will still display fine. Signature events were, for a
# while, deliberately excluded from the bell entirely and sent only as an
# email with no opt-out -- see bug tracker: that silently failed to tell an
# owner anything at all when the bell was the only thing being watched.)
# ---------------------------------------------------------------------------

def _notification_payload(n: Notification) -> dict:
    return {
        "id": n.id,
        "type": n.type,
        "title": n.title,
        "body": n.body,
        "generated_contract_id": n.generated_contract_id,
        "created_at": n.created_at.isoformat() + "Z",
        "read": n.read_at is not None,
    }


@app.get("/api/notifications")
def list_notifications(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    rows = session.exec(
        select(Notification).where(Notification.user_id == user.id).order_by(Notification.created_at.desc()).limit(50)
    ).all()
    # Bug tracker #47: unread_count used to be derived only from the 50 rows
    # fetched for display, so once an account passed 50 total notifications,
    # any unread one older than the 50 most recent silently dropped out of
    # the count -- the bell badge understated how many were actually unread.
    # Counted independently here, unbounded by the display limit.
    unread_rows = session.exec(
        select(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None))
    ).all()
    unread_count = len(unread_rows)
    return {"notifications": [_notification_payload(n) for n in rows], "unread_count": unread_count}


@app.post("/api/notifications/{notification_id}/read")
def mark_notification_read(notification_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    n = session.get(Notification, notification_id)
    if not n or n.user_id != user.id:
        raise HTTPException(404, "Notification not found")
    if not n.read_at:
        n.read_at = datetime.utcnow()
        session.add(n)
        session.commit()
    return {"id": n.id, "read": True}


@app.post("/api/notifications/read-all")
def mark_all_notifications_read(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    unread = session.exec(
        select(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None))
    ).all()
    now = datetime.utcnow()
    for n in unread:
        n.read_at = now
        session.add(n)
    session.commit()
    return {"ok": True, "marked": len(unread)}


# ---------------------------------------------------------------------------
# Template endpoints
# ---------------------------------------------------------------------------

def _template_dir(user_id: int, template_id: int) -> str:
    return os.path.join(UPLOADS_DIR, str(user_id), str(template_id))


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")
    if not slug:
        slug = "field"
    if slug[0].isdigit():
        slug = f"f_{slug}"
    return slug


def _unique_field_key(session: Session, template_id: int, base: str) -> str:
    existing_keys = {
        p.field_key
        for p in session.exec(select(Placeholder).where(Placeholder.template_id == template_id)).all()
    }
    if base not in existing_keys:
        return base
    n = 2
    while f"{base}_{n}" in existing_keys:
        n += 1
    return f"{base}_{n}"


def _get_owned_template(session: Session, user: User, template_id: int) -> Template:
    tpl = session.get(Template, template_id)
    if not tpl or tpl.owner_id != user.id:
        raise HTTPException(404, "Template not found")
    return tpl


@app.get("/api/document-types")
def get_document_types():
    return {"types": DOCUMENT_TYPES}


# Word .docx templates are almost entirely text -- even a contract with a
# letterhead logo or a couple of signature images rarely clears a few MB.
# 20MB is generous headroom above any real template while still rejecting
# something clearly not a normal contract (a video or image dump renamed to
# .docx, or an attempted abuse upload). Enforced two ways below: an early
# reject from the Content-Length header when the client sends an honest one
# (avoids reading anything at all), and a hard cap while streaming to disk
# as a backstop for chunked uploads that omit Content-Length -- without
# that second check, a malicious upload could still write an arbitrarily
# large file to disk before ever being rejected.
MAX_TEMPLATE_UPLOAD_BYTES = 20 * 1024 * 1024


@app.post("/api/templates")
def upload_template(
    request: Request,
    name: str = Form(...),
    document_type: str = Form("Other"),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not file.filename.lower().endswith(".docx"):
        raise HTTPException(400, "Please upload a .docx file (Word format).")

    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_TEMPLATE_UPLOAD_BYTES:
                raise HTTPException(400, f"That file is too large -- templates are limited to {MAX_TEMPLATE_UPLOAD_BYTES // (1024 * 1024)}MB.")
        except ValueError:
            pass  # malformed header -- fall through to the streaming check below

    tpl = Template(
        owner_id=user.id,
        name=name.strip() or file.filename,
        document_type=(document_type.strip() or "Other"),
        original_filename=file.filename,
        working_path="",
    )
    session.add(tpl)
    session.commit()
    session.refresh(tpl)

    tpl_dir = _template_dir(user.id, tpl.id)
    os.makedirs(tpl_dir, exist_ok=True)
    original_path = os.path.join(tpl_dir, "original.docx")
    working_path = os.path.join(tpl_dir, "working.docx")
    written = 0
    try:
        with open(original_path, "wb") as f:
            while True:
                chunk = file.file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_TEMPLATE_UPLOAD_BYTES:
                    raise HTTPException(400, f"That file is too large -- templates are limited to {MAX_TEMPLATE_UPLOAD_BYTES // (1024 * 1024)}MB.")
                f.write(chunk)
    except HTTPException:
        shutil.rmtree(tpl_dir, ignore_errors=True)
        session.delete(tpl)
        session.commit()
        raise
    shutil.copyfile(original_path, working_path)

    # Validate it actually opens as a docx (and isn't a zip bomb -- checked
    # from the archive directory first, before anything is decompressed)
    try:
        de.validate_docx_archive(working_path)
    except de.UnsafeDocx as e:
        shutil.rmtree(tpl_dir, ignore_errors=True)
        session.delete(tpl)
        session.commit()
        raise HTTPException(400, str(e))
    try:
        de.load(working_path)
    except Exception:
        shutil.rmtree(tpl_dir, ignore_errors=True)
        session.delete(tpl)
        session.commit()
        raise HTTPException(400, "That file couldn't be read as a Word (.docx) document.")

    tpl.working_path = working_path
    session.add(tpl)
    session.commit()
    session.refresh(tpl)
    return {"id": tpl.id, "name": tpl.name}


class UpdateTemplateBody(BaseModel):
    name: Optional[str] = None
    document_type: Optional[str] = None


@app.patch("/api/templates/{template_id}")
def update_template(
    template_id: int,
    body: UpdateTemplateBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tpl = _get_owned_template(session, user, template_id)
    if body.name is not None and body.name.strip():
        tpl.name = body.name.strip()
    if body.document_type is not None and body.document_type.strip():
        tpl.document_type = body.document_type.strip()
    tpl.updated_at = datetime.utcnow()
    session.add(tpl)
    session.commit()
    return {"id": tpl.id, "name": tpl.name, "document_type": tpl.document_type}


def _generated_count(session: Session, template_id: int) -> int:
    rows = session.exec(select(GeneratedContract).where(GeneratedContract.template_id == template_id)).all()
    return len(rows)


@app.get("/api/templates")
def list_templates(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    tpls = session.exec(select(Template).where(Template.owner_id == user.id).order_by(Template.created_at.desc())).all()
    return [
        {
            "id": t.id,
            "name": t.name,
            "document_type": t.document_type,
            "created_at": t.created_at.isoformat(),
            "placeholder_count": len(t.placeholders),
            "status": "ready" if len(t.placeholders) > 0 else "draft",
            "generated_count": _generated_count(session, t.id),
        }
        for t in tpls
    ]


@app.get("/api/templates/{template_id}")
def get_template(template_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    tpl = _get_owned_template(session, user, template_id)
    return {
        "id": tpl.id,
        "name": tpl.name,
        "document_type": tpl.document_type,
        "original_filename": tpl.original_filename,
        "status": "ready" if len(tpl.placeholders) > 0 else "draft",
        "generated_count": _generated_count(session, tpl.id),
        "placeholders": [
            {
                "id": p.id, "field_key": p.field_key, "label": p.label, "field_type": p.field_type,
                "required": p.required, "order": p.order,
                "threshold_type": p.threshold_type, "threshold_config": json.loads(p.threshold_config or "{}"),
                "preset_options": json.loads(p.preset_options_json or "[]"),
            }
            for p in tpl.placeholders
        ],
    }


@app.get("/api/templates/{template_id}/html")
def get_template_html(template_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    tpl = _get_owned_template(session, user, template_id)
    doc = de.load(tpl.working_path)
    return {"html": de.render_paragraphs_html(doc)}


class MarkSegment(BaseModel):
    r: int
    start: int
    end: int


class PresetOption(BaseModel):
    name: str
    text: str


class MarkBody(BaseModel):
    paragraph_index: int
    segments: list[MarkSegment]
    label: str = ""
    field_type: str = "text"
    required: bool = True
    table_path: str = ""
    existing_field_key: str = ""
    # Only used when field_type == "clause_preset" -- the named whole-clause
    # variants to offer on the draft form for this field.
    preset_options: list[PresetOption] = []
    # The text app.js's computeSelectionSegments captured at the moment this
    # selection was made (range.toString()) -- see mark_placeholder's stale-
    # selection guard. Empty only from a caller that predates this field;
    # never sent empty by app.js itself.
    expected_text: str = ""


def _parse_table_path(path_str: str) -> list[list[int]]:
    """Parse the "t,r,c;t,r,c" container path string sent by the browser
    (see docx_engine module docstring) back into [[t, r, c], ...]. Empty
    string means the top-level document body."""
    if not path_str:
        return []
    try:
        return [[int(x) for x in step.split(",")] for step in path_str.split(";") if step]
    except ValueError:
        raise HTTPException(400, "Invalid table path")


def _table_path_str(container_path: list) -> str:
    """Inverse of _parse_table_path: turn a stored [[t, r, c], ...] list
    back into the "t,r,c;t,r,c" string EditLocationBody.table_path expects.
    Needed anywhere a RedlineEdit's saved location_json (which stores
    "container_path" as a list, see _resolve_edits) gets handed back to the
    client for reuse in a follow-up submission -- without this conversion,
    the client's next request carries no "table_path" key at all, silently
    defaulting to "" (top-level body) and resolving a table-cell redline
    against the wrong paragraph. See RedlineEdit's location round-trip
    (draft_payload / response_payload in get_share_document)."""
    return ";".join(",".join(str(x) for x in step) for step in (container_path or []))


@app.post("/api/templates/{template_id}/mark")
def mark_placeholder(
    template_id: int,
    body: MarkBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tpl = _get_owned_template(session, user, template_id)
    if not body.segments:
        raise HTTPException(400, "No text was selected.")

    with _template_mutation_lock_for(tpl.id):
        return _mark_placeholder_locked(tpl, body, session)


def _mark_placeholder_locked(tpl: Template, body: "MarkBody", session: Session):
    reuse_key = body.existing_field_key.strip()
    existing_placeholder = None
    if reuse_key:
        existing_placeholder = next((p for p in tpl.placeholders if p.field_key == reuse_key), None)
        if existing_placeholder is None:
            raise HTTPException(400, "That field no longer exists on this document.")
        field_key = existing_placeholder.field_key
    else:
        label = body.label.strip()
        if not label:
            raise HTTPException(400, "Please provide a label for this field.")
        field_key = _unique_field_key(session, tpl.id, _slugify(label))

    container_path = _parse_table_path(body.table_path)

    doc = de.load(tpl.working_path)

    # The browser's floating "Mark as placeholder" toolbar captures a
    # selection (paragraph/run/offsets) once, on mouseup, and can stay
    # visible and clickable long after that selection stopped meaning
    # anything -- e.g. the owner deletes a different placeholder, or hits
    # "Start over," either of which re-renders contractView's whole DOM
    # (shifting every run's offsets) without the toolbar itself ever being
    # dismissed. app.js's hideToolbar() now gets called from those actions
    # too (see EditorView), but that only closes the common triggers, not
    # every way this selection could go stale -- this is the real guard.
    # Always re-read whatever text actually sits at the client's numeric
    # location in the CURRENT document (not the client's echoed guess) and
    # compare it against what the browser captured at selection time
    # (expected_text). A mismatch means the offsets now point at different
    # text than the owner ever selected -- reject instead of silently
    # marking whatever happens to be there now with no error at all.
    try:
        current_text = de.extract_text_at(doc, container_path, body.paragraph_index, [s.dict() for s in body.segments])
    except de.MarkError as e:
        raise HTTPException(400, str(e))
    # Bug tracker #50: this guard used to be opt-in -- `if body.expected_text
    # and ...` -- so a request that simply omitted expected_text (a stale
    # client build, or a crafted request) skipped the staleness comparison
    # entirely, with nothing left to catch it but extract_text_at's own
    # in-bounds check (which only confirms the offsets are numerically valid
    # for whatever text is THERE NOW, not that it's the text the owner
    # actually selected). app.js itself never sends this field empty (see
    # MarkBody.expected_text's docstring), so requiring it here just closes
    # the loophole without affecting any real caller.
    if not body.expected_text:
        raise HTTPException(
            400,
            "That selection is no longer valid -- please reselect the text and try again.",
        )
    if current_text != body.expected_text:
        raise HTTPException(
            400,
            "That selection is no longer valid -- the document changed since you selected this text. Please reselect and try again.",
        )

    # Captured BEFORE mark_placeholder overwrites the selection with the
    # {{token}}, so un-marking (delete_placeholder) can restore the actual
    # original wording later instead of having nothing left to fall back
    # on but the field's label. Only meaningful for a brand-new field --
    # reusing an existing field_key at a second location doesn't get its
    # own row, so if that second occurrence's surrounding text differed
    # from the first, un-marking still restores only the first occurrence's
    # text everywhere (matches the existing one-row-per-field model, which
    # already fills every occurrence with the same value).
    original_text = current_text if existing_placeholder is None else None

    try:
        de.mark_placeholder(
            doc, body.paragraph_index, [s.dict() for s in body.segments], field_key,
            container_path=container_path,
        )
    except de.MarkError as e:
        raise HTTPException(400, str(e))
    de.save(doc, tpl.working_path)

    if existing_placeholder is not None:
        # Reusing an existing field: same placeholder now appears in one
        # more spot in the document, but it's still one field -- filling
        # it once fills every location it was marked in. No new row.
        placeholder = existing_placeholder
    else:
        max_order = max([p.order for p in tpl.placeholders], default=-1)
        preset_options_json = "[]"
        if body.field_type == "clause_preset" and body.preset_options:
            preset_options_json = json.dumps([o.dict() for o in body.preset_options])
        placeholder = Placeholder(
            template_id=tpl.id,
            field_key=field_key,
            label=label,
            field_type=body.field_type,
            required=body.required,
            order=max_order + 1,
            preset_options_json=preset_options_json,
            original_text=original_text or "",
        )
        session.add(placeholder)
        session.commit()
        session.refresh(placeholder)

    doc2 = de.load(tpl.working_path)
    return {
        "placeholder": {
            "id": placeholder.id, "field_key": placeholder.field_key, "label": placeholder.label,
            "field_type": placeholder.field_type, "required": placeholder.required,
            "preset_options": json.loads(placeholder.preset_options_json or "[]"),
        },
        "html": de.render_paragraphs_html(doc2),
    }


class PresetOptionsBody(BaseModel):
    preset_options: list[PresetOption]


@app.patch("/api/templates/{template_id}/placeholders/{placeholder_id}/presets")
def set_placeholder_presets(
    template_id: int,
    placeholder_id: int,
    body: PresetOptionsBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Add/edit the named clause variants for a clause_preset field after
    it's been marked (e.g. adding a new state's version later)."""
    tpl = _get_owned_template(session, user, template_id)
    ph = session.get(Placeholder, placeholder_id)
    if not ph or ph.template_id != tpl.id:
        raise HTTPException(404, "Field not found")
    if ph.field_type != "clause_preset":
        raise HTTPException(400, "This field isn't a clause preset field.")
    ph.preset_options_json = json.dumps([o.dict() for o in body.preset_options])
    session.add(ph)
    session.commit()
    return {"preset_options": json.loads(ph.preset_options_json)}


class ThresholdBody(BaseModel):
    threshold_type: str
    threshold_config: dict = {}


@app.patch("/api/templates/{template_id}/placeholders/{placeholder_id}/threshold")
def set_placeholder_threshold(
    template_id: int,
    placeholder_id: int,
    body: ThresholdBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Set the redline auto-approval rule for a field -- see redline_engine
    for what each threshold_type means. This rule is never shown to the
    client on the share page, only used server-side to sort their proposed
    edits into "auto-approved" vs "needs review"."""
    tpl = _get_owned_template(session, user, template_id)
    ph = session.get(Placeholder, placeholder_id)
    if not ph or ph.template_id != tpl.id:
        raise HTTPException(404, "Placeholder not found")
    try:
        normalized = rl.validate_threshold_config(body.threshold_type, body.threshold_config)
    except ValueError as e:
        raise HTTPException(400, str(e))
    ph.threshold_type = body.threshold_type
    ph.threshold_config = json.dumps(normalized)
    session.add(ph)
    session.commit()
    return {"id": ph.id, "threshold_type": ph.threshold_type, "threshold_config": normalized}


@app.delete("/api/templates/{template_id}/placeholders/{placeholder_id}")
def delete_placeholder(
    template_id: int,
    placeholder_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tpl = _get_owned_template(session, user, template_id)
    ph = session.get(Placeholder, placeholder_id)
    if not ph or ph.template_id != tpl.id:
        raise HTTPException(404, "Placeholder not found")

    doc = de.load(tpl.working_path)
    # Restore the actual original wording captured at mark-time (see
    # Placeholder.original_text) rather than baking in the field's label --
    # a real generated contract could otherwise end up with literal
    # placeholder text like "Client Name" sitting where "the undersigned"
    # or whatever the document actually said used to be. Only placeholders
    # marked before original_text existed have nothing to fall back on but
    # the label, same as delete_placeholder always did.
    de.fill_template(doc, {ph.field_key: ph.original_text or ph.label})
    de.save(doc, tpl.working_path)

    session.delete(ph)
    session.commit()

    doc2 = de.load(tpl.working_path)
    return {"html": de.render_paragraphs_html(doc2)}


@app.post("/api/templates/{template_id}/reset")
def reset_template(template_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    tpl = _get_owned_template(session, user, template_id)
    original_path = os.path.join(_template_dir(user.id, tpl.id), "original.docx")
    shutil.copyfile(original_path, tpl.working_path)
    for ph in list(tpl.placeholders):
        session.delete(ph)
    session.commit()
    doc = de.load(tpl.working_path)
    return {"html": de.render_paragraphs_html(doc)}


@app.delete("/api/templates/{template_id}")
def delete_template(template_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    tpl = _get_owned_template(session, user, template_id)
    tpl_dir = _template_dir(user.id, tpl.id)
    gen_dir = os.path.join(tpl_dir, "generated")

    # GeneratedContract rows deliberately survive template deletion (see
    # that model's docstring, and the confirmation dialog in app.js which
    # tells the user their drafted documents are "kept in your library").
    # But their .docx files live inside this template's own directory tree
    # (see generate_contract's gen_dir), so deleting that tree out from
    # under them would silently break every "kept" document's download.
    # Move the generated/ subfolder out to a stable location first, and
    # repoint each surviving row's file_path there, before removing the
    # rest of the template's files.
    if os.path.isdir(gen_dir):
        preserved_dir = os.path.join(UPLOADS_DIR, str(user.id), "_deleted_templates", str(tpl.id), "generated")
        os.makedirs(os.path.dirname(preserved_dir), exist_ok=True)
        if os.path.isdir(preserved_dir):
            shutil.rmtree(preserved_dir, ignore_errors=True)
        shutil.move(gen_dir, preserved_dir)
        surviving = session.exec(
            select(GeneratedContract).where(GeneratedContract.template_id == tpl.id)
        ).all()
        for gc in surviving:
            if gc.file_path and gc.file_path.startswith(gen_dir):
                gc.file_path = preserved_dir + gc.file_path[len(gen_dir):]
                session.add(gc)

    shutil.rmtree(tpl_dir, ignore_errors=True)
    for ph in list(tpl.placeholders):
        session.delete(ph)
    session.delete(tpl)
    session.commit()
    return {"ok": True}


class GenerateBody(BaseModel):
    values: dict[str, str]
    parties: list[str] = []  # who this contract is between, e.g. ["Rotely AI", "Swift Enterprises"]


@app.post("/api/templates/{template_id}/generate")
def generate_contract(
    template_id: int,
    body: GenerateBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tpl = _get_owned_template(session, user, template_id)

    if not tpl.placeholders:
        raise HTTPException(400, "This template has no placeholders yet. Mark some fields before drafting from it.")

    missing = [p.label for p in tpl.placeholders if p.required and not (body.values.get(p.field_key) or "").strip()]
    if missing:
        raise HTTPException(400, f"Missing required fields: {', '.join(missing)}")

    values_snapshot = [
        {"label": p.label, "field_key": p.field_key, "value": body.values.get(p.field_key, "")}
        for p in tpl.placeholders
    ]
    parties = [p.strip() for p in body.parties if p.strip()][:6]
    values_json = json.dumps(values_snapshot)
    parties_json = json.dumps(parties)

    # Defense-in-depth against duplicate rows from a double-submit (double
    # click, or a slow first request plus a retry) -- the client already
    # disables the Generate button while a request is in flight, but that
    # can't be relied on alone (e.g. two near-simultaneous requests racing
    # past the disabled check). If an identical draft from this user/template
    # with the same field values was created in the last few seconds, treat
    # this as a repeat of that request and hand back the existing row
    # instead of creating a second document.
    #
    # Deliberately checked BEFORE the plan-limit gate below (and before any
    # file gets written): a legitimate retry of the request that pushed you
    # to exactly your limit would otherwise see used >= limit on its own
    # re-check and get rejected with "plan limit reached", even though it's
    # not actually asking for a new slot -- it's the same request landing
    # twice. Checking dedup first also means a duplicate never generates or
    # saves a second .docx to begin with, instead of generating one and
    # discarding it.
    # Bug tracker #39: everything from here through the commit below --
    # the dedup check, the quota check, and the row that actually spends a
    # slot -- must be atomic per-user, or two truly concurrent requests can
    # both read the same "used" count before either has committed its new
    # GenerationEvent, and both slip through even when only one slot (or
    # zero) actually remains. SQLite gives no row-level "SELECT ... FOR
    # UPDATE" to lean on here, but this whole app runs as a single Python
    # process (one uvicorn worker, per render.yaml) with sync endpoints
    # dispatched to a real thread pool, so a plain in-process lock, scoped
    # per user so unrelated users' requests never wait on each other, fully
    # closes the window. Reproduced live pre-fix with two real concurrent
    # HTTP requests against a running server and a forced rendezvous at the
    # quota check (deterministic, not timing-dependent): both got 200 and
    # usage ended up over the plan limit. Verified fixed the same way:
    # exactly one succeeds, the other gets a clean 402.
    with _generation_lock_for(user.id):
        dedup_window = datetime.utcnow() - timedelta(seconds=15)
        recent_dupe = session.exec(
            select(GeneratedContract).where(
                GeneratedContract.owner_id == user.id,
                GeneratedContract.template_id == tpl.id,
                GeneratedContract.values_json == values_json,
                GeneratedContract.parties_json == parties_json,
                GeneratedContract.created_at >= dedup_window,
            )
        ).first()
        if recent_dupe is not None:
            preview_doc = de.load(recent_dupe.file_path)
            return {
                "generated_id": recent_dupe.id,
                "name": recent_dupe.name,
                "document_type": recent_dupe.document_type,
                "html": de.render_paragraphs_html(preview_doc),
                "plan": _plan_info(session, user),
            }

        plan = _plan_info(session, user)
        if plan["limit"] is not None and plan["used"] >= plan["limit"]:
            raise HTTPException(
                402,
                f"You have used all {plan['limit']} contracts included in your {user.plan} plan this month. "
                f"Upgrade your plan to draft more.",
            )

        doc = de.load(tpl.working_path)
        field_positions = de.fill_template_tracked(doc, body.values)

        gen_dir = os.path.join(_template_dir(user.id, tpl.id), "generated")
        os.makedirs(gen_dir, exist_ok=True)
        out_path = os.path.join(gen_dir, f"{secrets.token_hex(8)}.docx")
        de.save(doc, out_path)

        safe_name = re.sub(r"[^A-Za-z0-9 _\-]+", "", tpl.name).strip() or "Contract"
        display_name = f"{safe_name} - {datetime.utcnow().strftime('%b %d, %Y')}"

        gc = GeneratedContract(
            owner_id=user.id,
            template_id=tpl.id,
            template_name=tpl.name,
            document_type=tpl.document_type,
            name=display_name,
            file_path=out_path,
            values_json=values_json,
            field_positions_json=json.dumps(field_positions),
            parties_json=parties_json,
        )
        session.add(gc)
        session.flush()
        _log_generation_event(session, user.id, gc.id)
        session.commit()
        session.refresh(gc)

    preview_doc = de.load(out_path)
    return {
        "generated_id": gc.id,
        "name": gc.name,
        "document_type": gc.document_type,
        "html": de.render_paragraphs_html(preview_doc),
        "plan": _plan_info(session, user),
    }


# ---------------------------------------------------------------------------
# Generated contract library (archive, delete forever, download, re-view)
# ---------------------------------------------------------------------------

def _get_owned_generated(session: Session, user: User, generated_id: int) -> GeneratedContract:
    gc = session.get(GeneratedContract, generated_id)
    if not gc or gc.owner_id != user.id:
        raise HTTPException(404, "Document not found")
    return gc


# ---- lineage: group generated documents into a "folder" only when they're
# actually connected through a real redline round (share -> client edits ->
# owner applies), never just because they came from the same master
# template -- see GeneratedContract.source_submission_id. ----

def _lineage_roots_for(rows: list, session: Session) -> dict:
    """Map generated_contract_id -> lineage root id for a set of
    GeneratedContract rows all belonging to the same owner. A document with
    neither source_submission_id nor source_generated_id is its own root.
    A directly-edited revision's parent is source_generated_id. A
    redlined-and-applied document's parent is ALSO source_generated_id (set
    alongside source_submission_id since apply_redline_submission started
    stamping both) -- falls back to the older indirect path (walking
    source_submission_id -> RedlineSubmission.share_link_id ->
    ShareLink.generated_contract_id) only for rows applied before that field
    existed. That fallback is best-effort, not exact: ShareLink.generated_
    contract_id is a live pointer that a later apply on the same link keeps
    moving forward (see apply_redline_submission's same-link repoint), so it
    only still reflects a given row's true parent if no later apply has
    happened on that link since. Either way the walk continues back until a
    document with no parent is reached. Defensive about broken chains (a
    deleted parent, etc.) -- those just fall back to being their own root
    rather than erroring."""
    by_id = {g.id: g for g in rows}
    sub_ids = {g.source_submission_id for g in rows if g.source_submission_id and not g.source_generated_id}
    subs = {}
    if sub_ids:
        subs = {s.id: s for s in session.exec(select(RedlineSubmission).where(RedlineSubmission.id.in_(sub_ids))).all()}
    link_ids = {s.share_link_id for s in subs.values()}
    links = {}
    if link_ids:
        links = {l.id: l for l in session.exec(select(ShareLink).where(ShareLink.id.in_(link_ids))).all()}

    roots: dict = {}

    def _parent_id(gc):
        if gc.source_generated_id:
            return gc.source_generated_id
        if gc.source_submission_id:
            sub = subs.get(gc.source_submission_id)
            link = links.get(sub.share_link_id) if sub else None
            return link.generated_contract_id if link else None
        return None

    def resolve(gc_id, _seen=None):
        if gc_id in roots:
            return roots[gc_id]
        _seen = _seen or set()
        if gc_id in _seen:  # cycle guard -- should never happen, but don't hang if it does
            roots[gc_id] = gc_id
            return gc_id
        _seen.add(gc_id)
        gc = by_id.get(gc_id)
        parent_id = _parent_id(gc) if gc else None
        if not gc or parent_id is None or parent_id == gc_id or parent_id not in by_id:
            roots[gc_id] = gc_id
            return gc_id
        root = resolve(parent_id, _seen)
        roots[gc_id] = root
        return root

    for g in rows:
        resolve(g.id)
    return roots


def _lineage_doc_ids(gc: GeneratedContract, session: Session) -> set:
    """Every GeneratedContract id in the same lineage family as gc,
    including gc itself -- e.g. so a share link can be found regardless of
    which specific revision in the family it currently points at (a redline
    apply keeps moving that pointer forward; see apply_redline_submission's
    same-link repoint), instead of requiring an exact id match against
    whichever revision happens to be in hand."""
    all_docs = session.exec(select(GeneratedContract).where(GeneratedContract.owner_id == gc.owner_id)).all()
    roots = _lineage_roots_for(all_docs, session)
    root_id = roots.get(gc.id, gc.id)
    return {g.id for g in all_docs if roots.get(g.id) == root_id}


def _lineage_timeline(gc: GeneratedContract, session: Session) -> dict:
    """Every document in the same lineage as gc, oldest first, plus a merged
    activity timeline: every draft/redline-applied revision, every time the
    document was shared, every time the client viewed it (every visit, not
    just the latest), and every redline round they submitted. Owner-only --
    includes everything, no redaction (contrast with the client-facing
    history view, which must never show threshold rules)."""
    all_docs = session.exec(select(GeneratedContract).where(GeneratedContract.owner_id == gc.owner_id)).all()
    roots = _lineage_roots_for(all_docs, session)
    root_id = roots.get(gc.id, gc.id)
    lineage_docs = sorted((g for g in all_docs if roots.get(g.id) == root_id), key=lambda g: g.created_at)
    lineage_ids = {g.id for g in lineage_docs}
    if not lineage_ids:
        return {"root_id": root_id, "documents": [], "timeline": []}

    links = session.exec(select(ShareLink).where(ShareLink.generated_contract_id.in_(lineage_ids))).all()
    link_ids = [l.id for l in links]
    link_by_id = {l.id: l for l in links}
    submissions = (
        session.exec(select(RedlineSubmission).where(RedlineSubmission.share_link_id.in_(link_ids))).all()
        if link_ids else []
    )
    views = (
        session.exec(select(ShareLinkView).where(ShareLinkView.share_link_id.in_(link_ids))).all()
        if link_ids else []
    )

    events = []
    for g in lineage_docs:
        if g.source_submission_id:
            ev_type = "redline_applied"
        elif g.source_generated_id:
            ev_type = "owner_edited"
        else:
            ev_type = "drafted"
        events.append({
            "type": ev_type,
            "at": g.created_at.isoformat() + "Z",
            "document_id": g.id,
            "document_name": g.name,
        })
    for l in links:
        events.append({
            "type": "shared", "at": l.created_at.isoformat() + "Z",
            "document_id": l.generated_contract_id, "share_link_id": l.id,
        })
    for v in views:
        link = link_by_id.get(v.share_link_id)
        events.append({
            "type": "viewed", "at": v.viewed_at.isoformat() + "Z",
            "document_id": link.generated_contract_id if link else None, "share_link_id": v.share_link_id,
        })
    for s in submissions:
        if s.status == "draft":
            continue  # only saved-in-progress, never actually sent -- nothing happened yet
        link = link_by_id.get(s.share_link_id)
        # An owner_reconsideration round (see RedlineSubmission.origin) is
        # the OWNER updating their own earlier decision, and an owner_edit
        # round (phase 5) is the OWNER proposing a direct edit for the
        # client to approve -- neither is the client sending anything, so
        # each gets its own event type instead of being mislabeled "The
        # client sent proposed changes for review" in the timeline
        # (app.js's chainItemFor).
        if s.origin == "owner_reconsideration":
            ev_type = "owner_reconsidered"
        elif s.origin == "owner_edit":
            ev_type = "owner_edit_proposed"
        else:
            ev_type = "redline_submitted"
        events.append({
            "type": ev_type, "at": s.submitted_at.isoformat() + "Z",
            "document_id": link.generated_contract_id if link else None,
            "share_link_id": s.share_link_id, "submission_id": s.id,
        })
    events.sort(key=lambda e: e["at"])

    return {
        "root_id": root_id,
        "documents": [
            {
                "id": g.id, "name": g.name, "document_type": g.document_type,
                "created_at": g.created_at.isoformat() + "Z", "archived": g.archived,
                "is_redline_result": g.source_submission_id is not None,
            }
            for g in lineage_docs
        ],
        "timeline": events,
    }


@app.get("/api/generated")
def list_generated(
    archived: Optional[bool] = None,
    template_id: Optional[int] = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    # Lineage roots are computed against ALL of the owner's documents,
    # unfiltered, so a folder groups correctly even when one revision in it
    # is archived and this call is asking for only non-archived rows.
    all_rows = session.exec(select(GeneratedContract).where(GeneratedContract.owner_id == user.id)).all()
    lineage_roots = _lineage_roots_for(all_rows, session)

    q = select(GeneratedContract).where(GeneratedContract.owner_id == user.id)
    if archived is not None:
        q = q.where(GeneratedContract.archived == archived)
    if template_id is not None:
        q = q.where(GeneratedContract.template_id == template_id)
    rows = session.exec(q.order_by(GeneratedContract.created_at.desc())).all()
    status_by_doc = _document_statuses(session, [g.id for g in rows], owner_id=user.id)
    unresolved_by_doc = _unresolved_counts(session, [g.id for g in rows], owner_id=user.id)
    return [
        {
            "id": g.id,
            "name": g.name,
            "template_id": g.template_id,
            "template_name": g.template_name,
            "document_type": g.document_type,
            "archived": g.archived,
            "created_at": g.created_at.isoformat(),
            "values": json.loads(g.values_json),
            "lineage_root_id": lineage_roots.get(g.id, g.id),
            "is_redline_result": g.source_submission_id is not None,
            "parties": json.loads(g.parties_json or "[]"),
            "status": status_by_doc.get(g.id, {"key": "draft", "label": "Draft", "tone": "draft"}),
            # See _unresolved_counts -- #21 / phase 4. How many of the
            # owner's own countered redlines are still awaiting an explicit
            # client response, independent of Phase 2's comment-resolve
            # state.
            "unresolved_count": unresolved_by_doc.get(g.id, 0),
        }
        for g in rows
    ]


def _document_statuses(session: Session, doc_ids: list, owner_id: Optional[int] = None) -> dict:
    """Bulk-computes a human status label per generated document id from its
    most recent share link and redline submission (if any): draft (never
    shared) -> shared, awaiting review -> redlines submitted -> response
    sent, awaiting client -> client reviewing your response -> redlines
    applied.

    A status belongs to a whole lineage FAMILY, not just whichever exact
    revision a share link's live pointer currently happens to sit on --
    applying redlines or editing a document keeps moving that pointer
    forward onto the newest revision (see apply_redline_submission's
    same-link repoint). Without accounting for that, an older revision's
    status would silently regress to the caller's "never shared" default
    the moment a later revision in the same family picked up the link, even
    though the older revision's own visible history clearly shows it was
    shared/reviewed too. So when an owner_id is available, every document
    in doc_ids gets matched against the whole lineage family it belongs to
    (mirroring the same approach get_redlines already relies on to find
    "the" link off a stale revision), and the family's most-recently-linked
    status is mirrored onto every member of that family that doesn't have
    its own direct link match."""
    if not doc_ids:
        return {}

    root_by_doc: dict = {}
    family_ids = set(doc_ids)
    if owner_id is None and doc_ids:
        any_doc = session.get(GeneratedContract, doc_ids[0])
        owner_id = any_doc.owner_id if any_doc else None
    if owner_id is not None:
        all_docs = session.exec(select(GeneratedContract).where(GeneratedContract.owner_id == owner_id)).all()
        roots = _lineage_roots_for(all_docs, session)
        root_by_doc = {g.id: roots.get(g.id, g.id) for g in all_docs}
        wanted_roots = {root_by_doc[d] for d in doc_ids if d in root_by_doc}
        family_ids = {gid for gid, root in root_by_doc.items() if root in wanted_roots} | set(doc_ids)

    links = session.exec(select(ShareLink).where(ShareLink.generated_contract_id.in_(family_ids))).all()
    if not links:
        return {}
    link_ids = [l.id for l in links]
    subs = session.exec(select(RedlineSubmission).where(RedlineSubmission.share_link_id.in_(link_ids))).all()
    subs_by_link = {}
    for s in subs:
        if s.status == "draft":
            continue  # an in-progress "Save progress" draft isn't visible to the owner yet
        subs_by_link.setdefault(s.share_link_id, []).append(s)

    # #57: a submission can now legitimately carry zero RedlineEdit rows (the
    # client reviewed and had nothing to flag), so "responded_at is set" no
    # longer always means the OWNER sent something back -- it can equally
    # mean there was never anything to respond to in the first place. Batch
    # up edit counts per submission so the loop below can tell those two
    # cases apart instead of mislabeling a plain "nothing to change"
    # confirmation as "Response sent, awaiting client".
    sub_ids = [s.id for s in subs]
    edit_counts: dict = {}
    if sub_ids:
        for sid in session.exec(select(RedlineEdit.submission_id).where(RedlineEdit.submission_id.in_(sub_ids))).all():
            edit_counts[sid] = edit_counts.get(sid, 0) + 1

    out = {}
    for link in links:
        # A generated doc can pick up more than one share link over time
        # (re-shared); keep the most recently created one's status.
        if link.generated_contract_id in out and link.created_at <= out[link.generated_contract_id]["_link_created_at"]:
            continue
        doc_subs = sorted(subs_by_link.get(link.id, []), key=lambda s: s.submitted_at, reverse=True)
        latest_sub = doc_subs[0] if doc_subs else None
        if latest_sub is None:
            status = {"key": "shared", "label": "Shared, awaiting review", "tone": "pending"}
        elif latest_sub.status == "reviewed":
            status = {"key": "applied", "label": "Redlines applied", "tone": "final"}
        elif latest_sub.responded_at and not edit_counts.get(latest_sub.id, 0):
            # Nothing was ever proposed in this round -- responded_at was set
            # the instant it arrived (see submit_redlines) because there was
            # never anything pending, not because the owner sent a response.
            status = {"key": "reviewed_no_changes", "label": "Reviewed, no changes requested", "tone": "final"}
        elif latest_sub.responded_at and not latest_sub.client_ack_at:
            status = {"key": "response_sent", "label": "Response sent, awaiting client", "tone": "pending"}
        elif latest_sub.responded_at and latest_sub.client_ack_at:
            status = {"key": "client_reviewing", "label": "Client reviewing your response", "tone": "pending"}
        else:
            status = {"key": "submitted", "label": "Redlines submitted, awaiting your review", "tone": "pending"}
        status["_link_created_at"] = link.created_at
        out[link.generated_contract_id] = status

    # Mirror each family's most-recently-linked status onto every other
    # revision in doc_ids that shares its lineage root but isn't itself the
    # exact document a link currently points at.
    if root_by_doc:
        status_by_root = {}
        for doc_id, status in out.items():
            root = root_by_doc.get(doc_id)
            if root is None:
                continue
            if root not in status_by_root or status["_link_created_at"] > status_by_root[root]["_link_created_at"]:
                status_by_root[root] = status
        for d in doc_ids:
            if d not in out:
                root = root_by_doc.get(d)
                if root in status_by_root:
                    out[d] = status_by_root[root]

    for status in out.values():
        status.pop("_link_created_at", None)
    return out


def _unresolved_counts(session: Session, doc_ids: list, owner_id: Optional[int] = None) -> dict:
    """Bulk-computes, per generated document id, how many of the owner's own
    countered redlines are still hanging with no explicit response -- bug
    tracker #21 (phase 4 of the redline-negotiation overhaul). Before this,
    a client who never explicitly accepted, rejected, or re-suggested a
    countered edit had it silently treated as accepted the moment they hit
    Finalize; that loophole is now closed (see submit_redlines and
    share.js's own client-side check), and this count is the "N unresolved"
    visibility the owner gets in the meantime -- while the client is still
    deciding, or if they never come back to decide at all.

    A countered RedlineEdit counts as resolved the moment ANY other
    RedlineEdit chains back to it via source_edit_id -- whether that's the
    client's own explicit accept/reject/counter response (submit_redlines /
    _resolve_edits' accepting_edit_id path) or the owner reconsidering it
    themselves (reconsider_redline_edit). Either way, something now stands
    in its place, so it's no longer just silently waiting.

    Counted across every share link the document's lineage has ever had, to
    match #8 and _document_statuses' same family-wide scope, then mirrored
    onto every revision in that family so the badge reads the same
    regardless of which exact revision a share link's pointer currently
    sits on."""
    if not doc_ids:
        return {}

    root_by_doc: dict = {}
    family_ids = set(doc_ids)
    if owner_id is None and doc_ids:
        any_doc = session.get(GeneratedContract, doc_ids[0])
        owner_id = any_doc.owner_id if any_doc else None
    if owner_id is not None:
        all_docs = session.exec(select(GeneratedContract).where(GeneratedContract.owner_id == owner_id)).all()
        roots = _lineage_roots_for(all_docs, session)
        root_by_doc = {g.id: roots.get(g.id, g.id) for g in all_docs}
        wanted_roots = {root_by_doc[d] for d in doc_ids if d in root_by_doc}
        family_ids = {gid for gid, root in root_by_doc.items() if root in wanted_roots} | set(doc_ids)

    links = session.exec(select(ShareLink).where(ShareLink.generated_contract_id.in_(family_ids))).all()
    if not links:
        return {d: 0 for d in doc_ids}
    link_by_id = {l.id: l for l in links}
    subs = session.exec(
        select(RedlineSubmission).where(RedlineSubmission.share_link_id.in_(list(link_by_id.keys())), RedlineSubmission.status != "draft")
    ).all()
    sub_ids = [s.id for s in subs]
    if not sub_ids:
        return {d: 0 for d in doc_ids}
    sub_link = {s.id: s.share_link_id for s in subs}
    edits = session.exec(select(RedlineEdit).where(RedlineEdit.submission_id.in_(sub_ids))).all()
    referenced = {e.source_edit_id for e in edits if e.source_edit_id}

    count_by_doc: dict = {}
    for e in edits:
        if e.decision != "countered" or e.id in referenced:
            continue
        link = link_by_id.get(sub_link.get(e.submission_id))
        if not link:
            continue
        count_by_doc[link.generated_contract_id] = count_by_doc.get(link.generated_contract_id, 0) + 1

    out = {}
    if root_by_doc:
        count_by_root: dict = {}
        for doc_id, cnt in count_by_doc.items():
            root = root_by_doc.get(doc_id)
            if root is None:
                continue
            count_by_root[root] = count_by_root.get(root, 0) + cnt
        for d in doc_ids:
            out[d] = count_by_root.get(root_by_doc.get(d), 0)
    else:
        for d in doc_ids:
            out[d] = count_by_doc.get(d, 0)
    return out


@app.get("/api/generated/{generated_id}")
def get_generated(generated_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    gc = _get_owned_generated(session, user, generated_id)
    html = None
    if os.path.exists(gc.file_path):
        html = de.render_paragraphs_html(de.load(gc.file_path))
    status = _document_statuses(session, [gc.id], owner_id=gc.owner_id).get(gc.id, {"key": "draft", "label": "Draft", "tone": "draft"})
    unresolved_count = _unresolved_counts(session, [gc.id], owner_id=gc.owner_id).get(gc.id, 0)
    return {
        "id": gc.id,
        "name": gc.name,
        "template_id": gc.template_id,
        "template_name": gc.template_name,
        "document_type": gc.document_type,
        "archived": gc.archived,
        "created_at": gc.created_at.isoformat(),
        "values": json.loads(gc.values_json),
        "html": html,
        "parties": json.loads(gc.parties_json or "[]"),
        "status": status,
        # See _unresolved_counts -- #21 / phase 4.
        "unresolved_count": unresolved_count,
    }


@app.get("/api/generated/{generated_id}/history")
def get_generated_history(generated_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    gc = _get_owned_generated(session, user, generated_id)
    return _lineage_timeline(gc, session)


def _client_lineage_timeline(gc: GeneratedContract, session: Session) -> dict:
    """The client-facing cut of the same lineage timeline: what happened and
    when, in plain terms, with none of the owner's internal identifiers
    (document/share-link/submission ids, document names) or anything
    threshold-related -- consistent with get_share_document, which likewise
    never sends redline threshold rules to the client.

    "owner_edited" events (see #23 in the bug tracker) are dropped entirely
    here, not just relabeled -- a direct edit the owner made to their own
    private draft BEFORE the document was ever shared is internal drafting
    process, not something the client was ever part of or needs to know
    happened; it's still a real revision (nothing here changes the document
    itself or its lineage), it just never surfaces as a timeline entry on
    this side. Contrast with "owner_edit_proposed" (an edit made AFTER
    sharing), which the client absolutely must see since it's a proposal
    they need to act on."""
    full = _lineage_timeline(gc, session)
    return {
        "revision_count": len(full["documents"]),
        "timeline": [{"type": e["type"], "at": e["at"]} for e in full["timeline"] if e["type"] != "owner_edited"],
    }


class DirectEditItem(BaseModel):
    table_path: str = ""
    paragraph_index: int
    segments: list  # [{"r": int, "start": int, "end": int}, ...] -- same shape the browser already captures for template field-marking and redlining
    new_text: str


class DirectEditsBody(BaseModel):
    # A batch of direct edits staged locally in the preview (see
    # showPreviewOverlay's `staged` list + repaint() in app.js) and
    # submitted together. Before this (ad hoc user report: "you don't want
    # to have to draft a new document for every edit"), every click posted
    # its own edit immediately -- on an unshared document that meant a
    # brand-new revision per click, and on a shared one, a separate
    # client-facing round (and email) per click. Always a list now, even
    # for a single edit, so both paths below apply the whole batch as one
    # unit -- one new revision, or one RedlineSubmission with one
    # RedlineEdit per item.
    edits: list[DirectEditItem]


@app.post("/api/generated/{generated_id}/edit")
def edit_generated_document(
    generated_id: int,
    body: DirectEditsBody,
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Owner-side direct editing: select chunks of text right in the
    generated document and replace/insert them, staged locally and sent
    here as one batch. Reuses the exact same docx-splicing engine as
    accepted redlines (docx_engine.apply_text_edits, which already groups
    a batch by paragraph in one pass -- see its docstring), and saves the
    result as a new revision so it slots into the same lineage/history
    trail as redlines do (see GeneratedContract.source_generated_id).

    Applied immediately -- no approval step -- UNLESS the document
    currently has an open share link, in which case (bug tracker #23,
    phase 5) the owner is editing something a client may already be
    reviewing, so the whole batch is queued as one client-approvable
    round instead of silently changing the doc out from under them. See
    RedlineSubmission.origin == "owner_edit" for how that's modeled --
    deliberately with no owner-side bypass to apply it instantly instead;
    once shared, ALL edits (direct or via redline) go through the same
    client-facing negotiation loop."""
    gc = _get_owned_generated(session, user, generated_id)
    if not os.path.exists(gc.file_path):
        raise HTTPException(410, "This file is no longer available.")
    if not body.edits:
        raise HTTPException(400, "No changes to apply.")

    # Matched against the whole lineage family, not just this exact
    # revision's id (bug tracker #28) -- an applied redline repoints the
    # link forward to the newest revision, so checking only gc.id would
    # miss an open link entirely when editing an older revision (e.g.
    # reached through document history), letting the edit apply instantly
    # instead of being queued for the client who may still be reviewing
    # the family under that link. Same pattern get_redlines already uses.
    open_link = session.exec(
        select(ShareLink)
        .where(ShareLink.generated_contract_id.in_(_lineage_doc_ids(gc, session)), ShareLink.status == "open")
        .order_by(ShareLink.created_at.desc())
    ).first()

    # Validate and resolve every item up front, against the CURRENT
    # document (read-only at this point in both branches below) -- so a
    # batch lands whole or not at all, never half-applied because item 3
    # turned out stale while items 1-2 had already gone through.
    doc_for_read = de.load(gc.file_path)
    resolved = []
    for item in body.edits:
        if not item.segments:
            raise HTTPException(400, "No selection to edit.")
        # A click-to-insert (see computeCursorPosition in app.js) sends one
        # zero-width segment (start == end) instead of a real range --
        # unlike a replace, where an empty new_text is a legitimate
        # deletion, "insert nothing at a point" has no meaningful effect,
        # so reject it up front rather than silently writing a no-op.
        is_insert = all(seg["start"] == seg["end"] for seg in item.segments)
        if is_insert and not item.new_text.strip():
            raise HTTPException(400, "Type something to insert.")

        container_path = (
            [[int(x) for x in triple.split(",")] for triple in item.table_path.split(";")]
            if item.table_path else []
        )
        try:
            original_text = de.extract_text_at(doc_for_read, container_path, item.paragraph_index, item.segments)
        except de.MarkError as err:
            raise HTTPException(400, f"That selection is no longer valid: {err}")
        # Deliberately NOT .strip()'d -- unlike the no-op/label checks below
        # (which only care whether there's meaningful content), the actual
        # value spliced into the document has to preserve exact whitespace,
        # matching apply_text_edits below which never strips it either.
        # Stripping here silently ate leading/trailing spaces off otherwise-
        # meaningful text -- harmless-looking on a replace, but a real
        # word-mashing bug for an insert (e.g. typing "written " to read
        # "...the written effective date" came out "writteneffective").
        new_text = item.new_text
        if new_text.strip() == original_text.strip():
            # is_insert is already ruled out above (empty insert rejected
            # earlier), so reaching here with new_text == original_text
            # only happens on a replace typed back to its own starting text.
            raise HTTPException(400, "That's already the current text.")

        resolved.append({
            "container_path": container_path,
            "paragraph_index": item.paragraph_index,
            "segments": item.segments,
            "new_text": new_text,
            "original_text": original_text,
        })

    # Bug tracker #44: reject a batch containing two edits that overlap the
    # same run BEFORE creating anything for it, on either path. The
    # instant-apply branch below already gets this for free (it calls
    # de.apply_text_edits, which raises via _apply_paragraph_group before
    # anything is saved), but the queued/shared branch used to stage each
    # item independently with no such check -- both overlapping edits would
    # queue successfully, and the client could go on to accept both, at
    # which point the overlap would only surface at Apply time, long after
    # they'd already been explicitly accepted and could no longer be
    # withdrawn (withdraw_owner_edit only works on a still-"countered"
    # edit) -- permanently stranding that round with no in-app way out.
    # Checking here, up front, against the same doc_for_read/resolved data
    # already used above, closes that gap for both branches uniformly.
    try:
        de.validate_no_overlaps(doc_for_read, resolved)
    except de.MarkError as err:
        raise HTTPException(400, f"Those edits overlap and can't be batched together: {err}")

    if open_link:
        submission = RedlineSubmission(
            share_link_id=open_link.id, status="pending", origin="owner_edit",
            responded_at=datetime.utcnow(), client_ack_at=None,
        )
        session.add(submission)
        session.commit()
        session.refresh(submission)

        edits_created = []
        for r in resolved:
            excerpt = r["original_text"].strip()
            if excerpt:
                label = (excerpt[:57] + "…") if len(excerpt) > 57 else excerpt
            else:
                # Insert (see above) -- there's no original text to
                # summarize, so fall back to an excerpt of what's actually
                # being inserted instead of a generic "Custom edit."
                inserted_stripped = r["new_text"].strip()
                inserted = inserted_stripped[:47] + "…" if len(inserted_stripped) > 47 else inserted_stripped
                label = f"Inserted: {inserted}" if inserted else "Custom edit"

            edit = RedlineEdit(
                submission_id=submission.id,
                field_key="", label=label,
                # proposed_value deliberately mirrors original_value (not
                # new_text) -- the owner IS the counter, so there's no
                # separate "what the client asked for" to record; keeping
                # the two equal is also what lets share.js's existing
                # counter-seeding logic (client_original_value =
                # e.proposed_value) revert cleanly to the true original
                # text if the client rejects this proposal.
                original_value=r["original_text"], proposed_value=r["original_text"],
                evaluation="needs_review",
                decision="countered",
                counter_value=r["new_text"],
                location_json=json.dumps({
                    "container_path": r["container_path"],
                    "paragraph_index": r["paragraph_index"],
                    "segments": r["segments"],
                }),
            )
            session.add(edit)
            edits_created.append(edit)
        session.commit()
        for edit in edits_created:
            session.refresh(edit)

        _send_owner_edit_email(request, user, gc, open_link, edits_created)
        return {
            "queued_for_approval": True,
            "submission_id": submission.id,
            "edit_ids": [e.id for e in edits_created],
        }

    doc = de.load(gc.file_path)
    try:
        de.apply_text_edits(doc, [
            {
                "container_path": r["container_path"],
                "paragraph_index": r["paragraph_index"],
                "segments": r["segments"],
                "new_text": r["new_text"],
            }
            for r in resolved
        ])
    except de.MarkError as err:
        raise HTTPException(400, f"Couldn't apply that edit: {err}")

    if gc.template_id:
        gen_dir = os.path.join(_template_dir(user.id, gc.template_id), "generated")
    else:
        gen_dir = os.path.dirname(gc.file_path)
    os.makedirs(gen_dir, exist_ok=True)
    out_path = os.path.join(gen_dir, f"{secrets.token_hex(8)}.docx")
    de.save(doc, out_path)

    new_gc = GeneratedContract(
        owner_id=user.id,
        template_id=gc.template_id,
        template_name=gc.template_name,
        document_type=gc.document_type,
        name=gc.name,
        file_path=out_path,
        values_json=gc.values_json,
        field_positions_json=gc.field_positions_json,
        parties_json=gc.parties_json,
        source_generated_id=gc.id,
        # Inherit the source revision's archived state -- otherwise a new
        # revision always defaulted to un-archived, which could revive an
        # archived document's family and split it across both the Active
        # and Archived tabs (they're meant to move as one unit; see
        # toggleArchiveFamily in app.js).
        archived=gc.archived,
    )
    session.add(new_gc)
    session.flush()  # assigns new_gc.id, needed below, without ending the transaction
    _log_generation_event(session, user.id, new_gc.id)

    # No open-link re-pointing needed here (unlike before phase 5): we
    # already checked above, and this instant-apply path only runs when
    # that check came back empty -- i.e. there is no open share link for
    # this document to move forward. Once one exists, every direct edit
    # takes the queued-for-approval branch above instead.

    session.commit()
    session.refresh(new_gc)
    return {"id": new_gc.id, "name": new_gc.name}


@app.get("/api/generated/{generated_id}/download")
def download_generated(generated_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    gc = _get_owned_generated(session, user, generated_id)
    if not os.path.exists(gc.file_path):
        raise HTTPException(410, "This file is no longer available.")
    safe_name = re.sub(r"[^A-Za-z0-9 _\-]+", "", gc.name).strip() or "contract"
    return FileResponse(
        gc.file_path,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=f"{safe_name}.docx",
    )


class ArchiveBody(BaseModel):
    archived: bool


@app.post("/api/generated/{generated_id}/archive")
def set_archived(
    generated_id: int,
    body: ArchiveBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    gc = _get_owned_generated(session, user, generated_id)
    gc.archived = body.archived
    session.add(gc)

    # Archiving is meant to take a document out of active circulation.
    # Without also closing its share link, a client could keep submitting
    # redlines against an "archived" document, and if the owner later
    # applied them, the new revision would come back un-archived (see
    # apply_redline_submission's archived=gc.archived above) -- silently
    # reviving the document and splitting its family across both the
    # Active and Archived tabs, which the product otherwise keeps moving
    # together as one unit (see toggleArchiveFamily in app.js). Matched
    # against the whole lineage family, not just this exact revision,
    # since the link's live pointer may currently sit on a different
    # (e.g. newer) revision in the same family. Un-archiving deliberately
    # does NOT reopen a closed link -- that would be a surprising side
    # effect the owner didn't ask for.
    if body.archived:
        family_ids = _lineage_doc_ids(gc, session)
        open_links = session.exec(
            select(ShareLink).where(
                ShareLink.generated_contract_id.in_(family_ids),
                ShareLink.status == "open",
            )
        ).all()
        for link in open_links:
            link.status = "closed"
            session.add(link)

    session.commit()
    return {"id": gc.id, "archived": gc.archived}


@app.delete("/api/generated/{generated_id}")
def delete_generated_forever(generated_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    gc = _get_owned_generated(session, user, generated_id)

    # Bug tracker #46: this was a true hard delete of the GeneratedContract
    # row and its file, but never touched any ShareLink still pointing at
    # it (or that link's RedlineSubmission/RedlineEdit/RedlineComment
    # history). The link stayed "open" against a generated_contract_id that
    # no longer existed -- a client with a still-valid share session could
    # keep posting comments into that void: the write silently succeeded,
    # the owner notification silently no-op'd (its owner lookup came back
    # None), and there was no way for the owner to ever see it, even though
    # "permanently delete... cannot be undone" implied the whole thing was
    # gone. Scoped to links whose CURRENT pointer is this exact document --
    # not the whole lineage family the way archive/create_share_link/
    # close_share_link match -- so deleting one old revision doesn't tear
    # down an unrelated, still-open negotiation that's live on a surviving
    # sibling revision in the same family.
    dangling_links = session.exec(
        select(ShareLink).where(ShareLink.generated_contract_id == gc.id)
    ).all()
    if dangling_links:
        link_ids = [link.id for link in dangling_links]
        submissions = session.exec(
            select(RedlineSubmission).where(RedlineSubmission.share_link_id.in_(link_ids))
        ).all()
        submission_ids = [s.id for s in submissions]
        if submission_ids:
            edits = session.exec(select(RedlineEdit).where(RedlineEdit.submission_id.in_(submission_ids))).all()
            edit_ids = [e.id for e in edits]
            if edit_ids:
                for comment in session.exec(select(RedlineComment).where(RedlineComment.edit_id.in_(edit_ids))).all():
                    session.delete(comment)
            for edit in edits:
                session.delete(edit)
            for sub in submissions:
                session.delete(sub)
        for view in session.exec(select(ShareLinkView).where(ShareLinkView.share_link_id.in_(link_ids))).all():
            session.delete(view)
        for link in dangling_links:
            session.delete(link)

    # Same class of gap #46 fixed for ShareLink: a SigningRequest pointing at
    # this exact document must not survive a hard delete of it. Scoped to
    # this exact generated_id, matching how SigningRequest itself is scoped
    # (see its model docstring) -- a hard delete of one revision shouldn't
    # touch an in-flight signature request on a different revision.
    signing_requests = session.exec(
        select(SigningRequest).where(SigningRequest.generated_contract_id == gc.id)
    ).all()
    for sr in signing_requests:
        if sr.status == "pending":
            try:
                ds.archive_submission(sr.docuseal_submission_id)
            except (RuntimeError, httpx.HTTPStatusError, httpx.RequestError):
                pass  # best-effort -- the local rows are deleted either way, below
        for signer in session.exec(
            select(SigningRequestSigner).where(SigningRequestSigner.signing_request_id == sr.id)
        ).all():
            if signer.photo_path and os.path.exists(signer.photo_path):
                try:
                    os.remove(signer.photo_path)
                except OSError:
                    pass
            session.delete(signer)
        if sr.signed_file_path and os.path.exists(sr.signed_file_path):
            try:
                os.remove(sr.signed_file_path)
            except OSError:
                pass
        session.delete(sr)

    if gc.file_path and os.path.exists(gc.file_path):
        try:
            os.remove(gc.file_path)
        except OSError:
            pass
    session.delete(gc)
    session.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Redlining: share a generated contract for client review
# ---------------------------------------------------------------------------

def _share_link_payload(link: ShareLink) -> dict:
    return {
        "token": link.token,
        "access_code": link.access_code,
        "client_email": link.client_email,
        "client_first_name": link.client_first_name,
        "client_last_name": link.client_last_name,
        "sender_email": link.sender_email,
        "url": f"/share/{link.token}",
        "status": link.status,
        "created_at": link.created_at.isoformat(),
        "last_viewed_at": link.last_viewed_at.isoformat() if link.last_viewed_at else None,
    }


def _generate_access_code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(8))


def _comment_payload(c: RedlineComment) -> dict:
    return {
        "id": c.id, "author_type": c.author_type, "author_name": c.author_name,
        "body": c.body, "created_at": c.created_at.isoformat(),
    }


def _comments_by_edit(session: Session, edit_ids: list) -> dict:
    """Batch-fetches every comment for a set of edits in one query, grouped
    by edit_id -- called once per redlines-view request (get_redlines,
    get_share_redlines) instead of once per edit, so a round with N edits
    doesn't cost N+1 queries."""
    if not edit_ids:
        return {}
    comments = session.exec(
        select(RedlineComment).where(RedlineComment.edit_id.in_(edit_ids)).order_by(RedlineComment.created_at)
    ).all()
    out = {}
    for c in comments:
        out.setdefault(c.edit_id, []).append(_comment_payload(c))
    return out


def _source_summaries_by_id(session: Session, source_ids: list) -> dict:
    """Batch-fetches a short preview of every RedlineEdit referenced by
    another edit's `source_edit_id` -- see that field's docstring for the
    two things it can mean (a client responding to a counter, or an owner
    reconsideration). Keyed by the SOURCE edit's own id so callers can look
    up `e.source_edit_id` directly; used to render a "responds to ..." note
    in the owner and client redline views instead of leaving the chain
    invisible (bug tracker #20)."""
    ids = [i for i in set(source_ids) if i]
    if not ids:
        return {}
    sources = session.exec(select(RedlineEdit).where(RedlineEdit.id.in_(ids))).all()
    return {
        s.id: {
            "id": s.id, "label": s.label, "proposed_value": s.proposed_value,
            "counter_value": s.counter_value, "decision": s.decision,
        }
        for s in sources
    }


def _send_share_created_email(request: Request, user: User, gc: GeneratedContract, link: ShareLink) -> None:
    """Lets the client know a document is waiting for them the moment a
    NEW share link is created (never re-sent on later visits to the Share
    modal -- see create_share_link, this only runs on the branch that
    actually inserts a new ShareLink row). Includes the link and access
    code directly in the body rather than making them go find it separately
    -- see the redline-negotiation overhaul notes: it's their own email
    address, on file because we now require it, so this is no less safe
    than any other "here's your access code" email."""
    sender_name = user.name.strip() or user.email
    share_url = f"{_base_url(request)}/share/{link.token}"
    body = (
        f"Hi {link.client_first_name},\n\n"
        f'{sender_name} shared a document with you to review: "{gc.name}".\n\n'
        f"Open it here:\n{share_url}\n\n"
        f"Access code: {link.access_code}\n\n"
        "You can review it, suggest changes, and send them back right from that page -- no account needed.\n\n"
        "- Rotely"
    )
    try:
        ee.send_email(
            link.client_email, f'{sender_name} shared "{gc.name}" with you for review', body,
            reply_to=(link.sender_email.strip() or user.email),
        )
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured yet -- the link still works, just wasn't emailed


def _send_reconsideration_email(
    request: Request, user: User, gc: GeneratedContract, link: ShareLink, edit: "RedlineEdit"
) -> None:
    """One email per owner reconsideration round (bug tracker #19) -- the
    owner changed their mind on a single already-decided edit and it's
    going out as its own scoped round rather than resurfacing the whole
    original submission (see reconsider_redline_edit). Deliberately not a
    bell/in-app notification -- clients have no account or notification
    center, email is the only channel that reaches them at all, unlike the
    bell-only comment-thread notifications in phase 2 which are for the
    OWNER's side."""
    sender_name = user.name.strip() or user.email
    share_url = f"{_base_url(request)}/share/{link.token}"
    outcome = (
        f'countered with: "{edit.counter_value}"' if edit.decision == "countered"
        else f"now {edit.decision}"
    )
    body = (
        f"Hi {link.client_first_name},\n\n"
        f'{sender_name} updated an earlier decision on "{gc.name}": '
        f'"{edit.label}" is {outcome}.\n\n'
        f"Open it here:\n{share_url}\n\n"
        f"Access code: {link.access_code}\n\n"
        "- Rotely"
    )
    try:
        ee.send_email(
            link.client_email, f'{sender_name} updated a decision on "{gc.name}"', body,
            reply_to=(link.sender_email.strip() or user.email),
        )
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured yet -- the reconsideration still applies, just wasn't emailed
    except (httpx.HTTPStatusError, httpx.RequestError):
        # Bug tracker #33: a legacy share link (created before client email
        # was required) can have link.client_email == "" -- SendGrid then
        # rejects the send with a 4xx, which used to propagate as an
        # unhandled exception AFTER the reconsideration was already
        # committed, so the owner saw a 500 for a change that actually
        # went through. Same "still applies, just wasn't emailed" handling
        # as the RuntimeError case above, now covering a real send failure
        # too, not just missing config.
        pass


def _send_owner_edit_email(
    request: Request, user: User, gc: GeneratedContract, link: ShareLink, edits: "list[RedlineEdit]"
) -> None:
    """One email per batch of owner direct edits made after a document is
    shared (bug tracker #23, phase 5; extended to whole batches once direct
    edits could be staged and sent together -- see DirectEditsBody) -- the
    owner edited the shared document directly, and instead of applying
    instantly (the pre-share behavior, still used when there's no open
    link) the whole batch is queued as one round of client-approvable
    redlines, each arriving already in the "countered" state -- see
    RedlineSubmission.origin == "owner_edit" and edit_generated_document.
    The client needs to know changes are waiting on them the same way
    they'd need to know about a counter to their own redline; email is the
    only channel that reaches them at all (no account, no notification
    center), same reasoning as _send_reconsideration_email above."""
    sender_name = user.name.strip() or user.email
    share_url = f"{_base_url(request)}/share/{link.token}"
    if len(edits) == 1:
        subject = f'{sender_name} made a change to "{gc.name}"'
        intro = f'{sender_name} made a change to "{gc.name}" for you to review: "{edits[0].label}" → "{edits[0].counter_value}".'
    else:
        subject = f'{sender_name} made {len(edits)} changes to "{gc.name}"'
        change_lines = "\n".join(f'- "{e.label}" → "{e.counter_value}"' for e in edits)
        intro = f'{sender_name} made {len(edits)} changes to "{gc.name}" for you to review:\n\n{change_lines}'
    body = (
        f"Hi {link.client_first_name},\n\n"
        f"{intro}\n\n"
        f"Open it here:\n{share_url}\n\n"
        f"Access code: {link.access_code}\n\n"
        "- Rotely"
    )
    try:
        ee.send_email(link.client_email, subject, body, reply_to=(link.sender_email.strip() or user.email))
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured yet -- the edits still queue, just weren't emailed
    except (httpx.HTTPStatusError, httpx.RequestError):
        # Bug tracker #33: see the identical comment in
        # _send_reconsideration_email -- a legacy link's blank client_email
        # made SendGrid reject the send, which used to blow up as an
        # unhandled exception after the edits were already committed.
        pass


def _send_response_email(
    request: Request, user: User, gc: GeneratedContract, link: ShareLink, edits: "list[RedlineEdit]"
) -> None:
    """One email per owner response to a client's redline round (bug
    tracker #31) -- respond_to_submission batches the owner's accept/
    reject/counter calls and used to just commit them with no notification
    at all, even though the client has no account and no other way to find
    out their round was answered (same reasoning as _send_reconsideration_
    email and _send_owner_edit_email, which is why this mirrors their
    shape almost exactly)."""
    sender_name = user.name.strip() or user.email
    share_url = f"{_base_url(request)}/share/{link.token}"

    def _outcome(e: "RedlineEdit") -> str:
        if e.decision == "countered":
            return f'countered with "{e.counter_value}"'
        return str(e.decision)

    if len(edits) == 1:
        subject = f'{sender_name} responded to your redline on "{gc.name}"'
        intro = f'{sender_name} responded to your suggested change on "{gc.name}": "{edits[0].label}" is {_outcome(edits[0])}.'
    else:
        subject = f'{sender_name} responded to your redlines on "{gc.name}"'
        change_lines = "\n".join(f'- "{e.label}" is {_outcome(e)}' for e in edits)
        intro = f'{sender_name} responded to your suggested changes on "{gc.name}":\n\n{change_lines}'
    body = (
        f"Hi {link.client_first_name},\n\n"
        f"{intro}\n\n"
        f"Open it here:\n{share_url}\n\n"
        f"Access code: {link.access_code}\n\n"
        "- Rotely"
    )
    try:
        ee.send_email(link.client_email, subject, body, reply_to=(link.sender_email.strip() or user.email))
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured yet -- the response still applies, just wasn't emailed
    except (httpx.HTTPStatusError, httpx.RequestError):
        pass  # bug tracker #33 -- see _send_reconsideration_email's identical comment


def _find_open_share_link(session: Session, gc: GeneratedContract) -> Optional["ShareLink"]:
    """The account's existing open share link for gc's whole lineage
    family, if any -- factored out of create_share_link so a read-only
    caller (see get_share_link_info below) can look this up without that
    endpoint's side effect of creating a brand-new link when none exists."""
    return session.exec(
        select(ShareLink)
        .where(ShareLink.generated_contract_id.in_(_lineage_doc_ids(gc, session)), ShareLink.status == "open")
        .order_by(ShareLink.created_at.desc())
    ).first()


@app.get("/api/generated/{generated_id}/share-link")
def get_share_link_info(
    generated_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Read-only: does this document already have an open share link, and
    if so, what client/sender identity is on file for it? Added so other
    flows that need the same person's name/email -- right now just the
    signature-request modal -- can prefill from it instead of asking from
    scratch. Friction audit: the signature modal previously had no way to
    know a client's name and email were already collected (in a different
    shape -- first/last split here, one combined field there) at share-link
    time for this exact document, and always asked again from zero."""
    gc = _get_owned_generated(session, user, generated_id)
    link = _find_open_share_link(session, gc)
    if not link:
        return {"exists": False}
    return {
        "exists": True,
        "client_first_name": link.client_first_name,
        "client_last_name": link.client_last_name,
        "client_email": link.client_email,
        "sender_email": link.sender_email,
    }


class CreateShareBody(BaseModel):
    client_email: str = ""
    client_first_name: str = ""
    client_last_name: str = ""
    # Optional override for what the client sees as the sender's contact
    # email -- falls back to the account's own login email when blank.
    sender_email: str = ""


@app.post("/api/generated/{generated_id}/share")
def create_share_link(
    generated_id: int,
    request: Request,
    body: CreateShareBody = CreateShareBody(),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Returns the account's existing open share link for this document if
    there is one, otherwise creates a new one with a fresh access code.

    Creating a brand-new link requires the client's first name, last name,
    and a valid email -- previously all three were optional, but a named,
    attributed reviewer is now load-bearing for the redline comment thread
    (see RedlineComment) and will be for e-signature down the line, so it's
    collected up front instead of being backfilled later. This does NOT
    apply to an already-existing link: re-calling this (as the Share modal
    does on open, to fetch the current link) only ever *updates* fields
    that were actually re-supplied, exactly as before, so an existing link
    from before this requirement stays valid even if it's missing one of
    these -- nothing here forces every old link to be fixed up."""
    gc = _get_owned_generated(session, user, generated_id)
    client_email = body.client_email.strip()[:200]
    client_first_name = body.client_first_name.strip()[:100]
    client_last_name = body.client_last_name.strip()[:100]
    sender_email = body.sender_email.strip()[:200]
    # Matched against the whole lineage family (bug tracker #28), not just
    # this exact revision's id -- otherwise sharing from a revision the
    # link isn't currently pointed at (e.g. an older one reached through
    # history) would miss the family's real open link and create a second,
    # simultaneously-open one that close_share_link's own exact-id lookup
    # could never fully close either.
    existing = _find_open_share_link(session, gc)
    if existing:
        changed = False
        if existing.generated_contract_id != gc.id:
            # Repoint FORWARD only -- never backward. This endpoint is also
            # what the Share modal calls (with no client fields) just to
            # fetch/display the current link whenever it's opened, and the
            # modal is reachable from ANY revision's detail panel, including
            # an older one sitting in the document's history. Repointing
            # unconditionally here (as an earlier version of this fix did)
            # meant simply *opening* the Share modal from an old revision --
            # not even submitting anything -- silently dragged a link a
            # client might be mid-negotiation on backward to a stale
            # document, with no "updated since your last visit" flag either
            # (unlike apply_redline_submission's own forward-repoint, which
            # is safe by construction since its new revision is always the
            # newest). Only move the pointer if gc is actually at least as
            # new as whatever the link currently targets.
            current_target = session.get(GeneratedContract, existing.generated_contract_id)
            if current_target is None or gc.created_at >= current_target.created_at:
                existing.generated_contract_id = gc.id
                changed = True
        if client_email and client_email != existing.client_email:
            existing.client_email = client_email
            changed = True
        if client_first_name and client_first_name != existing.client_first_name:
            existing.client_first_name = client_first_name
            changed = True
        if client_last_name and client_last_name != existing.client_last_name:
            existing.client_last_name = client_last_name
            changed = True
        if sender_email != existing.sender_email:
            existing.sender_email = sender_email
            changed = True
        if changed:
            session.add(existing)
            session.commit()
            session.refresh(existing)
        return _share_link_payload(existing)

    if not (client_email and client_first_name and client_last_name):
        raise HTTPException(400, "Enter the client's first name, last name, and email before creating a share link.")
    if not _EMAIL_ADDR_RE.fullmatch(client_email):
        raise HTTPException(400, "That doesn't look like a valid email address.")

    link = ShareLink(
        generated_contract_id=gc.id, token=secrets.token_urlsafe(16), access_code=_generate_access_code(),
        client_email=client_email, client_first_name=client_first_name, client_last_name=client_last_name,
        sender_email=sender_email,
    )
    session.add(link)
    session.commit()
    session.refresh(link)
    _send_share_created_email(request, user, gc, link)
    return _share_link_payload(link)


@app.post("/api/generated/{generated_id}/share/close")
def close_share_link(
    generated_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    gc = _get_owned_generated(session, user, generated_id)
    # Matched (and closed) across the whole lineage family (bug tracker
    # #28), not just this exact revision's id -- otherwise closing from a
    # revision the link isn't currently pointed at would 404 with an open
    # link still live elsewhere in the family, and a pre-existing second
    # open link (from before create_share_link's own #28 fix) could never
    # be closed at all through this endpoint. Closes every open link found,
    # not just the newest, so "close" really means closed.
    links = session.exec(
        select(ShareLink)
        .where(ShareLink.generated_contract_id.in_(_lineage_doc_ids(gc, session)), ShareLink.status == "open")
    ).all()
    if not links:
        raise HTTPException(404, "No open review link for this document.")
    for link in links:
        link.status = "closed"
        session.add(link)
    session.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# E-signature: send a finished document out through DocuSeal for signing.
#
# Scope for v1 (see the project's e-signature design notes for the fuller
# reasoning): exactly two possible roles, "Client" (always) and "Sender"
# (the account owner's own business, optional, off by default) -- not an
# arbitrary signer list. Before a signer ever sees DocuSeal's own signing
# form, they land on Rotely's own /sign/{token} page, where they explicitly
# consent and a photo is captured -- see SigningRequestSigner's model
# docstring for why that's a deterrent/record, not identity verification.
# Real completion state is driven entirely by DocuSeal's webhook (verified
# via HMAC, see docuseal_engine.verify_webhook_signature), never by the
# browser's own `completed` event, per DocuSeal's own security guidance.
# ---------------------------------------------------------------------------

_SIGNATURE_ROLES = ("Client", "Sender")


def _signing_request_payload(sr: SigningRequest, signers: list) -> dict:
    return {
        "id": sr.id,
        "status": sr.status,
        "created_at": sr.created_at.isoformat(),
        "completed_at": sr.completed_at.isoformat() if sr.completed_at else None,
        "signed_document_available": bool(sr.signed_file_path and os.path.exists(sr.signed_file_path)),
        # Bug tracker #55: lets the frontend nudge the owner to actually set
        # up DocuSeal's webhook (nothing in the app did this before) --
        # without it, "pending" never updates on its own and the only way
        # to notice a document is actually done is the manual refresh
        # button, forever.
        "webhook_configured": bool(ds.DOCUSEAL_WEBHOOK_SECRET),
        "signers": [
            {
                "role": s.role,
                "name": s.name,
                "email": s.email,
                "status": s.status,
                "sign_url": f"/sign/{s.token}",
                "consent_given_at": s.consent_given_at.isoformat() if s.consent_given_at else None,
                "completed_at": s.completed_at.isoformat() if s.completed_at else None,
                "has_photo": bool(s.photo_path),
            }
            for s in signers
        ],
    }


def _send_signature_request_email(request: Request, user: User, gc: GeneratedContract, signer: SigningRequestSigner) -> None:
    sender_name = user.name.strip() or user.email
    sign_url = f"{_base_url(request)}/sign/{signer.token}"
    first_name = signer.name.split(" ")[0] if signer.name else "there"
    body = (
        f"Hi {first_name},\n\n"
        f'{sender_name} sent you "{gc.name}" to sign.\n\n'
        f"Open it here:\n{sign_url}\n\n"
        "You'll be asked to agree to a quick photo step before signing -- this is "
        "part of the signing record, not a separate account or download.\n\n"
        "- Rotely"
    )
    try:
        ee.send_email(signer.email, f'{sender_name} sent you "{gc.name}" to sign', body)
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured yet -- the request still exists, just wasn't emailed
    except (httpx.HTTPStatusError, httpx.RequestError):
        pass  # matches bug tracker #33's handling elsewhere -- a bad address shouldn't break the request itself


def _send_signature_completed_email(user: User, gc: GeneratedContract) -> None:
    """Always paired with a _notify bell call at this function's one call
    site (_apply_submission_completed) -- see that function. Kept as its
    own helper rather than inlined since it's also referenced from the
    bug-tracker note on _notify's docstring."""
    body = f'Hi,\n\nEveryone has signed "{gc.name}". The signed document is in your Rotely documents library.\n\n- Rotely'
    try:
        ee.send_email(user.email, f'Fully signed: "{gc.name}"', body)
    except RuntimeError:
        pass
    except (httpx.HTTPStatusError, httpx.RequestError):
        pass


def _send_signature_declined_email(user: User, gc: GeneratedContract, signer_name: str = "") -> None:
    """Mirrors _send_signature_completed_email. Paired with a _notify bell
    call at each of this function's two call sites (_apply_signer_declined,
    _apply_submission_declined) -- see those functions' docstrings for why
    only one of the two ever actually fires this for a given request."""
    who = f"{signer_name} declined" if signer_name else "Someone declined"
    body = f'Hi,\n\n{who} to sign "{gc.name}". The signature request has been stopped -- you may want to follow up or send a new request.\n\n- Rotely'
    try:
        ee.send_email(user.email, f'Signing declined: "{gc.name}"', body)
    except RuntimeError:
        pass
    except (httpx.HTTPStatusError, httpx.RequestError):
        pass


@app.post("/api/documents/upload-for-signature")
def upload_document_for_signature(
    request: Request,
    name: str = Form(""),
    document_type: str = Form("Other"),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Lets an owner send a document out for signature without first
    building it through the draft/template flow -- e.g. a contract someone
    else drafted, or a one-off they don't want to turn into a reusable
    master document. Creates a GeneratedContract with template_id=None
    pointing straight at the uploaded file; that shape is already handled
    everywhere a GeneratedContract is touched (see edit_generated_document's
    gen_dir fallback and every `if gc.template_id else None` guard), so the
    existing send-for-signature flow, /sign/{token}, the DocuSeal webhook,
    and revision history all work on it completely unchanged."""
    if not file.filename.lower().endswith(".docx"):
        raise HTTPException(400, "Please upload a .docx file (Word format).")

    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_TEMPLATE_UPLOAD_BYTES:
                raise HTTPException(400, f"That file is too large -- uploads are limited to {MAX_TEMPLATE_UPLOAD_BYTES // (1024 * 1024)}MB.")
        except ValueError:
            pass  # malformed header -- fall through to the streaming check below

    display_name = (name.strip() or os.path.splitext(file.filename)[0]).strip()[:200] or "Uploaded document"
    doc_type = document_type.strip() or "Other"

    with _generation_lock_for(user.id):
        # Same quota accounting as every other path that creates a fresh
        # GeneratedContract (see _log_generation_event's docstring) --
        # otherwise this would be a quota-free side door around the plan
        # limit that generate_contract and the inbound-email draft path
        # both enforce.
        plan = _plan_info(session, user)
        if plan["limit"] is not None and plan["used"] >= plan["limit"]:
            raise HTTPException(
                402,
                f"You have used all {plan['limit']} contracts included in your {user.plan} plan this month. "
                f"Upgrade your plan to draft more.",
            )

        up_dir = os.path.join(UPLOADS_DIR, str(user.id), "direct_uploads")
        os.makedirs(up_dir, exist_ok=True)
        out_path = os.path.join(up_dir, f"{secrets.token_hex(8)}.docx")
        written = 0
        try:
            with open(out_path, "wb") as f:
                while True:
                    chunk = file.file.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_TEMPLATE_UPLOAD_BYTES:
                        raise HTTPException(400, f"That file is too large -- uploads are limited to {MAX_TEMPLATE_UPLOAD_BYTES // (1024 * 1024)}MB.")
                    f.write(chunk)
            de.validate_docx_archive(out_path)  # zip-bomb check, before anything is decompressed
            de.load(out_path)  # fail fast on a corrupt/non-docx upload, not later inside docx_engine or DocuSeal
        except HTTPException:
            try:
                os.remove(out_path)
            except OSError:
                pass
            raise
        except de.UnsafeDocx as e:
            try:
                os.remove(out_path)
            except OSError:
                pass
            raise HTTPException(400, str(e))
        except Exception:
            try:
                os.remove(out_path)
            except OSError:
                pass
            raise HTTPException(400, "Couldn't read that file as a Word document. Make sure it's a valid, uncorrupted .docx.")

        gc = GeneratedContract(
            owner_id=user.id,
            template_id=None,
            template_name="Uploaded document",
            document_type=doc_type,
            name=display_name,
            file_path=out_path,
            values_json="[]",
            field_positions_json="[]",
            parties_json="[]",
        )
        session.add(gc)
        session.flush()
        _log_generation_event(session, user.id, gc.id)
        session.commit()
        session.refresh(gc)

    return {
        "generated_id": gc.id,
        "name": gc.name,
        "document_type": gc.document_type,
        "plan": _plan_info(session, user),
    }


class SignatureBuilderTokenBody(BaseModel):
    # Which roles should exist in the field-designer embed -- set from the
    # intake step's own choice of whether a sender signature is included,
    # so the builder never offers a role the actual submission won't have
    # a signer for (DocuSeal requires a submitter for every role that has
    # fields assigned to it). Always includes "Client"; "Sender" only if
    # the frontend's "also require a signature from your side" is checked.
    include_sender: bool = False


@app.post("/api/generated/{generated_id}/signature-builder-token")
def get_signature_builder_token(
    generated_id: int,
    body: SignatureBuilderTokenBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Mints what the frontend's <docuseal-builder> embed needs to let the
    owner visually drag signature/text/date/etc. fields onto this exact
    document and assign each to a role -- the Google-eSign-style
    replacement for blindly embedding a signature block at a detected or
    appended spot (docx_engine.append_signature_block/
    detect_signature_anchor_paragraph are now only reached as a fallback;
    see create_signature_request below).

    Creates a DocuSeal template from gc's current file the first time this
    is called for a given file content, and caches the template id +
    content hash on the GeneratedContract row so reopening the designer
    for the same, unchanged document keeps editing the same fields instead
    of starting over blank. A document edited since the last call gets a
    fresh template (and, implicitly, a clean slate of fields) rather than
    silently reusing one positioned against stale content."""
    gc = _get_owned_generated(session, user, generated_id)
    if not gc.file_path or not os.path.exists(gc.file_path):
        raise HTTPException(404, "This document's file is missing on disk.")

    with open(gc.file_path, "rb") as f:
        file_bytes = f.read()
    doc_hash = hashlib.sha256(file_bytes).hexdigest()

    if gc.docuseal_template_id and gc.docuseal_template_doc_hash == doc_hash:
        template_id = gc.docuseal_template_id
    else:
        try:
            template = ds.create_template_from_docx(name=gc.name, file_bytes=file_bytes, file_name=f"{gc.name}.docx")
        except RuntimeError as e:
            raise HTTPException(400, str(e))  # DOCUSEAL_API_KEY not configured
        except httpx.HTTPStatusError as e:
            detail = "DocuSeal rejected this request."
            if e.response.status_code in (401, 403):
                detail = "DocuSeal rejected the API key. Check DOCUSEAL_API_KEY."
            elif e.response.status_code == 422:
                detail = "DocuSeal couldn't process this document. Creating templates from DOCX requires a Pro/Cloud Sandbox DocuSeal plan."
            raise HTTPException(502, detail)
        except httpx.RequestError:
            raise HTTPException(502, "Couldn't reach DocuSeal. Try again in a moment.")
        template_id = template["id"]
        gc.docuseal_template_id = template_id
        gc.docuseal_template_doc_hash = doc_hash
        session.add(gc)
        session.commit()

    roles = ["Client", "Sender"] if body.include_sender else ["Client"]
    try:
        token = ds.mint_builder_token(template_id=template_id, name=gc.name)
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    return {"template_id": template_id, "token": token, "roles": roles}


class CreateSignatureRequestBody(BaseModel):
    client_name: str
    client_email: str
    include_sender: bool = False
    sender_name: str = ""
    sender_email: str = ""
    # Where to splice the signature fields in -- a paragraph index into the
    # document's top-level body, counted the same way render_paragraphs_html's
    # data-p attribute counts (see docx_engine.detect_signature_anchor_paragraph
    # and append_signature_block). The frontend no longer ever sends this --
    # it's only reached by the legacy fallback path inside
    # create_signature_request, for a document that was never run through
    # the DocuSeal Form Builder (or whose template went stale). None (the
    # default, and also what an out-of-range/stale index falls back to)
    # means "append a new signature block at the very end", matching the
    # original, always-safe behavior from before the builder existed.
    signature_anchor_paragraph_index: Optional[int] = None


@app.post("/api/generated/{generated_id}/signature-request")
def create_signature_request(
    generated_id: int,
    body: CreateSignatureRequestBody,
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Sends gc's exact current file out through DocuSeal for signing.
    Scoped to this exact GeneratedContract id, not its lineage family --
    unlike ShareLink, a new revision never silently repoints an in-flight
    signature request; sending a later revision for signature is its own
    new request. Refuses if one is already pending for this exact
    document, since DocuSeal already has a live submission for it.

    Bug tracker #51: the whole check-through-create sequence below runs
    under a per-document lock (_signature_request_lock_for) -- without it,
    two genuinely concurrent sends for the same document could both pass
    the "already pending?" check and both create a live SigningRequest +
    DocuSeal submission, and only the newest one is ever visible/
    cancelable afterward (see get_signature_request/cancel_signature_
    request, which both only look at one row). Reproduced live pre-fix.

    Uses gc's DocuSeal template (visually field-placed via
    get_signature_builder_token) when one exists and still matches the
    document's current content -- this is the normal path now. Falls back
    to the original blind text-tag/anchor-detection embedding
    (docx_engine.append_signature_block) only when no such template
    exists yet or the document changed since it was built, so a document
    sent without ever opening the field designer still works exactly as
    before rather than erroring out."""
    with _signature_request_lock_for(generated_id):
        gc = _get_owned_generated(session, user, generated_id)

        existing = session.exec(
            select(SigningRequest)
            .where(SigningRequest.generated_contract_id == gc.id, SigningRequest.status == "pending")
        ).first()
        if existing:
            raise HTTPException(400, "A signature request is already pending for this document. Cancel it first to send a new one.")

        client_name = body.client_name.strip()[:200]
        client_email = body.client_email.strip()[:200]
        if not client_name or not client_email:
            raise HTTPException(400, "Enter the client's name and email.")
        if not _EMAIL_ADDR_RE.fullmatch(client_email):
            raise HTTPException(400, "That doesn't look like a valid client email address.")

        signer_specs = [{"role": "Client", "name": client_name, "email": client_email}]
        if body.include_sender:
            sender_name = body.sender_name.strip()[:200] or user.name.strip() or user.email
            sender_email = body.sender_email.strip()[:200] or user.email
            if not _EMAIL_ADDR_RE.fullmatch(sender_email):
                raise HTTPException(400, "That doesn't look like a valid sender email address.")
            # Bug tracker #52: DocuSeal addresses submitters by email, so two
            # signer_specs sharing one email collapse into a single DocuSeal
            # submitter -- by_email below (keyed on email) can then only
            # ever resolve one of the two local SigningRequestSigner rows to
            # a real docuseal_submitter_id, leaving the other permanently
            # stuck with no submitter behind it. Reject this combination
            # upfront instead of letting it reach DocuSeal.
            if sender_email.lower() == client_email.lower():
                raise HTTPException(400, "The client and sender can't use the same email address -- each signer needs a distinct address so DocuSeal can track them separately.")
            signer_specs.append({"role": "Sender", "name": sender_name, "email": sender_email})

        if not gc.file_path or not os.path.exists(gc.file_path):
            raise HTTPException(404, "This document's file is missing on disk and can't be sent for signature.")

        # Use the template the owner visually placed fields on in the
        # DocuSeal Form Builder (see get_signature_builder_token above) as
        # long as it was built from this EXACT file content -- a stale
        # template (document edited since fields were placed) falls back
        # to the old blind-append path below instead of sending out fields
        # positioned against content that no longer matches.
        with open(gc.file_path, "rb") as f:
            current_hash = hashlib.sha256(f.read()).hexdigest()
        use_template = bool(gc.docuseal_template_id) and gc.docuseal_template_doc_hash == current_hash

        prepped_path = None
        try:
            if use_template:
                raw_submitters = ds.create_submission_from_template(
                    template_id=gc.docuseal_template_id,
                    submitters=[{"role": s["role"], "email": s["email"], "name": s["name"]} for s in signer_specs],
                )
                if not raw_submitters:
                    raise HTTPException(502, "DocuSeal returned an empty response.")
                submission_id = raw_submitters[0]["submission_id"]
                submitters_list = raw_submitters
            else:
                sig_dir = os.path.join(UPLOADS_DIR, str(user.id), "signatures")
                os.makedirs(sig_dir, exist_ok=True)
                prepped_path = os.path.join(sig_dir, f"{gc.id}_{secrets.token_hex(6)}_for_signature.docx")
                de.append_signature_block(
                    gc.file_path, prepped_path,
                    [{"role": s["role"], "label": f'{s["name"]} ({s["role"]})'} for s in signer_specs],
                    anchor_paragraph_index=body.signature_anchor_paragraph_index,
                )
                with open(prepped_path, "rb") as f:
                    prepped_bytes = f.read()

                submitters_resp = ds.create_submission_from_docx(
                    name=gc.name,
                    file_bytes=prepped_bytes,
                    file_name=f"{gc.name}.docx",
                    submitters=[{"role": s["role"], "email": s["email"], "name": s["name"]} for s in signer_specs],
                )
                if not submitters_resp or not submitters_resp.get("submitters"):
                    raise HTTPException(502, "DocuSeal returned an empty response.")
                submission_id = submitters_resp["id"]
                submitters_list = submitters_resp["submitters"]
        except RuntimeError as e:
            raise HTTPException(400, str(e))  # DOCUSEAL_API_KEY not configured
        except httpx.HTTPStatusError as e:
            detail = "DocuSeal rejected this request."
            if e.response.status_code in (401, 403):
                detail = "DocuSeal rejected the API key. Check DOCUSEAL_API_KEY."
            elif e.response.status_code == 422:
                detail = "DocuSeal couldn't process this document for signing. Sending from DOCX requires a Pro/Cloud Sandbox DocuSeal plan."
            raise HTTPException(502, detail)
        except httpx.RequestError:
            raise HTTPException(502, "Couldn't reach DocuSeal. Try again in a moment.")
        finally:
            if prepped_path:
                try:
                    os.remove(prepped_path)
                except OSError:
                    pass

        sr = SigningRequest(generated_contract_id=gc.id, docuseal_submission_id=submission_id)
        session.add(sr)
        session.commit()
        session.refresh(sr)

        # Bug tracker #52: matched case-sensitively before -- if DocuSeal
        # echoes a submitter back with any different casing than what we
        # sent (e.g. it lowercases, or normalizes some other way), the
        # lookup below missed, that spec's `continue`d past silently, and
        # the request went out with one (or zero) SigningRequestSigner rows
        # instead of one per signer_spec. Email addresses aren't
        # case-sensitive in practice, so match on a normalized form instead
        # of the raw string DocuSeal happened to return.
        by_email = {item["email"].strip().lower(): item for item in submitters_list}
        signers = []
        for spec in signer_specs:
            item = by_email.get(spec["email"].strip().lower())
            if not item:
                continue  # shouldn't happen -- DocuSeal echoes back every submitter we sent
            signer = SigningRequestSigner(
                signing_request_id=sr.id,
                docuseal_submitter_id=item["id"],
                role=spec["role"],
                name=spec["name"],
                email=spec["email"],
                token=secrets.token_urlsafe(24),
                embed_src=item.get("embed_src", ""),
            )
            session.add(signer)
            signers.append(signer)
        session.commit()
        for signer in signers:
            session.refresh(signer)
            _send_signature_request_email(request, user, gc, signer)

        return _signing_request_payload(sr, signers)


@app.get("/api/generated/{generated_id}/signature-request")
def get_signature_request(
    generated_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    gc = _get_owned_generated(session, user, generated_id)
    sr = session.exec(
        select(SigningRequest)
        .where(SigningRequest.generated_contract_id == gc.id)
        .order_by(SigningRequest.created_at.desc())
    ).first()
    if not sr:
        return {"exists": False}
    signers = session.exec(
        select(SigningRequestSigner).where(SigningRequestSigner.signing_request_id == sr.id)
    ).all()
    return {"exists": True, **_signing_request_payload(sr, signers)}


@app.get("/api/generated/{generated_id}/signature-anchor-preview")
def get_signature_anchor_preview(
    generated_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Formerly backed the click-a-paragraph "where should the signature
    go?" picker shown before sending a document for signature. Superseded
    by the DocuSeal Form Builder embed (see get_signature_builder_token
    and app.js's renderFieldDesigner) -- the frontend no longer calls this
    route at all. Left in place (unused, not removed) since it's a plain
    read-only preview with no side effects and no harm in keeping it
    around; append_signature_block/detect_signature_anchor_paragraph still
    use the same anchor concept for the legacy fallback path in
    create_signature_request, so this isn't orphaned logic, just an
    orphaned frontend caller."""
    gc = _get_owned_generated(session, user, generated_id)
    if not gc.file_path or not os.path.exists(gc.file_path):
        raise HTTPException(404, "This document's file is missing on disk.")
    doc = de.load(gc.file_path)
    field_positions = json.loads(gc.field_positions_json or "[]")
    html_content = de.render_paragraphs_html(doc, field_positions)
    detected = de.detect_signature_anchor_paragraph(doc)
    return {"html": html_content, "detected_paragraph_index": detected}


@app.post("/api/generated/{generated_id}/signature-request/cancel")
def cancel_signature_request(
    generated_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    gc = _get_owned_generated(session, user, generated_id)
    sr = session.exec(
        select(SigningRequest)
        .where(SigningRequest.generated_contract_id == gc.id, SigningRequest.status == "pending")
    ).first()
    if not sr:
        raise HTTPException(404, "No pending signature request for this document.")
    try:
        ds.archive_submission(sr.docuseal_submission_id)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    except httpx.HTTPStatusError:
        raise HTTPException(502, "DocuSeal couldn't cancel this request. Try again.")
    except httpx.RequestError:
        raise HTTPException(502, "Couldn't reach DocuSeal. Try again in a moment.")
    sr.status = "cancelled"
    session.add(sr)
    session.commit()
    return {"ok": True}


@app.get("/api/generated/{generated_id}/signature-request/download")
def download_signed_document(
    generated_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    gc = _get_owned_generated(session, user, generated_id)
    sr = session.exec(
        select(SigningRequest)
        .where(SigningRequest.generated_contract_id == gc.id, SigningRequest.status == "completed")
        .order_by(SigningRequest.created_at.desc())
    ).first()
    if not sr or not sr.signed_file_path or not os.path.exists(sr.signed_file_path):
        raise HTTPException(404, "No signed document available for this document yet.")
    safe_name = re.sub(r"[^A-Za-z0-9 _-]", "", gc.name).strip() or "document"
    return FileResponse(sr.signed_file_path, filename=f"{safe_name} (signed).pdf", media_type="application/pdf")


def _get_signer_or_404(session: Session, token: str) -> SigningRequestSigner:
    signer = session.exec(select(SigningRequestSigner).where(SigningRequestSigner.token == token)).first()
    if not signer:
        raise HTTPException(404, "Signing link not found.")
    return signer


@app.get("/api/sign/{token}")
def get_sign_status(token: str, session: Session = Depends(get_session)):
    """Public (no account) -- mirrors GET /api/share/{token}'s no-login
    model. The DocuSeal embed URL is only ever included once consent has
    actually been recorded (status != awaiting_consent); until then, the
    client literally cannot reach DocuSeal's signing form through this
    page, which is the whole point of gating it here first."""
    signer = _get_signer_or_404(session, token)
    sr = session.get(SigningRequest, signer.signing_request_id)
    gc = session.get(GeneratedContract, sr.generated_contract_id) if sr else None
    owner = session.get(User, gc.owner_id) if gc else None
    return {
        "document_name": gc.name if gc else "",
        "sender_name": (owner.name.strip() or owner.email) if owner else "",
        "signer_name": signer.name,
        "role": signer.role,
        "status": signer.status,
        "request_status": sr.status if sr else "",
        "embed_src": signer.embed_src if signer.status != "awaiting_consent" else None,
    }


class SignConsentBody(BaseModel):
    consent: bool = False
    photo: str = ""  # data URL, e.g. "data:image/jpeg;base64,...."


_MAX_CONSENT_PHOTO_BYTES = 8 * 1024 * 1024  # 8MB -- generous for a browser-captured selfie, matches the spirit of #15's upload cap


@app.post("/api/sign/{token}/consent")
def submit_sign_consent(token: str, body: SignConsentBody, session: Session = Depends(get_session)):
    """Records consent + a photo, then (and only then) unlocks the actual
    DocuSeal signing form for this signer -- see get_sign_status. Does
    nothing to the signature itself; the photo is a record stored
    alongside the request, not sent to or checked by DocuSeal."""
    signer = _get_signer_or_404(session, token)
    if signer.status != "awaiting_consent":
        raise HTTPException(400, "You've already completed this step.")
    sr = session.get(SigningRequest, signer.signing_request_id)
    if not sr or sr.status != "pending":
        # Bug tracker #53: cancelling, expiring, or declining a
        # SigningRequest only ever updated sr.status (and, for a decline,
        # whichever signer actually declined) -- every OTHER signer on the
        # same request was left sitting at "awaiting_consent" forever, so
        # this endpoint kept accepting their consent + photo and handing
        # back an embed_src for a DocuSeal submission that was already
        # archived/expired/declined: a dead signing link that looked live.
        # Checking the parent request's own status here closes that.
        raise HTTPException(400, "This signature request is no longer active, so this link can't be used.")
    if not body.consent:
        raise HTTPException(400, "You must agree to continue.")
    if not body.photo or "," not in body.photo:
        raise HTTPException(400, "A photo is required before continuing.")

    header, _, b64data = body.photo.partition(",")
    try:
        photo_bytes = base64.b64decode(b64data, validate=True)
    except ValueError:
        raise HTTPException(400, "That photo couldn't be read. Try again.")
    if not photo_bytes:
        raise HTTPException(400, "That photo couldn't be read. Try again.")
    if len(photo_bytes) > _MAX_CONSENT_PHOTO_BYTES:
        raise HTTPException(400, "That photo is too large.")

    gc = session.get(GeneratedContract, sr.generated_contract_id)
    owner_id = gc.owner_id if gc else 0
    photo_dir = os.path.join(UPLOADS_DIR, str(owner_id), "signatures", str(signer.signing_request_id))
    os.makedirs(photo_dir, exist_ok=True)
    ext = "png" if "image/png" in header else "jpg"
    photo_path = os.path.join(photo_dir, f"signer_{signer.id}_consent.{ext}")
    with open(photo_path, "wb") as f:
        f.write(photo_bytes)

    signer.consent_given_at = datetime.utcnow()
    signer.photo_path = photo_path
    signer.photo_captured_at = datetime.utcnow()
    signer.status = "ready_to_sign"
    session.add(signer)
    session.commit()
    return {"ok": True, "embed_src": signer.embed_src}


# ---------------------------------------------------------------------------
# Bug tracker #55: these four _apply_* functions are the webhook handler's
# state-transition logic, pulled out so the new manual refresh endpoint
# below (_reconcile_signature_request_from_docuseal) can apply the exact
# same transitions after polling DocuSeal's API directly -- instead of a
# second, separately-maintained copy of this logic that could drift out of
# sync with what the webhook does. Every one of these is written to be
# safe to call more than once (each checks the current status before
# changing anything), since the refresh path may re-derive an event that
# the webhook already delivered, or vice versa.
# ---------------------------------------------------------------------------

def _apply_signer_completed(session: Session, submitter_id) -> None:
    """Marks one signer done. If anyone else on this same request still
    hasn't signed, this is the owner's only signal that something happened
    until the rest finish too -- bug tracker: this used to notify no one at
    all (no bell, no email) for every signer completion except possibly the
    very last one, which went out as email only via
    _apply_submission_completed. Bell only here, deliberately -- a mid-
    flight status update isn't worth an email (same reasoning as a redline
    comment). If this WAS the last pending signer, skip notifying here and
    let _apply_submission_completed's "fully signed" notification cover it
    instead, so a single-signer request (the common case) doesn't fire two
    separate notifications for what is, from the owner's point of view, one
    event."""
    signer = session.exec(
        select(SigningRequestSigner).where(SigningRequestSigner.docuseal_submitter_id == submitter_id)
    ).first()
    if signer and signer.status != "completed":
        signer.status = "completed"
        signer.completed_at = datetime.utcnow()
        session.add(signer)
        session.commit()

        sr = session.get(SigningRequest, signer.signing_request_id)
        gc = session.get(GeneratedContract, sr.generated_contract_id) if sr else None
        if sr and gc:
            still_pending = session.exec(
                select(SigningRequestSigner).where(
                    SigningRequestSigner.signing_request_id == sr.id,
                    SigningRequestSigner.status != "completed",
                )
            ).all()
            if still_pending:
                owner = session.get(User, gc.owner_id)
                if owner and owner.notify_signature_events:
                    waiting_on = ", ".join(p.name for p in still_pending)
                    _notify(
                        session, owner.id, "signature_signed",
                        title=f'{signer.name} signed "{gc.name}"',
                        body=f"Waiting on {waiting_on} to sign.",
                        generated_contract_id=gc.id,
                    )


def _apply_signer_declined(session: Session, submitter_id) -> None:
    """Bug tracker: this used to update signer/sr status only -- no bell,
    no email -- so a decline was silent and the owner only found out by
    opening the document and checking. Unlike a completion (which waits
    for every signer before notifying), a decline halts the whole request
    right away, so it's notified the moment sr actually transitions out of
    "pending" here. _apply_submission_declined below has the identical
    "was it pending" guard and the same notify call, because DocuSeal can
    deliver either a form.declined (this function) or a submission.declined
    (that one) for the same decline -- whichever arrives first does the
    transition and the notifying; the second one finds sr already
    "declined" and does nothing, so the owner never gets duplicate
    notifications for one decline."""
    signer = session.exec(
        select(SigningRequestSigner).where(SigningRequestSigner.docuseal_submitter_id == submitter_id)
    ).first()
    if signer and signer.status != "declined":
        signer.status = "declined"
        session.add(signer)
        sr = session.get(SigningRequest, signer.signing_request_id)
        was_pending = bool(sr and sr.status == "pending")
        if was_pending:
            sr.status = "declined"
            session.add(sr)
        session.commit()
        if was_pending:
            gc = session.get(GeneratedContract, sr.generated_contract_id)
            if gc:
                owner = session.get(User, gc.owner_id)
                if owner and owner.notify_signature_events:
                    _send_signature_declined_email(owner, gc, signer.name)
                    _notify(
                        session, owner.id, "signature_declined",
                        title=f'{signer.name} declined to sign "{gc.name}"',
                        body="The signature request has been stopped. You may want to follow up or send a new request.",
                        generated_contract_id=gc.id,
                    )


def _apply_submission_completed(session: Session, submission_id) -> None:
    sr = session.exec(
        select(SigningRequest).where(SigningRequest.docuseal_submission_id == submission_id)
    ).first()
    if sr and sr.status != "completed":
        sr.status = "completed"
        sr.completed_at = datetime.utcnow()
        gc = session.get(GeneratedContract, sr.generated_contract_id)
        try:
            docs_resp = ds.get_submission_documents(submission_id)
            doc_url = (docs_resp.get("documents") or [{}])[0].get("url")
            if doc_url and gc:
                signed_bytes = ds.download_document(doc_url)
                sig_dir = os.path.join(UPLOADS_DIR, str(gc.owner_id), "signatures", str(sr.id))
                os.makedirs(sig_dir, exist_ok=True)
                signed_path = os.path.join(sig_dir, "signed.pdf")
                with open(signed_path, "wb") as f:
                    f.write(signed_bytes)
                sr.signed_file_path = signed_path
        except (RuntimeError, httpx.HTTPStatusError, httpx.RequestError, IndexError, KeyError):
            # The submission IS fully signed regardless -- a failure here
            # just means we download the PDF later. Owner-side download
            # already checks os.path.exists(signed_file_path), and the
            # file can always be fetched from DocuSeal's dashboard
            # directly as a fallback in the meantime.
            pass
        session.add(sr)
        session.commit()
        if gc:
            owner = session.get(User, gc.owner_id)
            # Bug tracker: this used to email unconditionally, with no bell
            # and no opt-out, so an owner who only watches the bell (the
            # normal pattern for every other notification in this app) got
            # no signal at all when a document finished signing. Now gated
            # on notify_signature_events, same toggle as the mid-flight
            # per-signer notification above -- and fires both the bell and
            # the email together, since "fully signed" is the one signature
            # event worth an email, not just a bell ping.
            if owner and owner.notify_signature_events:
                _send_signature_completed_email(owner, gc)
                _notify(
                    session, owner.id, "signature_completed",
                    title=f'Fully signed: "{gc.name}"',
                    body="Everyone has signed. The signed document is in your documents library.",
                    generated_contract_id=gc.id,
                )


def _apply_submission_expired(session: Session, submission_id) -> None:
    sr = session.exec(
        select(SigningRequest).where(SigningRequest.docuseal_submission_id == submission_id)
    ).first()
    if sr and sr.status == "pending":
        sr.status = "expired"
        session.add(sr)
        session.commit()


def _apply_submission_declined(session: Session, submission_id) -> None:
    """See _apply_signer_declined's docstring -- same notify-once-on-the-
    "pending" transition guard, covering DocuSeal's submission.declined
    event. This event doesn't identify which signer declined, so the
    notification here is generic; it only fires when this is the event
    that gets there first (form.declined usually wins, since it names the
    signer)."""
    sr = session.exec(
        select(SigningRequest).where(SigningRequest.docuseal_submission_id == submission_id)
    ).first()
    if sr and sr.status == "pending":
        sr.status = "declined"
        session.add(sr)
        session.commit()
        gc = session.get(GeneratedContract, sr.generated_contract_id)
        if gc:
            owner = session.get(User, gc.owner_id)
            if owner and owner.notify_signature_events:
                _send_signature_declined_email(owner, gc)
                _notify(
                    session, owner.id, "signature_declined",
                    title=f'Signing declined: "{gc.name}"',
                    body="The signature request has been stopped. You may want to follow up or send a new request.",
                    generated_contract_id=gc.id,
                )


def _reconcile_signature_request_from_docuseal(session: Session, sr: SigningRequest) -> None:
    """Bug tracker #55: DocuSeal's webhook is the only thing that normally
    moves a SigningRequest past "pending" (see docuseal_webhook's
    docstring) -- but if the owner never adds Rotely's webhook URL in
    DocuSeal's dashboard, or a delivery attempt is simply lost, a document
    that's actually fully signed can sit at "pending" in Rotely forever
    with no way for the owner to notice or recover short of a direct DB
    edit. This is the fallback: poll DocuSeal's own submission endpoint
    directly and apply whatever's changed through the exact same
    _apply_* helpers the webhook uses, so the two paths can never produce
    different outcomes for the same event. Called from the manual
    "refresh" endpoint below; safe to call on an already-settled request
    (every _apply_* helper no-ops past its own first transition) and safe
    to call repeatedly."""
    if sr.status != "pending":
        return
    try:
        resp = ds.get_submission(sr.docuseal_submission_id)
    except (RuntimeError, httpx.HTTPStatusError, httpx.RequestError):
        return  # couldn't reach DocuSeal -- leave local state as-is, try again next time

    for submitter in resp.get("submitters") or []:
        sub_status = (submitter.get("status") or "").strip().lower()
        submitter_id = submitter.get("id")
        if sub_status == "completed":
            _apply_signer_completed(session, submitter_id)
        elif sub_status == "declined":
            _apply_signer_declined(session, submitter_id)

    top_status = (resp.get("status") or "").strip().lower()
    if top_status == "completed":
        _apply_submission_completed(session, sr.docuseal_submission_id)
    elif top_status == "expired":
        _apply_submission_expired(session, sr.docuseal_submission_id)
    elif top_status == "declined":
        _apply_submission_declined(session, sr.docuseal_submission_id)


@app.post("/api/webhooks/docuseal")
async def docuseal_webhook(request: Request, session: Session = Depends(get_session)):
    """Verified via HMAC (see docuseal_engine.verify_webhook_signature) --
    an unverified or unconfigured secret rejects with 401 and changes
    nothing, by construction of that function. This is the ONLY *automatic*
    thing allowed to mark a SigningRequest/SigningRequestSigner completed;
    the browser's own `completed` event from <docuseal-form> (see sign.js)
    is treated purely as a UI hint, per DocuSeal's own security guidance.
    (The owner-triggered manual refresh endpoint below is the one other
    path that can -- see _reconcile_signature_request_from_docuseal.)"""
    raw_body = await request.body()
    signature = request.headers.get("X-Docuseal-Signature", "")
    if not ds.verify_webhook_signature(raw_body, signature, ds.DOCUSEAL_WEBHOOK_SECRET):
        raise HTTPException(401, "Invalid webhook signature.")

    try:
        payload = json.loads(raw_body)
    except ValueError:
        raise HTTPException(400, "Invalid JSON.")
    event_type = payload.get("event_type", "")
    data = payload.get("data", {}) or {}

    if event_type == "form.completed":
        _apply_signer_completed(session, data.get("id"))
    elif event_type == "form.declined":
        _apply_signer_declined(session, data.get("id"))
    elif event_type == "submission.completed":
        _apply_submission_completed(session, data.get("id"))
    elif event_type == "submission.expired":
        _apply_submission_expired(session, data.get("id"))
    elif event_type == "submission.declined":
        _apply_submission_declined(session, data.get("id"))

    return {"ok": True}


@app.post("/api/generated/{generated_id}/signature-request/refresh")
def refresh_signature_request(
    generated_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Bug tracker #55's other half: a manual fallback the owner can
    trigger from the signature modal (see app.js's "Check for updates"
    button) when a document looks stuck at "pending" -- re-fetches the
    submission directly from DocuSeal and applies whatever's changed via
    _reconcile_signature_request_from_docuseal, so this works regardless
    of whether the webhook is configured at all."""
    gc = _get_owned_generated(session, user, generated_id)
    sr = session.exec(
        select(SigningRequest)
        .where(SigningRequest.generated_contract_id == gc.id)
        .order_by(SigningRequest.created_at.desc())
    ).first()
    if not sr:
        raise HTTPException(404, "No signature request for this document.")
    _reconcile_signature_request_from_docuseal(session, sr)
    session.refresh(sr)
    signers = session.exec(
        select(SigningRequestSigner).where(SigningRequestSigner.signing_request_id == sr.id)
    ).all()
    return {"exists": True, **_signing_request_payload(sr, signers)}



@app.get("/api/generated/{generated_id}/redlines")
def get_redlines(
    generated_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Owner-side review data: a case-file header identifying the document,
    the share link (if any), and every submission received through it, each
    edit tagged with its auto-evaluation, its threshold in plain language,
    and the owner's decision so far."""
    gc = _get_owned_generated(session, user, generated_id)
    tpl = session.get(Template, gc.template_id) if gc.template_id else None
    ph_by_key = {p.field_key: p for p in tpl.placeholders} if tpl else {}
    parties = json.loads(gc.parties_json or "[]")

    # Matched against the whole lineage family, not just this exact
    # revision's id -- a redline apply repoints the link forward to the
    # newest revision, so looking up "the link" against an older revision
    # (e.g. reached via the Redlines button on a stale in-app notification,
    # or an older row in the document's history) would otherwise come up
    # empty even though the same link/submissions still apply.
    links = session.exec(
        select(ShareLink)
        .where(ShareLink.generated_contract_id.in_(_lineage_doc_ids(gc, session)))
        .order_by(ShareLink.created_at.desc())
    ).all()
    link = links[0] if links else None

    header = {
        "name": gc.name,
        "document_type": gc.document_type,
        "created_at": gc.created_at.isoformat(),
        "parties": parties,
        # The party the owner is negotiating with -- best guess is the
        # second party entered at draft time (Party B), falling back to
        # whatever email the share link is addressed to.
        "client": (parties[1] if len(parties) > 1 else (link.client_email if link else "")) or "",
    }

    # See _unresolved_counts -- #21 / phase 4. Shown in the modal header
    # regardless of whether a link currently exists, same as the dashboard
    # badge -- though with no link there's nothing to be unresolved either.
    unresolved_count = _unresolved_counts(session, [generated_id], owner_id=user.id).get(generated_id, 0)

    if not link:
        return {"header": header, "share": None, "submissions": [], "unresolved_count": unresolved_count}

    # Every submission from EVERY link this family has ever had, not just
    # the most recent one -- if a link is closed and a fresh one issued
    # (e.g. re-sharing after a round of edits, or replacing a link the
    # client lost), whatever the client already submitted through the old,
    # now-closed link must stay visible here. The client saw "your changes
    # were sent" at the time; losing that submission just because a newer
    # link now exists would silently strand it with no way for the owner to
    # ever see or act on it. "draft" submissions are just the client's
    # in-progress "Save progress" state -- not a real submission yet, so
    # the owner never sees those regardless of which link they're on.
    link_ids = [l.id for l in links]
    submissions = session.exec(
        select(RedlineSubmission)
        .where(RedlineSubmission.share_link_id.in_(link_ids), RedlineSubmission.status != "draft")
        .order_by(RedlineSubmission.submitted_at.desc())
    ).all()
    all_edits_by_sub = {s.id: session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == s.id)).all() for s in submissions}
    all_edit_ids = [e.id for edits in all_edits_by_sub.values() for e in edits]
    comments_by_edit = _comments_by_edit(session, all_edit_ids)
    source_by_id = _source_summaries_by_id(
        session, [e.source_edit_id for edits in all_edits_by_sub.values() for e in edits if e.source_edit_id]
    )
    # See apply_redline_submission's superseded_edit_ids -- an edit's
    # `decision` column is never mutated once set, so a reconsidered edit
    # can still read "accepted" here long after something newer (a
    # reconsideration, or the client's own response to a counter) chained
    # back to it via source_edit_id. Surfacing that here lets the UI grey
    # out the stale "Apply" affordance instead of showing a decision that
    # apply itself will now silently skip.
    superseded_edit_ids = {e.source_edit_id for edits in all_edits_by_sub.values() for e in edits if e.source_edit_id}

    out = []
    for s in submissions:
        edits = all_edits_by_sub[s.id]
        edit_rows = []
        for e in edits:
            ph = ph_by_key.get(e.field_key)
            threshold_desc = rl.describe_threshold(ph.threshold_type, ph.threshold_config) if ph else None
            inside_threshold = None  # None = no rule to compare against (none/locked or field since removed)
            if ph and ph.threshold_type in ("numeric_range", "approved_list"):
                inside_threshold = e.evaluation == "auto_approved"
            edit_rows.append({
                "id": e.id, "field_key": e.field_key, "label": e.label,
                "original_value": e.original_value, "proposed_value": e.proposed_value,
                "comment": e.comment,
                "evaluation": e.evaluation, "decision": e.decision, "counter_value": e.counter_value,
                "threshold_desc": threshold_desc, "inside_threshold": inside_threshold,
                "comments": comments_by_edit.get(e.id, []),
                "comments_resolved": e.comments_resolved,
                # See RedlineEdit.source_edit_id -- a client's response to
                # one of the owner's own counters, chained so it's never
                # just an unexplained fresh redline (bug tracker #20).
                "responding_to": source_by_id.get(e.source_edit_id) if e.source_edit_id else None,
                "superseded": e.id in superseded_edit_ids,
            })
        out.append({
            "id": s.id,
            "note": s.note,
            "submitted_at": s.submitted_at.isoformat(),
            "status": s.status,
            "responded_at": s.responded_at.isoformat() if s.responded_at else None,
            # See RedlineSubmission.origin -- "owner_reconsideration" rounds
            # are the owner's own updated decision, not a client submission.
            "origin": s.origin,
            "edits": edit_rows,
        })
    return {"header": header, "share": _share_link_payload(link), "submissions": out, "unresolved_count": unresolved_count}


class DecisionBody(BaseModel):
    decision: str  # accepted | rejected


@app.post("/api/redline-edits/{edit_id}/decision")
def decide_redline_edit(
    edit_id: int,
    body: DecisionBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if body.decision not in ("accepted", "rejected"):
        raise HTTPException(400, "decision must be 'accepted' or 'rejected'")
    edit = session.get(RedlineEdit, edit_id)
    if not edit:
        raise HTTPException(404, "Edit not found")
    submission = session.get(RedlineSubmission, edit.submission_id)
    link = session.get(ShareLink, submission.share_link_id) if submission else None
    gc = session.get(GeneratedContract, link.generated_contract_id) if link else None
    if not gc or gc.owner_id != user.id:
        raise HTTPException(404, "Edit not found")
    edit.decision = body.decision
    session.add(edit)
    session.commit()
    return {"id": edit.id, "decision": edit.decision}


class RedlineDecisionItem(BaseModel):
    edit_id: int
    decision: str  # accepted | rejected | countered
    counter_value: str = ""


class RespondBody(BaseModel):
    decisions: list[RedlineDecisionItem]


@app.post("/api/redline-submissions/{submission_id}/respond")
def respond_to_submission(
    submission_id: int,
    body: RespondBody,
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Batches the owner's accept/reject/counter calls for a whole
    submission into one response, sent back to the client as a single next
    round instead of one ping per edit."""
    submission = session.get(RedlineSubmission, submission_id)
    if not submission:
        raise HTTPException(404, "Submission not found")
    link = session.get(ShareLink, submission.share_link_id)
    gc = session.get(GeneratedContract, link.generated_contract_id) if link else None
    if not gc or gc.owner_id != user.id:
        raise HTTPException(404, "Submission not found")

    edits_by_id = {e.id: e for e in session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == submission.id)).all()}
    if not body.decisions:
        raise HTTPException(400, "Decide on at least one redline before sending a response.")

    responded_edits = []
    for item in body.decisions:
        if item.decision not in ("accepted", "rejected", "countered"):
            raise HTTPException(400, "decision must be 'accepted', 'rejected', or 'countered'")
        edit = edits_by_id.get(item.edit_id)
        if not edit:
            raise HTTPException(400, "One of those redlines no longer exists.")
        if item.decision == "countered" and not item.counter_value.strip():
            raise HTTPException(400, f"Enter a counter value for \"{edit.label}\" or choose accept/reject instead.")
        edit.decision = item.decision
        # #25/F7-class bug: this used to .strip() the owner's counter text
        # before storing it, eating meaningful leading/trailing whitespace
        # (e.g. countering with a leading space to read "...the written
        # effective date" instead of mashing two words together). The
        # emptiness check above deliberately still uses .strip() -- that's
        # just "did they type anything real" -- but what gets stored/applied
        # must be the exact value the owner typed.
        edit.counter_value = item.counter_value if item.decision == "countered" else ""
        session.add(edit)
        responded_edits.append(edit)

    submission.responded_at = datetime.utcnow()
    submission.client_ack_at = None  # a new response always needs a fresh look from the client
    session.add(submission)
    session.commit()
    for edit in responded_edits:
        session.refresh(edit)
    # Bug tracker #31: this used to just commit and return, with no email
    # at all -- only the narrower reconsider/direct-edit paths notified the
    # client. The client has no account and no other way to learn their
    # redline round was answered, so a normal response went completely
    # unnoticed unless they happened to revisit the link on their own.
    if link:
        _send_response_email(request, user, gc, link, responded_edits)
    return {"id": submission.id, "responded_at": submission.responded_at.isoformat()}


@app.post("/api/redline-submissions/{submission_id}/apply")
def apply_redline_submission(
    submission_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Applies every accepted edit (anything explicitly accepted, plus
    anything auto-approved that the owner hasn't overridden by rejecting
    it) directly onto a document -- splicing each edit's new text in at its
    recorded location, rather than regenerating the whole document from the
    master template with a field_key -> value map. That's what makes
    redlining two occurrences of the same field independently correct: each
    occurrence has its own location, so changing one never touches the
    other. Produces a new GeneratedContract row, same as a normal draft, so
    the version history stays intact. Not counted against the monthly plan
    limit -- this is finishing a document already in progress, not starting
    a new one.

    A share link can receive more than one redline round before any of them
    get applied (the client's view of the document never reflects an
    earlier apply -- they're always redlining the original text). Splicing
    every round onto that same original text independently would silently
    drop whichever rounds got applied first: applying round 2 after round 1
    already went in would produce a version missing round 1's changes
    entirely, since it never saw them. So this always builds on top of the
    most recently applied round from this same share link (if any), not the
    original -- rounds compound instead of forking. The same reasoning
    applies to the owner's own direct edits (edit_generated_document) made in
    between rounds -- those are chained onto as well, not just other applied
    redline rounds. `chained_from` in the response tells the caller when
    either kind of chaining happened, so the UI can surface it rather than
    applying silently.

    Separately: accepting a redline and applying it are two different
    actions -- responding to a submission never bakes anything into a
    document by itself, only clicking Apply does. That means an owner can
    accept edits in one round, respond, and never click Apply for it before
    a LATER round comes in and gets applied instead (this is exactly what
    happens when a client accepts a countered redline -- that resubmits as
    its own new submission). Without help, that later Apply would only
    splice in its own round's edits, chained onto whatever was already
    baked into a document -- and since the earlier round was never baked
    in, its accepted decisions would be silently dropped even though the
    database still faithfully records them as accepted. So beyond chaining
    onto the base document, this also folds in every OTHER submission on
    this same link that's been responded to but never applied, so whichever
    round the owner eventually clicks Apply on picks up every decision made
    so far, regardless of order. `folded_in_submissions` in the response
    lists any such rounds that got swept in this way."""
    submission = session.get(RedlineSubmission, submission_id)
    if not submission:
        raise HTTPException(404, "Submission not found")
    link = session.get(ShareLink, submission.share_link_id)
    origin_gc = session.get(GeneratedContract, link.generated_contract_id) if link else None
    if not origin_gc or origin_gc.owner_id != user.id:
        raise HTTPException(404, "Submission not found")
    tpl = session.get(Template, origin_gc.template_id) if origin_gc.template_id else None
    if not tpl:
        raise HTTPException(400, "The master document this was drafted from no longer exists.")

    # Find every submission on this same share link that's already been
    # applied, and use whichever produced revision is most recent as the
    # base to build on -- falls back to the original document if this is
    # the first round applied.
    sibling_sub_ids = [
        s.id for s in session.exec(
            select(RedlineSubmission).where(RedlineSubmission.share_link_id == link.id)
        ).all()
    ]
    base_gc = origin_gc
    chained_from = None
    if sibling_sub_ids:
        already_applied = session.exec(
            select(GeneratedContract)
            .where(GeneratedContract.source_submission_id.in_(sibling_sub_ids))
            .order_by(GeneratedContract.created_at.desc())
        ).all()
        if already_applied:
            base_gc = already_applied[0]
            chained_from = {"id": base_gc.id, "name": base_gc.name}

    # The owner can also directly edit a document (see edit_generated_document)
    # in between redline rounds, which produces its own revision the same way
    # an applied round does -- just linked by source_generated_id instead of
    # source_submission_id. Walk forward through any such direct-edit
    # revisions layered on top of whatever we just picked, so a direct edit
    # made after the latest applied round (or on the original, if nothing's
    # been applied yet) is never silently dropped either.
    while True:
        direct_edit = session.exec(
            select(GeneratedContract)
            .where(GeneratedContract.source_generated_id == base_gc.id)
            .order_by(GeneratedContract.created_at.desc())
        ).first()
        if not direct_edit:
            break
        base_gc = direct_edit
        chained_from = {"id": base_gc.id, "name": base_gc.name}

    gc = base_gc
    if not os.path.exists(gc.file_path):
        raise HTTPException(410, "This document is no longer available.")

    edits = session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == submission.id)).all()

    # An edit's `decision` column is never mutated once set -- reconsidering
    # one (reconsider_redline_edit) leaves the original's `decision` exactly
    # as it was and instead creates a brand-new RedlineEdit, in a brand-new
    # sibling submission on this same link, chained back via
    # `source_edit_id`. That means an edit can still read `decision ==
    # "accepted"` in this table long after the owner reconsidered and
    # rejected it. Anything ANY other edit on this link has since chained
    # back to via source_edit_id -- whether from that reconsideration path
    # or the client's own accept/reject/counter response -- is superseded:
    # something newer stands in its place, so it must never be treated as
    # still-accepted here, however its own `decision` column still reads.
    # Without this, accepting a redline, reconsidering it to rejected, and
    # then clicking Apply on ANY round on this link would silently re-apply
    # the original (reconsidered-away) value, since apply only ever looked
    # at `decision` and had no way to see it had been superseded.
    superseded_edit_ids = set()
    if sibling_sub_ids:
        all_sibling_edits = session.exec(
            select(RedlineEdit).where(RedlineEdit.submission_id.in_(sibling_sub_ids))
        ).all()
        superseded_edit_ids = {e.source_edit_id for e in all_sibling_edits if e.source_edit_id}

    # Bug tracker #50: an edit's `evaluation` (auto_approved | needs_review)
    # is computed once, at submit time (_resolve_edits), against the
    # field's threshold rule AS IT EXISTED THEN. It's never recomputed
    # after that. If the owner tightens, changes, or removes a field's
    # threshold_type/threshold_config (PATCH .../threshold) any time
    # between a client's submission and the owner clicking Apply, an edit
    # that was auto_approved under the OLD rule would otherwise still get
    # silently spliced into the document here as if today's rule agreed
    # with that call -- the same "decision made against stale state" shape
    # apply_redline_submission already guards against for document TEXT
    # (see the staleness check below), just for the threshold RULE instead.
    # Re-deriving the evaluation fresh, against each field's CURRENT
    # threshold config, closes that gap. An explicit owner accept
    # (decision == "accepted") is a real human decision and is never
    # second-guessed here -- only the auto-approval path is re-checked.
    placeholders_by_key = {p.field_key: p for p in tpl.placeholders if p.field_key}

    def _still_applyable(e: "RedlineEdit") -> bool:
        if e.decision == "accepted":
            return True
        if e.decision != "pending" or e.evaluation != "auto_approved":
            return False
        ph = placeholders_by_key.get(e.field_key) if e.field_key else None
        if ph is None:
            # Free-text edit (no field_key, no threshold rule) or the
            # field was deleted since submission -- either way there's no
            # live rule to re-confirm auto-approval against, so this can't
            # be trusted as still auto-approved.
            return False
        return rl.evaluate_edit(ph.threshold_type, ph.threshold_config, e.proposed_value) == rl.AUTO_APPROVED

    # Fold in every other submission on this link that's been responded to
    # (the owner has decided on it) but never applied -- see the docstring
    # above. edit_to_folded_sub tracks which sibling submission each folded
    # edit came from, so we only mark THAT submission "reviewed" once we
    # know at least one of its edits actually made it into this apply.
    folded_in_subs = []
    edit_to_folded_sub: dict = {}
    if sibling_sub_ids:
        other_unapplied = session.exec(
            select(RedlineSubmission).where(
                RedlineSubmission.id.in_(sibling_sub_ids),
                RedlineSubmission.id != submission.id,
                RedlineSubmission.status == "pending",
                RedlineSubmission.responded_at.is_not(None),
            )
        ).all()
        for s in other_unapplied:
            s_edits = session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == s.id)).all()
            relevant = [
                e for e in s_edits
                if e.id not in superseded_edit_ids and _still_applyable(e)
            ]
            if relevant:
                folded_in_subs.append(s)
                for e in relevant:
                    edit_to_folded_sub[e.id] = s
                edits = edits + relevant

    to_apply = [
        e for e in edits
        if e.id not in superseded_edit_ids and _still_applyable(e)
    ]
    if not to_apply:
        raise HTTPException(400, "No accepted edits to apply yet.")

    edit_targets = []  # (RedlineEdit, location dict) -- only edits with a still-usable recorded location
    for e in to_apply:
        loc = json.loads(e.location_json or "{}")
        if loc.get("segments"):
            edit_targets.append((e, loc))
    if not edit_targets:
        raise HTTPException(
            400,
            "None of the accepted edits have a usable location to apply anymore "
            + ("(the version this would build on has changed too much since)." if chained_from else "."),
        )

    doc = de.load(gc.file_path)

    # Guard against a stale accepted/auto-approved edit whose recorded text
    # no longer matches what's actually at that spot in `gc` -- e.g. the
    # owner made a direct edit (edit_generated_document) or applied another
    # redline round on the same paragraph after this one was accepted but
    # before it was applied. de.apply_text_edits only checks that its
    # recorded run/offsets are numerically IN BOUNDS for whatever now
    # occupies that run -- it has no idea whether the text there is still
    # what this edit was proposed against, so a shifted-but-still-in-bounds
    # location would otherwise splice this edit's proposed value into the
    # wrong text with no error at all (reproduced: an intervening direct
    # edit of similar length left the run just long enough that the stale
    # offsets stayed "valid" while pointing at completely different
    # characters, silently mangling the sentence). Comparing the location's
    # current text against what was captured at submit time catches this
    # up front and fails loudly instead.
    stale = []
    for e, loc in edit_targets:
        try:
            current_text = de.extract_text_at(doc, loc.get("container_path"), loc["paragraph_index"], loc["segments"])
        except de.MarkError:
            current_text = None
        if current_text != e.original_value:
            stale.append(e)
    if stale:
        names = ", ".join(f'"{e.label or "that field"}"' for e in stale[:3])
        more = f" and {len(stale) - 3} more" if len(stale) > 3 else ""
        raise HTTPException(
            400,
            f"The document has changed since {names}{more} was accepted, so applying now could overwrite the wrong "
            "text. Please re-review the current document before applying this round.",
        )

    try:
        de.apply_text_edits(doc, [
            {
                "container_path": loc["container_path"],
                "paragraph_index": loc["paragraph_index"],
                "segments": loc["segments"],
                "new_text": e.proposed_value,
            }
            for e, loc in edit_targets
        ])
    except de.MarkError as err:
        raise HTTPException(400, f"Couldn't apply those redlines: {err}")

    gen_dir = os.path.join(_template_dir(user.id, tpl.id), "generated")
    os.makedirs(gen_dir, exist_ok=True)
    out_path = os.path.join(gen_dir, f"{secrets.token_hex(8)}.docx")
    de.save(doc, out_path)

    safe_name = re.sub(r"[^A-Za-z0-9 _\-]+", "", tpl.name).strip() or "Contract"
    display_name = f"{safe_name} (redlined) - {datetime.utcnow().strftime('%b %d, %Y')}"
    # Best-effort summary of field values for the detail view: carries the
    # prior snapshot forward, overwritten by whichever applied edit(s)
    # targeted each field_key. A field redlined differently at two separate
    # occurrences only shows the last one applied here -- the document
    # itself (not this summary) is the source of truth for what each spot
    # actually says.
    base_values = {v["field_key"]: v["value"] for v in json.loads(gc.values_json)}
    for e, _ in edit_targets:
        if e.field_key:
            base_values[e.field_key] = e.proposed_value
    values_snapshot = [{"label": p.label, "field_key": p.field_key, "value": base_values.get(p.field_key, "")} for p in tpl.placeholders]
    # field_positions carry forward from the source document: applying a
    # single-run whole-value edit (the common case for a field) leaves that
    # run's position unchanged, just with new text, so untouched fields'
    # highlighted positions stay valid. A free-text edit that splits or
    # merges runs within a paragraph that also holds an untouched field can
    # shift that field's run index -- a known, narrow limitation of
    # carrying positions forward this way rather than recomputing them.
    new_gc = GeneratedContract(
        # document_type inherited from gc (the source revision), not
        # tpl.document_type (bug tracker #30) -- the template's type can be
        # relabeled mid-negotiation, and stamping the CURRENT template type
        # onto a document that was drafted and shared under the OLD type
        # split its family across two type groups on the Documents page,
        # with "archive/delete whole family" only ever touching one half.
        owner_id=user.id, template_id=tpl.id, template_name=tpl.name, document_type=gc.document_type,
        name=display_name, file_path=out_path, values_json=json.dumps(values_snapshot),
        field_positions_json=gc.field_positions_json,
        parties_json=gc.parties_json,  # carry the parties forward from the original draft
        source_submission_id=submission.id,
        # Also stamped with the exact document these edits were spliced onto
        # (same as gc/base_gc above) -- an explicit, immutable parent
        # pointer independent of source_submission_id's indirect path
        # (submission -> share_link_id -> ShareLink.generated_contract_id).
        # That indirect path stops being reliable once the apply below can
        # repoint the link forward to newer revisions -- see
        # _lineage_roots_for's _parent_id, which now prefers this field.
        source_generated_id=gc.id,
        # See edit_generated_document's identical comment: inherit archived
        # state so a redline apply on an archived document's family doesn't
        # produce a new, un-archived revision that splits the family.
        archived=gc.archived,
    )
    session.add(new_gc)
    session.flush()  # assigns new_gc.id, needed below to repoint the share link
    # Deliberately NOT logged against quota (bug tracker #29) -- this
    # function's own docstring says so ("finishing a document already in
    # progress, not starting a new one"), but a _log_generation_event call
    # was left in anyway, silently contradicting it and burning a plan slot
    # every time a redline round got applied.

    applied_ids = {e.id for e, _ in edit_targets}
    for e in to_apply:
        if e.id in applied_ids and e.decision == "pending":
            e.decision = "accepted"
            session.add(e)
    submission.status = "reviewed"
    session.add(submission)

    # Only mark a folded-in sibling submission "reviewed" once we know at
    # least one of ITS edits actually landed in edit_targets (not just
    # "was accepted") -- an edit can still get dropped here for a stale
    # location, and a submission whose edits were all dropped shouldn't be
    # marked applied when nothing of it actually made it in.
    contributing_sub_ids = {edit_to_folded_sub[e.id].id for e, _ in edit_targets if e.id in edit_to_folded_sub}
    folded_in_response = []
    for s in folded_in_subs:
        if s.id in contributing_sub_ids:
            s.status = "reviewed"
            session.add(s)
            folded_in_response.append({"id": s.id, "submitted_at": s.submitted_at.isoformat()})

    # The client should be able to refresh this exact same link, re-enter
    # the same access code, and see the applied revision -- no brand-new
    # link needed. Mirrors edit_generated_document's direct-edit repoint
    # (including reusing owner_edited_at, so the same self-clearing "updated
    # since your last visit" banner fires here too) -- this was previously
    # missing here, so Apply silently left the link pointing at the
    # pre-redline document.
    if link.status == "open":
        link.generated_contract_id = new_gc.id
        link.owner_edited_at = datetime.utcnow()
        session.add(link)

    session.commit()
    session.refresh(new_gc)

    preview_doc = de.load(out_path)
    return {
        "generated_id": new_gc.id,
        "name": new_gc.name,
        "html": de.render_paragraphs_html(preview_doc),
        "chained_from": chained_from,
        "folded_in_submissions": folded_in_response,
    }


# ---------------------------------------------------------------------------
# Public share page (no account needed) -- the client's redlining view
# ---------------------------------------------------------------------------

def _get_share_link_or_404(session: Session, token: str) -> ShareLink:
    link = session.exec(select(ShareLink).where(ShareLink.token == token)).first()
    if not link:
        raise HTTPException(404, "This review link doesn't exist or is no longer active.")
    return link


class ShareVerifyBody(BaseModel):
    access_code: str


@app.post("/api/share/{token}/verify")
def verify_share_access(token: str, body: ShareVerifyBody, session: Session = Depends(get_session)):
    link = _get_share_link_or_404(session, token)
    if link.status != "open":
        raise HTTPException(410, "This review link has been closed by the sender.")
    entered = (body.access_code or "").strip().upper()
    if not entered or not secrets.compare_digest(entered, link.access_code):
        raise HTTPException(401, "That code doesn't match. Double check with whoever sent you this link.")
    return {"session_token": _issue_share_session(link.id)}


def _require_share_session(request: Request, token: str, session: Session) -> ShareLink:
    link = _get_share_link_or_404(session, token)
    if link.status != "open":
        raise HTTPException(410, "This review link has been closed by the sender.")
    header = request.headers.get("x-share-session", "")
    if not header or not _verify_share_session(header, link.id):
        raise HTTPException(401, "Please enter the access code first.")
    return link


@app.get("/api/share/{token}")
def get_share_document(token: str, request: Request, session: Session = Depends(get_session)):
    link = _require_share_session(request, token, session)
    gc = session.get(GeneratedContract, link.generated_contract_id)
    if not gc or not os.path.exists(gc.file_path):
        raise HTTPException(410, "This document is no longer available.")
    # Computed against last_viewed_at BEFORE it gets overwritten just below --
    # true only on the first visit after an owner edit, then naturally false
    # again on every visit after that, with no separate flag to remember to
    # clear. Requires a prior visit to have happened at all, so a first-ever
    # visit never shows an "updated since you last looked" notice about a
    # look that never happened.
    owner_updated_since_last_view = bool(
        link.owner_edited_at and link.last_viewed_at and link.owner_edited_at > link.last_viewed_at
    )
    link.last_viewed_at = datetime.utcnow()
    session.add(link)
    # Log this exact view as its own row -- last_viewed_at above only ever
    # holds the most recent visit, but the revision-history trail needs
    # every single view, timestamped, not just whether it's been seen.
    session.add(ShareLinkView(share_link_id=link.id))
    session.commit()

    fields = []
    tpl = session.get(Template, gc.template_id) if gc.template_id else None
    if tpl:
        values = {v["field_key"]: v["value"] for v in json.loads(gc.values_json)}
        # Threshold rules are deliberately never sent here -- showing the
        # client your acceptable range would defeat the entire point.
        fields = [
            {"field_key": p.field_key, "label": p.label, "field_type": p.field_type, "current_value": values.get(p.field_key, "")}
            for p in tpl.placeholders
        ]

    doc = de.load(gc.file_path)
    field_positions = json.loads(gc.field_positions_json or "[]")
    html = de.render_paragraphs_html(doc, field_positions)

    sender = session.get(User, gc.owner_id)
    sender_email = link.sender_email or (sender.email if sender else "")

    def _client_location(e: "RedlineEdit") -> Optional[dict]:
        """RedlineEdit.location_json stores "container_path" (a parsed
        list) -- the server's own internal shape. A location handed back
        to the client for reuse in a follow-up submission needs
        "table_path" (a string) instead, matching what EditLocationBody
        expects and what a fresh browser selection actually sends (see
        share.js's computeSelectionSegments). Without this conversion the
        client's next request silently has no table_path at all, defaults
        to "" (top-level body), and a table-cell redline resolves against
        the wrong paragraph on resume/counter-accept. See _table_path_str."""
        loc = json.loads(e.location_json or "{}")
        if not loc:
            return None
        loc["table_path"] = _table_path_str(loc.get("container_path") or [])
        return loc

    # If the client saved progress on an earlier visit, hand it back so the
    # page can resume exactly where they left off instead of starting over.
    draft = session.exec(
        select(RedlineSubmission).where(RedlineSubmission.share_link_id == link.id, RedlineSubmission.status == "draft")
    ).first()
    draft_payload = None
    if draft:
        draft_edits = session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == draft.id)).all()
        draft_payload = {
            "note": draft.note,
            "edits": [
                {
                    "field_key": e.field_key, "label": e.label, "proposed_value": e.proposed_value,
                    "original_value": e.original_value, "comment": e.comment,
                    "location": _client_location(e),
                    # See RedlineEdit.source_edit_id -- without sending this
                    # back, share.js's draft-resume path had no way to know
                    # this saved item was a counter-acceptance, so it would
                    # submit it as an ordinary fresh proposal on the next
                    # Finalize and lose the auto-decided treatment.
                    "source_edit_id": e.source_edit_id,
                    # #32: a countered edit chained via source_edit_id but
                    # still decision=="pending" is one the client saved
                    # progress on WITHOUT explicitly accepting or rejecting
                    # (see counter_decided in ShareEditBody/_resolve_edits).
                    # share.js's draft-resume loader reads is_counter to
                    # restore counterPending, and client_original_value as
                    # what Reject should revert to -- without sending both
                    # back here, resuming this draft made an untouched
                    # counter look like an ordinary, already-settled
                    # suggestion, silently defeating the Phase 4 Finalize
                    # hard block the client-side counterPending check exists
                    # to enforce. Once decided (accepted/rejected), it's
                    # correctly resolved and shouldn't be re-asked, so
                    # is_counter is false for those.
                    "is_counter": bool(e.source_edit_id) and e.decision == "pending",
                    "client_original_value": e.original_value if (e.source_edit_id and e.decision == "pending") else None,
                }
                for e in draft_edits
            ],
        }

    # If the owner has sent a batched response (accept/reject/counter) to a
    # submitted round that the client hasn't seen yet, hand that back too so
    # the page can show it before returning to normal redlining.
    responded = session.exec(
        select(RedlineSubmission)
        .where(
            RedlineSubmission.share_link_id == link.id,
            RedlineSubmission.responded_at != None,  # noqa: E711
            RedlineSubmission.client_ack_at == None,  # noqa: E711
        )
        .order_by(RedlineSubmission.submitted_at.desc())
    ).first()
    response_payload = None
    if responded:
        responded_edits = session.exec(
            select(RedlineEdit).where(RedlineEdit.submission_id == responded.id, RedlineEdit.decision != "pending")
        ).all()
        response_payload = {
            "submission_id": responded.id,
            "responded_at": responded.responded_at.isoformat(),
            # "client" | "owner_reconsideration" | "owner_edit" -- lets
            # ResponseView (share.js) branch its copy for an owner_edit
            # round, which isn't a response to anything the client sent
            # (see RedlineSubmission.origin, phase 5).
            "origin": responded.origin,
            "edits": [
                {
                    "id": e.id, "field_key": e.field_key, "label": e.label,
                    "proposed_value": e.proposed_value, "original_value": e.original_value,
                    "decision": e.decision, "counter_value": e.counter_value,
                    "location": _client_location(e),
                    # No comment thread here on purpose -- this is the
                    # one-time "sender responded" banner (ResponseView),
                    # which the client clicks through via "Continue
                    # redlining" into the full Redline History panel, where
                    # get_share_redlines does include each edit's thread.
                }
                for e in responded_edits
            ],
        }

    return {
        "name": gc.name,
        "document_type": gc.document_type,
        "html": html,
        "fields": fields,
        "parties": json.loads(gc.parties_json or "[]"),
        "client_email": link.client_email,
        "client_first_name": link.client_first_name,
        "client_last_name": link.client_last_name,
        "sender_email": sender_email,
        "draft": draft_payload,
        "response": response_payload,
        "owner_updated_since_last_view": owner_updated_since_last_view,
    }


class EditLocationBody(BaseModel):
    """Where in the document this edit applies -- same shape the browser
    already computes for template authoring (see computeSelectionSegments /
    the /mark endpoint), just captured against a generated document's
    current text instead of a template's tokens. table_path uses the same
    "t,r,c;t,r,c" encoding _parse_table_path expects; empty means the
    top-level document body."""
    table_path: str = ""
    paragraph_index: int
    segments: list[MarkSegment]


class ShareEditBody(BaseModel):
    # "" for a free-text edit not tied to a known placeholder field.
    field_key: str = ""
    proposed_value: str
    comment: str = ""
    # Fallback label shown in the owner's review list when this isn't a
    # known placeholder (e.g. a short excerpt of the selected text). Ignored
    # when field_key matches a real placeholder -- that field's own label
    # is used instead.
    label: str = ""
    location: Optional[EditLocationBody] = None
    # Set when this edit *originated from* a redline the owner countered --
    # references the id of that earlier, now-"countered" RedlineEdit. Sent
    # for every such row on every save-progress/submit call, whether or not
    # the client has actually decided it yet (share.js keeps the row's
    # sourceEditId set from the moment the counter is loaded). Because of
    # that, accepting_edit_id ALONE cannot mean "the client explicitly
    # accepted or rejected this" -- see counter_decided below, which is
    # what actually gates that. _resolve_edits verifies the reference
    # server-side (the referenced edit really is countered, on this same
    # share link, with a counter_value matching proposed_value here) before
    # trusting it; a mismatched or missing reference is silently ignored
    # and this is treated as an ordinary new proposal instead of erroring
    # the whole submission. See submit_redlines for what a real decision
    # unlocks.
    accepting_edit_id: Optional[int] = None
    # True only when the client has explicitly clicked Accept or Reject on
    # this countered row (share.js sends `!counterPending`, and counterPending
    # only ever flips to false via acceptCounter/rejectCounter -- never by
    # merely saving progress with the row untouched). #32: before this flag
    # existed, _resolve_edits inferred "the client accepted this counter"
    # purely from accepting_edit_id being present and the value still
    # matching the counter -- true by default for a counter the client had
    # never even looked at, so hitting "Save progress" on a document with an
    # untouched counter silently recorded it as accepted, defeating the
    # Phase 4 Finalize hard block the moment the client resumed that draft
    # (see the /api/share/{token} draft-resume payload below, which restores
    # counterPending from decision=="pending" + a source_edit_id, not from
    # this flag -- this flag only matters for the save/submit direction).
    counter_decided: bool = False


class ShareSubmitBody(BaseModel):
    edits: list[ShareEditBody]
    note: str = ""


def _resolve_edits(session: Session, gc: GeneratedContract, edits_in: list[ShareEditBody], link_id: Optional[int] = None):
    """Shared between save-progress and submit: re-reads each proposed
    edit's *current* text directly from the generated document at its exact
    recorded location (rather than trusting whatever the browser sent) so a
    stale or malformed selection is rejected here, and computes each field
    edit's threshold evaluation. Returns a list of kwargs dicts ready for
    RedlineEdit(...).

    Also resolves accepting_edit_id (see ShareEditBody): if set and it
    checks out -- the referenced edit is really "countered", belongs to a
    submission on this same link_id, and its counter_value exactly matches
    what's being proposed here -- the returned kwargs are chained to it via
    source_edit_id. Whether that also resolves the decision to "accepted"/
    "rejected" (instead of leaving it "pending") depends on counter_decided
    (see ShareEditBody and #32) -- an unresolved counter still gets chained
    (so submit's hard-block and the draft-resume payload can find it) but
    keeps decision="pending" until the client has actually said so. link_id
    is only needed for the accepting_edit_id check, so callers that never
    pass it (there are none today, but save-progress passes it through for
    consistency) can omit it.

    An edit whose proposed value exactly matches the current text is
    dropped as a no-op UNLESS it carries a comment or is an explicit
    counter response (bug tracker #35) -- share.js's commitSuggestion keeps
    a redline client-side under that same either/or rule, so a comment-only
    note (no value change) must still make it through here to reach the
    owner, not be silently discarded alongside genuine no-ops."""
    tpl = session.get(Template, gc.template_id) if gc.template_id else None
    placeholders_by_key = {p.field_key: p for p in (tpl.placeholders if tpl else [])}

    doc = None
    if any(e.location for e in edits_in):
        if not os.path.exists(gc.file_path):
            raise HTTPException(410, "This document is no longer available.")
        doc = de.load(gc.file_path)

    out = []
    for e in edits_in:
        if not e.location:
            continue  # no location captured -- can't be applied, so don't accept it
        container_path = _parse_table_path(e.location.table_path)
        segments = [s.dict() for s in e.location.segments]
        if not segments:
            continue
        try:
            original_text = de.extract_text_at(doc, container_path, e.location.paragraph_index, segments)
        except de.MarkError as err:
            raise HTTPException(400, f"That selection is no longer valid: {err}")

        proposed = e.proposed_value.strip()

        # Resolve accepting_edit_id BEFORE the no-op check below -- an
        # explicit response to a live counter (accepting it, or rejecting it
        # by reverting to the original value) is a real decision even when
        # the resulting proposed value happens to equal the document's
        # current text, and must not be silently dropped as "not actually a
        # change." Discovered testing "Reject" on an owner_edit-origin
        # counter (phase 5, the click-to-insert follow-up): that counter's
        # client_original_value ALWAYS equals the original/current text
        # (nothing was ever applied -- it's queued, not instant), so a
        # rejection always hit the no-op skip below, was silently dropped,
        # never chained via source_edit_id, and so never resolved phase 4's
        # unresolved-counter hard block -- Finalize stayed blocked forever
        # even after the client explicitly rejected it.
        decision = "pending"
        source_edit_id = None
        is_explicit_counter_response = False
        # What actually gets stored/applied for this edit's proposed_value.
        # Defaults to the exact, UNSTRIPPED client input -- #25/F7-class bug:
        # this used to default to the stripped comparison copy (`proposed`),
        # silently eating a genuinely meaningful leading/trailing space on an
        # ordinary client-typed proposal (e.g. inserting "written " before a
        # word came out "writteneffective date" once applied). `proposed`
        # remains the right value for the no-op/threshold-evaluation checks
        # below, just never for what gets stored. Overridden below for an
        # explicit accept/reject of a counter, which already used the exact
        # unstripped value.
        final_value = e.proposed_value
        if e.accepting_edit_id is not None and link_id is not None:
            prior = session.get(RedlineEdit, e.accepting_edit_id)
            prior_sub = session.get(RedlineSubmission, prior.submission_id) if prior else None
            if (
                prior and prior_sub and prior_sub.share_link_id == link_id
                and prior.decision == "countered"
            ):
                # Chain this new edit back to the counter it's responding
                # to regardless of whether the client took the counter's
                # value exactly or suggested something different -- see
                # RedlineEdit.source_edit_id and bug tracker #20. Before
                # this, the chain was only recorded on an exact match, so a
                # client who countered the sender's counter (rather than
                # taking it as-is) lost the link back to the negotiation
                # entirely, and the sender saw an unrelated fresh redline.
                # Chained even when the client hasn't decided yet (see
                # counter_decided just below) -- #32: submit's hard-block and
                # the draft-resume payload both need to find this row via
                # source_edit_id regardless of whether it's resolved, or an
                # unresolved counter saved via Save-progress would come back
                # from resume looking like an ordinary, already-settled edit.
                source_edit_id = e.accepting_edit_id
                is_explicit_counter_response = True
                if not e.counter_decided:
                    # #32: the client hasn't clicked Accept or Reject on this
                    # row -- it's chained (above) so it isn't lost, but stays
                    # "pending" rather than being inferred as accepted just
                    # because the untouched value still equals the counter.
                    # That inference used to fire unconditionally here,
                    # which is exactly what let a plain "Save progress" on an
                    # untouched counter silently record it as accepted.
                    pass
                elif prior.counter_value.strip() == proposed:
                    # Accepting the sender's counter verbatim -- use their
                    # exact counter_value (unstripped), not the generically
                    # re-.strip()'d client echo of it. Matters most for a
                    # click-to-insert counter (phase 5 follow-up), where the
                    # counter is very often JUST a leading/trailing space
                    # (e.g. inserting "written " before a word) -- stripping
                    # it here silently mashed the inserted word into its
                    # neighbor with no error, even though
                    # edit_generated_document itself already preserves that
                    # whitespace correctly when the counter is first created.
                    decision = "accepted"
                    final_value = prior.counter_value
                elif proposed == original_text.strip():
                    # Reverted back to the original/current value -- an
                    # explicit rejection of the counter, not a fresh ask.
                    # Use the exact live text, not a re-derived/stripped copy.
                    decision = "rejected"
                    final_value = original_text
                # else: counter_decided but neither an exact accept nor a
                # plain revert-to-original -- the client suggested something
                # else entirely (the "Suggest edit" option). Falls through
                # as a fresh pending proposal for the owner, still chained
                # via source_edit_id so the negotiation history stays intact.
            # A missing/mismatched reference isn't an error -- it just means
            # this isn't (or is no longer) a response to a live counter, so
            # it falls through to the normal "pending, needs an owner
            # decision" path with no chain recorded.

        # Bug tracker #35: a comment-only redline (no value change, just a
        # note) is exactly what share.js's commitSuggestion keeps client-side
        # for -- it stores an edit if EITHER the value changed OR a comment
        # was entered (see share.js's commitSuggestion). This check used to
        # test only the value, so a comment with no accompanying value change
        # was silently dropped here before the owner ever saw it, with no
        # error and no indication to the client that their note didn't land.
        has_comment = bool(e.comment and e.comment.strip())
        if proposed == original_text.strip() and not is_explicit_counter_response and not has_comment:
            continue  # not actually a change, no comment either, and not an explicit decision on a live counter either

        ph = placeholders_by_key.get(e.field_key) if e.field_key else None
        evaluation = rl.evaluate_edit(ph.threshold_type, ph.threshold_config, proposed) if ph else rl.NEEDS_REVIEW
        if ph:
            label = ph.label
        else:
            label = e.label.strip()[:80]
            if not label:
                excerpt = original_text.strip()
                label = (excerpt[:57] + "…") if len(excerpt) > 57 else (excerpt or "Custom edit")

        out.append(dict(
            field_key=e.field_key if ph else "",
            label=label,
            original_value=original_text,
            proposed_value=final_value,
            comment=e.comment.strip()[:1000],
            evaluation=evaluation,
            decision=decision,
            source_edit_id=source_edit_id,
            location_json=json.dumps({
                "container_path": container_path,
                "paragraph_index": e.location.paragraph_index,
                "segments": segments,
            }),
        ))
    return out


def _existing_draft(session: Session, share_link_id: int) -> Optional[RedlineSubmission]:
    return session.exec(
        select(RedlineSubmission).where(RedlineSubmission.share_link_id == share_link_id, RedlineSubmission.status == "draft")
    ).first()


def _unresolved_countered_edit_ids(session: Session, link_id: int) -> set:
    """The id of every countered RedlineEdit on this link that no other
    RedlineEdit has chained back to yet via source_edit_id -- see
    _unresolved_counts for the full rationale. Scoped to just this one
    link (not the whole lineage family _unresolved_counts uses for the
    dashboard badge), since that's the exact set of counters the client
    reviewing THIS link is responsible for deciding on before Finalize."""
    subs = session.exec(
        select(RedlineSubmission).where(RedlineSubmission.share_link_id == link_id, RedlineSubmission.status != "draft")
    ).all()
    sub_ids = [s.id for s in subs]
    if not sub_ids:
        return set()
    edits = session.exec(select(RedlineEdit).where(RedlineEdit.submission_id.in_(sub_ids))).all()
    referenced = {e.source_edit_id for e in edits if e.source_edit_id}
    return {e.id for e in edits if e.decision == "countered" and e.id not in referenced}


@app.post("/api/share/{token}/save-progress")
def save_share_progress(token: str, body: ShareSubmitBody, request: Request, session: Session = Depends(get_session)):
    """Persists the client's in-progress redlines and comments server-side
    (not in the browser) so re-entering the access code on a later visit
    picks up right where they left off. Does not notify the owner and
    never shows up on their review screen -- only "Finalize and submit"
    does that."""
    link = _require_share_session(request, token, session)
    gc = session.get(GeneratedContract, link.generated_contract_id)
    if not gc:
        raise HTTPException(410, "This document is no longer available.")

    resolved = _resolve_edits(session, gc, body.edits, link_id=link.id)

    draft = _existing_draft(session, link.id)
    if draft:
        for old_edit in session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == draft.id)).all():
            session.delete(old_edit)
        draft.note = body.note.strip()[:2000]
        draft.submitted_at = datetime.utcnow()
        session.add(draft)
    else:
        draft = RedlineSubmission(share_link_id=link.id, note=body.note.strip()[:2000], status="draft")
        session.add(draft)
    session.commit()
    session.refresh(draft)

    for kwargs in resolved:
        session.add(RedlineEdit(submission_id=draft.id, **kwargs))
    session.commit()
    return {"ok": True, "saved_changes": len(resolved)}


@app.post("/api/share/{token}/submit")
def submit_redlines(token: str, body: ShareSubmitBody, request: Request, session: Session = Depends(get_session)):
    link = _require_share_session(request, token, session)
    gc = session.get(GeneratedContract, link.generated_contract_id)
    if not gc:
        raise HTTPException(410, "This document is no longer available.")
    # Bug tracker #57: this used to also reject edits=[] + note="" outright
    # ("No changes or comments were provided"), even though the note field
    # is labeled "(optional)" on the client page -- there was no way to
    # finalize a review that's genuinely just "I looked, nothing to flag,"
    # which is a legitimate outcome, not an accident. Submitting with
    # nothing in either is now allowed and means exactly that.
    resolved = _resolve_edits(session, gc, body.edits, link_id=link.id)

    # Hard block -- bug tracker #21 / phase 4. Inaction on a counter used to
    # default to silent acceptance the moment Finalize was hit; now every
    # countered edit on this link must be explicitly resolved (accepted,
    # rejected, or re-suggested -- see _resolve_edits' accepting_edit_id
    # chaining) before a submission can go through. "Save progress" (above)
    # deliberately has no such check -- the client is allowed to come back
    # later and decide then. share.js checks this client-side too so the
    # error surfaces as soon as the client clicks Finalize, but the real
    # gate is here: nothing this endpoint accepts can leave a counter
    # silently unresolved.
    #
    # #32: being *referenced* via accepting_edit_id isn't enough on its own
    # -- share.js sends that reference for a still-undecided counter row
    # too (see counter_decided on ShareEditBody), so gating on "referenced
    # by something in `resolved`" alone would let an untouched counter slip
    # through this exact endpoint. Read counter_decided straight off the
    # submitted body (not off `resolved`, which only carries the fields a
    # RedlineEdit row itself stores) for what actually counts as decided.
    decided_source_ids = {e.accepting_edit_id for e in body.edits if e.accepting_edit_id is not None and e.counter_decided}
    still_unresolved = _unresolved_countered_edit_ids(session, link.id) - decided_source_ids
    if still_unresolved:
        raise HTTPException(400, "Decide on the sender's countered change(s) before finalizing -- accept, reject, or suggest something else for each one.")

    # Finalizing replaces any in-progress "Save progress" draft -- it's now
    # a real submission, not a draft anymore.
    draft = _existing_draft(session, link.id)
    if draft:
        for old_edit in session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == draft.id)).all():
            session.delete(old_edit)
        session.delete(draft)
        session.commit()

    submission = RedlineSubmission(share_link_id=link.id, note=body.note.strip()[:2000], status="pending")
    # If every resolved edit already carries a final decision -- accepted OR
    # rejected, via _resolve_edits/accepting_edit_id's counter-response
    # handling -- there's nothing left for the owner to decide -- either
    # they're the one who proposed this exact value as their counter
    # (accepted), or the client just explicitly declined it (rejected), and
    # either way no further response is needed. Mark it responded
    # immediately so it goes straight to "ready to apply"/resolved instead
    # of sitting in the owner's queue forever asking them to review a round
    # that's already fully decided. Bug tracker #37: this used to only check
    # for all-accepted, so a round of pure explicit counter-rejections
    # (nothing accepted, nothing pending) never got this treatment --
    # responded_at stayed unset forever, which stuck the owner's dashboard
    # on "submitted, awaiting your review" and the client's own Redline
    # History panel on "Awaiting response" for a round that was actually
    # already fully resolved on the client's end. A submission that mixes a
    # counter-response with a genuinely new (still-pending) proposal, or
    # includes a comment-only edit (#35, also left "pending"), still needs
    # a real response for that part, so this only fires when NOTHING in the
    # round is still "pending".
    # #57 (continued): dropped the `resolved and` guard that used to make
    # this condition vacuously false whenever resolved == [] -- all(...) is
    # already vacuously True over an empty list, which is exactly what's
    # wanted: zero edits means zero still pending, so there's nothing for
    # the owner to decide and this round is responded the instant it
    # arrives. Before this, a no-edits (or comment-only) submission left
    # responded_at unset forever, which the dashboard rendered as a
    # permanent, un-clearable "Redlines submitted, awaiting your review" --
    # the Redlines modal never even shows a "Send response" button when
    # there's nothing undecided, so there was no way to make it go away.
    if all(kw["decision"] != "pending" for kw in resolved):
        submission.responded_at = datetime.utcnow()
    session.add(submission)
    session.commit()
    session.refresh(submission)

    for kwargs in resolved:
        session.add(RedlineEdit(submission_id=submission.id, **kwargs))
    session.commit()

    owner = session.get(User, gc.owner_id)
    if owner and owner.notify_redline_submitted:
        _send_redlines_submitted_notification(owner, gc, link, len(resolved), body.note.strip())
        who = link.client_email.strip() or "A reviewer"
        # #57: a zero-edit submission is now a real, allowed outcome ("looked
        # it over, nothing to flag") rather than something that could never
        # reach here -- word the bell notification for it instead of saying
        # "sent redlines" when none were sent.
        title = f'{who} sent redlines on "{gc.name}"' if resolved else f'{who} reviewed "{gc.name}" with no changes'
        _notify(
            session, owner.id, "redline_submitted",
            title=title,
            body=f"{len(resolved)} change{'s' if len(resolved) != 1 else ''} proposed." if resolved else "",
            generated_contract_id=gc.id,
        )
    return {"ok": True}


@app.get("/api/share/{token}/history")
def get_share_history(token: str, request: Request, session: Session = Depends(get_session)):
    link = _require_share_session(request, token, session)
    gc = session.get(GeneratedContract, link.generated_contract_id)
    if not gc:
        raise HTTPException(410, "This document is no longer available.")
    return _client_lineage_timeline(gc, session)


@app.get("/api/share/{token}/redlines")
def get_share_redlines(token: str, request: Request, session: Session = Depends(get_session)):
    """Every non-draft round the client has ever submitted through this
    link, with the sender's decision on each edit and its open comment
    thread. Unlike the one-shot `response` field on GET /api/share/{token}
    -- which only ever surfaces the single latest round, and only until the
    client acknowledges it -- this is the full, durable record: always
    available, on every visit, for as long as the link stays open.
    Threshold rules are never included here, same as everywhere else
    client-facing."""
    link = _require_share_session(request, token, session)
    submissions = session.exec(
        select(RedlineSubmission)
        .where(RedlineSubmission.share_link_id == link.id, RedlineSubmission.status != "draft")
        .order_by(RedlineSubmission.submitted_at.desc())
    ).all()
    all_edits_by_sub = {s.id: session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == s.id)).all() for s in submissions}
    all_edit_ids = [e.id for edits in all_edits_by_sub.values() for e in edits]
    comments_by_edit = _comments_by_edit(session, all_edit_ids)
    source_by_id = _source_summaries_by_id(
        session, [e.source_edit_id for edits in all_edits_by_sub.values() for e in edits if e.source_edit_id]
    )

    out = []
    for s in submissions:
        edits = all_edits_by_sub[s.id]
        out.append({
            "id": s.id,
            "submitted_at": s.submitted_at.isoformat(),
            "responded_at": s.responded_at.isoformat() if s.responded_at else None,
            "status": s.status,
            "note": s.note,
            # See RedlineSubmission.origin -- lets the client's own history
            # panel label an owner reconsideration round distinctly from a
            # round they submitted themselves.
            "origin": s.origin,
            "edits": [
                {
                    "id": e.id, "label": e.label,
                    "original_value": e.original_value, "proposed_value": e.proposed_value,
                    "comment": e.comment,
                    "decision": e.decision, "counter_value": e.counter_value,
                    "comments": comments_by_edit.get(e.id, []),
                    "comments_resolved": e.comments_resolved,
                    # See RedlineEdit.source_edit_id -- for an
                    # owner_reconsideration round this points at the edit
                    # the client originally proposed, giving the client a
                    # visible link back to what changed (bug tracker #19).
                    "responding_to": source_by_id.get(e.source_edit_id) if e.source_edit_id else None,
                }
                for e in edits
            ],
        })
    return {"submissions": out}


class CommentBody(BaseModel):
    body: str


def _get_owned_edit(session: Session, user: User, edit_id: int) -> RedlineEdit:
    edit = session.get(RedlineEdit, edit_id)
    submission = session.get(RedlineSubmission, edit.submission_id) if edit else None
    link = session.get(ShareLink, submission.share_link_id) if submission else None
    gc = session.get(GeneratedContract, link.generated_contract_id) if link else None
    if not edit or not gc or gc.owner_id != user.id:
        raise HTTPException(404, "Edit not found")
    return edit


def _get_client_edit(session: Session, link: ShareLink, edit_id: int) -> RedlineEdit:
    edit = session.get(RedlineEdit, edit_id)
    submission = session.get(RedlineSubmission, edit.submission_id) if edit else None
    if not edit or not submission or submission.share_link_id != link.id:
        raise HTTPException(404, "That redline no longer exists.")
    return edit


class ReconsiderBody(BaseModel):
    decision: str  # accepted | rejected | countered
    counter_value: str = ""


@app.post("/api/redline-edits/{edit_id}/reconsider")
def reconsider_redline_edit(
    edit_id: int,
    body: ReconsiderBody,
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Lets the owner change their mind on an edit they've already decided
    (accepted/rejected/countered) -- bug tracker #19. Before this, a
    decision was a dead end: once made, the Redlines modal permanently
    dropped an edit's decision controls (see openRedlinesModal's `already`
    branch), even after a client pushed back in its comment thread, with
    no way to reverse or revise it.

    Deliberately does NOT mutate the original edit or reuse
    respond_to_submission -- either would lose the original decision from
    the record, or resurface the whole ORIGINAL round (including every
    other item in it, already resolved and acknowledged rounds ago) in the
    client's "sender responded" banner just because one item changed.
    Instead this creates a single new RedlineEdit, chained back to the one
    being reconsidered via source_edit_id, inside its own one-edit
    origin="owner_reconsideration" RedlineSubmission that arrives already
    responded_at-set -- so the client's banner and history show exactly
    and only the reconsidered item as its own new round, with a visible
    link back to what it updates, and everything else from the original
    round is untouched. See RedlineSubmission.origin and
    RedlineEdit.source_edit_id."""
    if body.decision not in ("accepted", "rejected", "countered"):
        raise HTTPException(400, "decision must be 'accepted', 'rejected', or 'countered'")
    if body.decision == "countered" and not body.counter_value.strip():
        raise HTTPException(400, "Enter a counter value or choose accept/reject instead.")

    edit = _get_owned_edit(session, user, edit_id)
    if edit.decision == "pending":
        raise HTTPException(400, "This redline hasn't been decided yet -- respond to it normally instead of reconsidering.")

    # #26: reject reconsidering an edit that's already been reconsidered once.
    # Without this, two separate Reconsider calls on the same edit each chain
    # back to it via source_edit_id, producing sibling edits rather than a
    # linear chain. superseded_edit_ids (see get_redlines and
    # apply_redline_submission) only marks an edit superseded when something
    # ELSE points back to it -- it can't tell a fork (two children of the same
    # parent) from a normal chain, so neither sibling would ever be marked
    # superseded and either could end up applied, unpredictably overriding
    # the owner's actual latest decision. Enforcing a strictly linear chain
    # here keeps that computation accurate.
    newer = session.exec(
        select(RedlineEdit).where(RedlineEdit.source_edit_id == edit.id)
    ).first()
    if newer is not None:
        raise HTTPException(400, "This redline already has a newer decision -- reconsider that one instead.")

    submission = session.get(RedlineSubmission, edit.submission_id)
    link = session.get(ShareLink, submission.share_link_id)
    gc = session.get(GeneratedContract, link.generated_contract_id)

    new_sub = RedlineSubmission(
        share_link_id=link.id, status="pending", origin="owner_reconsideration",
        responded_at=datetime.utcnow(), client_ack_at=None,
    )
    session.add(new_sub)
    session.commit()
    session.refresh(new_sub)

    new_edit = RedlineEdit(
        submission_id=new_sub.id,
        field_key=edit.field_key, label=edit.label,
        original_value=edit.original_value, proposed_value=edit.proposed_value,
        evaluation=edit.evaluation,
        decision=body.decision,
        # #25/F7-class bug: same fix as respond_to_submission just above --
        # store the owner's exact reconsidered counter text, not a
        # .strip()'d copy that silently eats meaningful whitespace.
        counter_value=body.counter_value if body.decision == "countered" else "",
        location_json=edit.location_json,
        source_edit_id=edit.id,
    )
    session.add(new_edit)
    session.commit()
    session.refresh(new_edit)

    _send_reconsideration_email(request, user, gc, link, new_edit)
    return {"id": new_edit.id, "submission_id": new_sub.id, "decision": new_edit.decision}


@app.delete("/api/redline-edits/{edit_id}/withdraw")
def withdraw_owner_edit(
    edit_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Lets the owner pull back their own still-pending direct edit --
    RedlineSubmission.origin == "owner_edit", see edit_generated_document --
    before the client has acted on it. Ad hoc user report: "why would you
    need to reconsider your own text that you just added -- and have the
    chance to reject or approve it -- you should just have the opportunity
    to remove it instead." Unlike Reconsider (which records a NEW decision
    on top of something the CLIENT already decided), the owner's own
    just-proposed edit was never the owner's call to accept/reject/counter
    in the first place -- the owner IS the counter -- so the only sensible
    action here is to take it back outright, not decide on it again.

    Deletes the RedlineEdit (and its comment thread, if any) outright
    rather than chaining a new decision the way Reconsider does -- there's
    nothing for the client to see or respond to once it's gone, so unlike a
    reconsideration there's no reason to leave a record behind. If it was
    the submission's only edit, the now-empty RedlineSubmission is deleted
    too, so it simply vanishes rather than lingering as an empty round in
    the client's history."""
    edit = _get_owned_edit(session, user, edit_id)
    submission = session.get(RedlineSubmission, edit.submission_id)
    if not submission or submission.origin != "owner_edit":
        raise HTTPException(400, "Only your own pending direct edits can be removed this way.")
    if edit.decision != "countered":
        raise HTTPException(400, "This edit has already been resolved.")
    # Same chain check as #26's reconsider guard just above: if a
    # RedlineEdit has since chained back to this one via source_edit_id,
    # the client has already responded to it (accepted/rejected/countered
    # back), so it's no longer just sitting there waiting -- it can't be
    # silently withdrawn out from under a response that already exists.
    newer = session.exec(
        select(RedlineEdit).where(RedlineEdit.source_edit_id == edit.id)
    ).first()
    if newer is not None:
        raise HTTPException(400, "The client has already responded to this -- it can no longer be removed.")

    for c in session.exec(select(RedlineComment).where(RedlineComment.edit_id == edit.id)).all():
        session.delete(c)
    session.delete(edit)
    session.commit()

    remaining = session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == submission.id)).first()
    if remaining is None:
        session.delete(submission)
        session.commit()
    return {"removed": True}


@app.get("/api/redline-edits/{edit_id}/comments")
def get_edit_comments(edit_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    """Owner-side read of one redline's open comment thread -- used when the
    Redlines modal's inline thread (embedded via get_redlines) needs a
    refresh without reloading the whole modal, e.g. right after posting."""
    edit = _get_owned_edit(session, user, edit_id)
    comments = session.exec(select(RedlineComment).where(RedlineComment.edit_id == edit_id).order_by(RedlineComment.created_at)).all()
    return {"comments": [_comment_payload(c) for c in comments], "comments_resolved": edit.comments_resolved}


@app.post("/api/redline-edits/{edit_id}/comments")
def post_edit_comment(edit_id: int, body: CommentBody, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    """Owner posts into a redline's thread -- open on ANY edit regardless of
    its decision, independent of Phase 1's decision-response flow. No email
    goes out for this -- thread replies are meant to be low-friction back-
    and-forth, not another inbox ping; the client just sees it next time they
    open the thread."""
    edit = _get_owned_edit(session, user, edit_id)
    text = body.body.strip()
    if not text:
        raise HTTPException(400, "Enter a comment before sending.")
    user_name = user.name.strip() or user.email
    comment = RedlineComment(edit_id=edit.id, author_type="owner", author_name=user_name, body=text[:2000])
    session.add(comment)
    # Posting into a resolved thread reopens it -- see RedlineEdit.comments_resolved.
    if edit.comments_resolved:
        edit.comments_resolved = False
        session.add(edit)
    session.commit()
    session.refresh(comment)
    return _comment_payload(comment)


@app.post("/api/redline-edits/{edit_id}/comments/resolve")
def resolve_edit_comments(edit_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    edit = _get_owned_edit(session, user, edit_id)
    edit.comments_resolved = True
    session.add(edit)
    session.commit()
    return {"comments_resolved": True}


@app.post("/api/redline-edits/{edit_id}/comments/reopen")
def reopen_edit_comments(edit_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    """Manual reopen, independent of a new reply auto-reopening -- either
    side should be able to say "this isn't actually settled" without first
    having to post a message just to flip the state."""
    edit = _get_owned_edit(session, user, edit_id)
    edit.comments_resolved = False
    session.add(edit)
    session.commit()
    return {"comments_resolved": False}


@app.get("/api/share/{token}/edits/{edit_id}/comments")
def get_share_edit_comments(token: str, edit_id: int, request: Request, session: Session = Depends(get_session)):
    link = _require_share_session(request, token, session)
    edit = _get_client_edit(session, link, edit_id)
    comments = session.exec(select(RedlineComment).where(RedlineComment.edit_id == edit_id).order_by(RedlineComment.created_at)).all()
    return {"comments": [_comment_payload(c) for c in comments], "comments_resolved": edit.comments_resolved}


@app.post("/api/share/{token}/edits/{edit_id}/comments")
def post_share_edit_comment(token: str, edit_id: int, body: CommentBody, request: Request, session: Session = Depends(get_session)):
    """Client posts into a redline's thread -- open on ANY redline, not just
    a declined one (this is what replaces the old one-shot
    reply_to_redline_edit). Notifies the owner via the in-app bell only, no
    email -- see post_edit_comment's docstring for why."""
    link = _require_share_session(request, token, session)
    edit = _get_client_edit(session, link, edit_id)
    text = body.body.strip()
    if not text:
        raise HTTPException(400, "Enter a comment before sending.")
    author_name = f"{link.client_first_name} {link.client_last_name}".strip() or (link.client_email.strip() or "Reviewer")
    comment = RedlineComment(edit_id=edit.id, author_type="client", author_name=author_name, body=text[:2000])
    session.add(comment)
    if edit.comments_resolved:
        edit.comments_resolved = False
        session.add(edit)
    session.commit()
    session.refresh(comment)

    gc = session.get(GeneratedContract, link.generated_contract_id)
    owner = session.get(User, gc.owner_id) if gc else None
    if owner and gc and owner.notify_redline_comment:
        _notify(
            session, owner.id, "redline_comment",
            title=f'{author_name} commented on a redline in "{gc.name}"',
            body=text[:200],
            generated_contract_id=gc.id,
        )
    return _comment_payload(comment)


@app.post("/api/share/{token}/edits/{edit_id}/comments/resolve")
def resolve_share_edit_comments(token: str, edit_id: int, request: Request, session: Session = Depends(get_session)):
    link = _require_share_session(request, token, session)
    edit = _get_client_edit(session, link, edit_id)
    edit.comments_resolved = True
    session.add(edit)
    session.commit()
    return {"comments_resolved": True}


@app.post("/api/share/{token}/edits/{edit_id}/comments/reopen")
def reopen_share_edit_comments(token: str, edit_id: int, request: Request, session: Session = Depends(get_session)):
    link = _require_share_session(request, token, session)
    edit = _get_client_edit(session, link, edit_id)
    edit.comments_resolved = False
    session.add(edit)
    session.commit()
    return {"comments_resolved": False}


@app.get("/api/share/{token}/download")
def download_share_document(token: str, request: Request, session: Session = Depends(get_session)):
    link = _require_share_session(request, token, session)
    gc = session.get(GeneratedContract, link.generated_contract_id)
    if not gc or not os.path.exists(gc.file_path):
        raise HTTPException(410, "This document is no longer available.")
    safe_name = re.sub(r"[^A-Za-z0-9 _\-]+", "", gc.name).strip() or "Contract"
    return FileResponse(gc.file_path, filename=f"{safe_name}.docx", media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")


class AckResponseBody(BaseModel):
    submission_id: int


@app.post("/api/share/{token}/acknowledge-response")
def acknowledge_response(token: str, body: AckResponseBody, request: Request, session: Session = Depends(get_session)):
    """Marks the owner's batched response as seen, so it doesn't keep
    reappearing on later visits once the client has continued past it. Used
    to also notify the owner (bell + email) that the client saw their
    response -- that was removed as a notification trigger since it fired
    on every visit and generated too much low-value email volume; the
    acknowledgment is still recorded and still drives the "seen" state, it
    just no longer pings the owner."""
    link = _require_share_session(request, token, session)
    submission = session.get(RedlineSubmission, body.submission_id)
    if not submission or submission.share_link_id != link.id:
        raise HTTPException(404, "Response not found.")
    submission.client_ack_at = datetime.utcnow()
    session.add(submission)
    session.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Email drafting: per-account alias, inbound webhook, AI extraction
# ---------------------------------------------------------------------------

_EMAIL_ADDR_RE = re.compile(r"[\w\.\+\-]+@[\w\-]+\.[\w\.\-]+")


def _extract_email_address(header_value: str) -> str:
    m = _EMAIL_ADDR_RE.search(header_value or "")
    return m.group(0) if m else (header_value or "").strip()


def _get_or_create_alias(session: Session, user: User) -> EmailAlias:
    alias = session.exec(select(EmailAlias).where(EmailAlias.user_id == user.id)).first()
    if alias:
        return alias
    company_slug = ee.slugify_company(user.name or user.email.split("@")[0])
    alias = EmailAlias(user_id=user.id, company_slug=company_slug, number=ee.generate_alias_number())
    session.add(alias)
    session.commit()
    session.refresh(alias)
    return alias


@app.get("/api/account/email-alias")
def get_email_alias(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    alias = _get_or_create_alias(session, user)
    return {"address": ee.alias_address(alias.company_slug, alias.number)}


@app.post("/api/account/email-alias/regenerate")
def regenerate_email_alias(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    """Issues a new random number, invalidating the old address. Use this
    if the address ever leaks somewhere it shouldn't have."""
    alias = _get_or_create_alias(session, user)
    alias.number = ee.generate_alias_number()
    session.add(alias)
    session.commit()
    return {"address": ee.alias_address(alias.company_slug, alias.number)}


def _send_missing_info_reply(req: EmailDraftRequest, alias: Optional[EmailAlias], missing_labels: list, no_template: bool):
    reply_to = ee.continuation_address(alias.company_slug, alias.number, req.id) if alias else None
    if no_template:
        body = (
            "Hi,\n\n"
            "I couldn't tell which master document you want drafted. Reply to this email with the document "
            "name or type somewhere in the subject line (for example, Subject: \"Draft: Freelance Services "
            "Agreement\") and I'll pick it up from there.\n\n"
            "- Rotely"
        )
    else:
        lines = "\n".join(f"- {label}" for label in missing_labels)
        body = (
            "Hi,\n\n"
            f"Almost there. I still need the following to finish this draft:\n\n{lines}\n\n"
            "Just reply to this email with those details and I'll generate it right away.\n\n"
            "- Rotely"
        )
    try:
        ee.send_email(req.from_address, f"Re: {req.subject or 'Your draft request'}", body, reply_to=reply_to)
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured yet -- request is still recorded, just no email goes out


def _send_no_such_template_email(req: EmailDraftRequest):
    body = (
        "Hi,\n\n"
        "I couldn't match that to any of your ready master documents (ones with fields already marked). "
        "Reply with the exact document name or document type and I'll try again.\n\n"
        "- Rotely"
    )
    try:
        ee.send_email(req.from_address, f"Re: {req.subject or 'Your draft request'}", body)
    except RuntimeError:
        pass


def _send_plan_limit_email(user: User, req: EmailDraftRequest):
    body = (
        "Hi,\n\n"
        "This would put you over your plan's monthly drafting limit, so I held off generating it. "
        "Upgrade your plan from your account menu in Rotely and reply to this email to try again.\n\n"
        "- Rotely"
    )
    try:
        ee.send_email(req.from_address, f"Re: {req.subject or 'Your draft request'}", body)
    except RuntimeError:
        pass


def _send_redlines_submitted_notification(owner: User, gc: GeneratedContract, link: ShareLink, edit_count: int, note: str):
    """Lets the account owner know redlines came back on a document they
    shared, without them having to think to go check. Reply-To is the
    client's email (if the sender collected one) so replying goes straight
    back to whoever submitted them."""
    who = link.client_email.strip() or "The reviewer"
    # #57: zero edits is a real, allowed outcome now ("looked it over, no
    # changes"), not something that could never reach here -- say that
    # plainly instead of claiming redlines came back when none did.
    if edit_count:
        lines = [f'{who} sent back redlines on "{gc.name}".', f"{edit_count} change{'s' if edit_count != 1 else ''} proposed."]
    else:
        lines = [f'{who} reviewed "{gc.name}" and didn\'t propose any changes.']
    if note:
        lines.append(f'\nTheir note: "{note}"')
    lines.append("\nLog in to your Rotely documents library to review and respond." if edit_count else "\nLog in to your Rotely documents library to see the full review.")
    body = "\n".join(lines) + "\n\n- Rotely"
    try:
        ee.send_email(
            owner.email, f'New redlines on "{gc.name}"', body,
            reply_to=(link.client_email.strip() or None),
        )
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured yet -- the submission is still recorded, just no email goes out


def _notify(session: Session, user_id: int, type_: str, title: str, body: str = "", generated_contract_id: Optional[int] = None):
    """Writes one row to the owner's in-app notification bell. Call sites,
    on purpose (see the Notification model docstring): submit_redlines (a
    client submitted redlines), post_share_edit_comment (a client commented
    in a redline's thread -- ANY redline as of Phase 2 of the redline-
    negotiation overhaul, not just a declined one; bell only, no email --
    see that function's docstring), _apply_signer_completed (one signer
    finished signing but others are still pending; bell only, same reasoning
    as a redline comment -- a mid-flight status update, not big enough for
    email), _apply_submission_completed (everyone has signed; bell +
    email, gated together by notify_signature_events), and
    _apply_signer_declined / _apply_submission_declined (a signer declined,
    which halts the whole request right away unlike a completion -- bell +
    email, same gating; see those functions' docstrings for why only one of
    that pair ever actually fires per decline). Keeping the bell to exactly
    these triggers is a deliberate product decision, not an oversight -- a
    new call site should be a deliberate choice too. (acknowledge_response
    used to be a trigger; it was removed for firing too often with too
    little value -- see that endpoint's docstring.)"""
    session.add(Notification(user_id=user_id, type=type_, title=title, body=body, generated_contract_id=generated_contract_id))
    session.commit()


def _send_ready_notification(user: User, gc: GeneratedContract, file_path: str):
    body = (
        f'Hi,\n\nYour draft "{gc.name}" is ready and saved in your Rotely documents library. '
        "It's attached here as well.\n\n- Rotely"
    )
    attachments = None
    try:
        with open(file_path, "rb") as f:
            attachments = [{
                "filename": f"{gc.name}.docx",
                "content_bytes": f.read(),
                "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }]
    except OSError:
        attachments = None
    try:
        ee.send_email(user.email, f"Your draft is ready: {gc.name}", body, attachments=attachments)
    except RuntimeError:
        pass


def _process_draft_request(session: Session, user: User, req: EmailDraftRequest, subject: str, body_text: str):
    alias = session.exec(select(EmailAlias).where(EmailAlias.user_id == user.id)).first()

    if not req.template_id:
        templates = session.exec(select(Template).where(Template.owner_id == user.id)).all()
        candidates = [{"id": t.id, "name": t.name, "document_type": t.document_type} for t in templates if t.placeholders]
        match = ee.match_template_from_subject(subject, candidates)
        if not match:
            req.status = "awaiting_template"
            session.add(req)
            session.commit()
            _send_missing_info_reply(req, alias, [], no_template=True)
            return
        req.template_id = match["id"]

    tpl = session.get(Template, req.template_id)
    if not tpl:
        req.status = "failed"
        session.add(req)
        session.commit()
        _send_no_such_template_email(req)
        return
    placeholders = [
        {"field_key": p.field_key, "label": p.label, "field_type": p.field_type, "required": p.required}
        for p in tpl.placeholders
    ]

    known_values = json.loads(req.values_json or "{}")
    try:
        new_values = ee.extract_field_values(body_text, placeholders)
    except RuntimeError:
        new_values = {}  # ANTHROPIC_API_KEY not configured -- fall back to asking for everything by name
    known_values.update(new_values)
    req.values_json = json.dumps(known_values)

    missing = ee.compute_missing_required(placeholders, known_values)
    req.missing_fields_json = json.dumps(missing)
    req.updated_at = datetime.utcnow()

    if missing:
        req.status = "awaiting_info"
        session.add(req)
        session.commit()
        labels = [p["label"] for p in placeholders if p["field_key"] in missing]
        _send_missing_info_reply(req, alias, labels, no_template=False)
        return

    # Bug tracker #42 (found on independent review after #39 shipped): this
    # check-then-write quota sequence is the exact same race #39 fixed in
    # generate_contract, just reached via the inbound-email draft path
    # instead of the Generate button. Same fix, same lock: everything from
    # the plan check through the commit that actually spends a slot must be
    # atomic per-user, or a user's in-flight email draft can race their own
    # concurrent Generate call (different threads -- this endpoint's caller,
    # inbound_email, is async/event-loop; generate_contract is sync/thread-
    # pool) and both slip through even when only one slot remains. Reusing
    # _generation_lock_for keeps both paths serialized against each other,
    # not just against themselves.
    with _generation_lock_for(user.id):
        plan = _plan_info(session, user)
        if plan["limit"] is not None and plan["used"] >= plan["limit"]:
            req.status = "failed"
            session.add(req)
            session.commit()
            _send_plan_limit_email(user, req)
            return

        doc = de.load(tpl.working_path)
        field_positions = de.fill_template_tracked(doc, known_values)
        gen_dir = os.path.join(_template_dir(user.id, tpl.id), "generated")
        os.makedirs(gen_dir, exist_ok=True)
        out_path = os.path.join(gen_dir, f"{secrets.token_hex(8)}.docx")
        de.save(doc, out_path)

        safe_name = re.sub(r"[^A-Za-z0-9 _\-]+", "", tpl.name).strip() or "Contract"
        display_name = f"{safe_name} - {datetime.utcnow().strftime('%b %d, %Y')}"
        values_snapshot = [{"label": p.label, "field_key": p.field_key, "value": known_values.get(p.field_key, "")} for p in tpl.placeholders]
        gc = GeneratedContract(
            owner_id=user.id, template_id=tpl.id, template_name=tpl.name, document_type=tpl.document_type,
            name=display_name, file_path=out_path, values_json=json.dumps(values_snapshot),
            field_positions_json=json.dumps(field_positions),
        )
        session.add(gc)
        session.flush()
        _log_generation_event(session, user.id, gc.id)
        req.status = "done"
        session.add(req)
        session.commit()
        session.refresh(gc)
        req.generated_contract_id = gc.id
        session.add(req)
        session.commit()

    _send_ready_notification(user, gc, out_path)


@app.post("/api/email/inbound/{webhook_secret}")
async def inbound_email(webhook_secret: str, request: Request, session: Session = Depends(get_session)):
    """Target for SendGrid's Inbound Parse webhook (configured to POST
    parsed fields, not raw MIME). The path secret stands in for signature
    verification -- keep it out of source control in real deployments (set
    it via the INBOUND_WEBHOOK_SECRET env var and use that exact value when
    configuring the SendGrid route)."""
    if not INBOUND_WEBHOOK_SECRET or not secrets.compare_digest(webhook_secret, INBOUND_WEBHOOK_SECRET):
        raise HTTPException(404)

    form = await request.form()
    to_header = str(form.get("to", "") or form.get("envelope", ""))
    from_header = str(form.get("from", ""))
    subject = str(form.get("subject", ""))
    body_text = str(form.get("text", "") or "")

    parsed = ee.parse_alias(to_header)
    if not parsed:
        return {"ok": False, "reason": "no matching drafting alias in the To: address"}

    alias = session.exec(select(EmailAlias).where(
        EmailAlias.company_slug == parsed["company_slug"],
        EmailAlias.number == parsed["number"],
        EmailAlias.active == True,  # noqa: E712
    )).first()
    if not alias:
        return {"ok": False, "reason": "unknown or deactivated alias"}
    user = session.get(User, alias.user_id)
    if not user:
        return {"ok": False, "reason": "account not found"}

    from_address = _extract_email_address(from_header)

    req = None
    if parsed["continue_request_id"]:
        candidate = session.get(EmailDraftRequest, parsed["continue_request_id"])
        if candidate and candidate.user_id == user.id and candidate.status in ("awaiting_template", "awaiting_info"):
            req = candidate
    if req is None:
        req = EmailDraftRequest(user_id=user.id, from_address=from_address, subject=subject, status="awaiting_template")
        session.add(req)
        session.commit()
        session.refresh(req)

    _process_draft_request(session, user, req, subject, body_text)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Admin dashboard (owner-only, see ADMIN_EMAIL / get_admin_user above)
# ---------------------------------------------------------------------------

def _daily_series(dates: list, days: int = 30) -> list:
    """Buckets a list of datetimes into a fixed-length series of the last
    `days` calendar days (UTC), oldest first, zero-filled where nothing
    happened that day -- what a sparkline/bar chart needs, rather than a
    sparse list that skips empty days."""
    start = (datetime.utcnow() - timedelta(days=days - 1)).date()
    counts = Counter(d.date() for d in dates if d and d.date() >= start)
    return [
        {"date": (start + timedelta(days=i)).isoformat(), "count": counts.get(start + timedelta(days=i), 0)}
        for i in range(days)
    ]


def _dir_size_bytes(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def _user_summary(u: User, tpl_counts: dict, gen_counts: dict) -> dict:
    return {
        "id": u.id,
        "email": u.email,
        "name": u.name,
        "plan": u.plan,
        "created_at": u.created_at.isoformat(),
        "email_verified": u.email_verified,
        "is_suspended": u.is_suspended,
        "template_count": tpl_counts.get(u.id, 0),
        "contract_count": gen_counts.get(u.id, 0),
    }


@app.get("/api/admin/overview")
def admin_overview(admin: User = Depends(get_admin_user), session: Session = Depends(get_session)):
    now = datetime.utcnow()
    users = session.exec(select(User)).all()
    templates = session.exec(select(Template)).all()
    generated = session.exec(select(GeneratedContract)).all()
    share_links_open = len(session.exec(select(ShareLink).where(ShareLink.status == "open")).all())
    redline_pending = len(session.exec(select(RedlineSubmission).where(RedlineSubmission.status == "pending")).all())

    tpl_counts = Counter(t.owner_id for t in templates)
    gen_counts = Counter(g.owner_id for g in generated)
    recent_users = sorted(users, key=lambda u: u.created_at, reverse=True)[:12]

    try:
        disk_total, _disk_used_os, disk_free = shutil.disk_usage(DATA_DIR)
        disk_used = _dir_size_bytes(DATA_DIR)  # actual bytes this app owns, not the whole volume's OS usage
    except OSError:
        disk_total = disk_used = disk_free = 0

    return {
        "totals": {
            "users": len(users),
            "verified_users": sum(1 for u in users if u.email_verified),
            "users_last_7d": sum(1 for u in users if (now - u.created_at).days < 7),
            "users_last_30d": sum(1 for u in users if (now - u.created_at).days < 30),
            "templates": len(templates),
            "generated_contracts": len(generated),
            "generated_last_7d": sum(1 for g in generated if (now - g.created_at).days < 7),
            "generated_last_30d": sum(1 for g in generated if (now - g.created_at).days < 30),
            "share_links_open": share_links_open,
            "redline_pending": redline_pending,
        },
        "users_by_plan": dict(Counter(u.plan for u in users)),
        "signups_series": _daily_series([u.created_at for u in users]),
        "contracts_series": _daily_series([g.created_at for g in generated]),
        "recent_users": [_user_summary(u, tpl_counts, gen_counts) for u in recent_users],
        "system": {
            "disk_used_bytes": disk_used,
            "disk_total_bytes": disk_total,
            "disk_pct": round(disk_used / disk_total * 100, 1) if disk_total else 0,
            "sendgrid_configured": bool(ee.SENDGRID_API_KEY),
            "anthropic_configured": bool(ee.ANTHROPIC_API_KEY),
            "git_commit": (os.environ.get("RENDER_GIT_COMMIT", "") or "local")[:7],
            "render_service": os.environ.get("RENDER_SERVICE_NAME", "local"),
        },
    }


@app.get("/api/admin/users")
def admin_users(admin: User = Depends(get_admin_user), session: Session = Depends(get_session)):
    users = session.exec(select(User).order_by(User.created_at.desc())).all()
    tpl_counts = Counter(
        t.owner_id for t in session.exec(select(Template)).all()
    )
    gen_counts = Counter(
        g.owner_id for g in session.exec(select(GeneratedContract)).all()
    )
    return {"users": [_user_summary(u, tpl_counts, gen_counts) for u in users]}


def _get_admin_target(session: Session, admin: User, user_id: int, *, block_self: bool = False) -> User:
    if block_self and user_id == admin.id:
        raise HTTPException(400, "You can't do that to your own admin account.")
    target = session.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    return target


class AdminSuspendBody(BaseModel):
    suspended: bool


@app.post("/api/admin/users/{user_id}/suspend")
def admin_set_suspended(
    user_id: int, body: AdminSuspendBody,
    admin: User = Depends(get_admin_user), session: Session = Depends(get_session),
):
    target = _get_admin_target(session, admin, user_id, block_self=True)
    target.is_suspended = body.suspended
    session.add(target)
    session.commit()
    return {"id": target.id, "is_suspended": target.is_suspended}


class AdminPlanBody(BaseModel):
    plan: str


@app.post("/api/admin/users/{user_id}/plan")
def admin_set_plan(
    user_id: int, body: AdminPlanBody,
    admin: User = Depends(get_admin_user), session: Session = Depends(get_session),
):
    plan = body.plan.strip().lower()
    if plan not in PLAN_LIMITS:
        raise HTTPException(400, f"Unknown plan '{body.plan}'. Choose one of: {', '.join(PLAN_LIMITS)}.")
    target = _get_admin_target(session, admin, user_id)
    target.plan = plan
    session.add(target)
    session.commit()
    return {"id": target.id, "plan": target.plan}


@app.post("/api/admin/users/{user_id}/resend-verification")
def admin_resend_verification(
    user_id: int, request: Request,
    admin: User = Depends(get_admin_user), session: Session = Depends(get_session),
):
    target = _get_admin_target(session, admin, user_id)
    if target.email_verified:
        return {"ok": True, "sent": False, "message": "This account is already verified."}
    target.verification_token = target.verification_token or secrets.token_urlsafe(32)
    target.verification_sent_at = datetime.utcnow()
    session.add(target)
    session.commit()
    _send_verification_email(request, target)
    return {"ok": True, "sent": True}


def _generate_temp_password() -> str:
    # Ambiguous characters (0/O, 1/l/I) left out so a password relayed by
    # phone or read off a screen doesn't get mistyped.
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(12))
        if not validate_password_strength(pw):
            return pw


@app.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_password(
    user_id: int, request: Request,
    admin: User = Depends(get_admin_user), session: Session = Depends(get_session),
):
    """Sets a new random temporary password and, if SendGrid is configured,
    emails it to the account holder. Always also returns it in the response
    so the admin dashboard can show/copy it -- the only path to recovering
    it if email isn't set up or doesn't land, since it's hashed immediately
    and never stored in plain text."""
    target = _get_admin_target(session, admin, user_id)
    new_password = _generate_temp_password()
    target.password_hash = hash_password(new_password)
    session.add(target)
    session.commit()

    emailed = False
    body = (
        f"Hi{' ' + target.name if target.name else ''},\n\n"
        "An administrator reset the password on your Rotely account. Your new temporary password is:\n\n"
        f"{new_password}\n\n"
        "Please log in and change it as soon as you can.\n\n"
        "- Rotely"
    )
    try:
        ee.send_email(target.email, "Your Rotely password was reset", body)
        emailed = True
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured -- admin still gets the password below to relay manually

    return {"ok": True, "emailed": emailed, "temporary_password": new_password}


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(
    user_id: int,
    admin: User = Depends(get_admin_user), session: Session = Depends(get_session),
):
    """Permanently deletes a user account and everything that traces back to
    it: templates, generated contracts, share links + their views, redline
    submissions/edits + comment threads, generation-quota log rows, in-app
    notifications, email alias, and draft requests -- plus their uploads
    folder on disk. Irreversible; there's no undo/soft-delete for this."""
    target = _get_admin_target(session, admin, user_id, block_self=True)

    generated_ids = [
        g.id for g in session.exec(select(GeneratedContract).where(GeneratedContract.owner_id == user_id)).all()
    ]
    share_link_ids = []
    if generated_ids:
        share_link_ids = [
            s.id for s in session.exec(
                select(ShareLink).where(ShareLink.generated_contract_id.in_(generated_ids))
            ).all()
        ]
    if share_link_ids:
        submission_ids = [
            r.id for r in session.exec(
                select(RedlineSubmission).where(RedlineSubmission.share_link_id.in_(share_link_ids))
            ).all()
        ]
        if submission_ids:
            edit_ids = [
                e.id for e in session.exec(select(RedlineEdit).where(RedlineEdit.submission_id.in_(submission_ids))).all()
            ]
            if edit_ids:
                # Bug tracker #38: comment threads (phase 2 of the redline
                # overhaul) are keyed off RedlineEdit.id, not off this user
                # directly -- deleting the edits below without first
                # clearing their comments left every RedlineComment row
                # dangling on a redlineedit.id that no longer existed.
                for comment in session.exec(select(RedlineComment).where(RedlineComment.edit_id.in_(edit_ids))).all():
                    session.delete(comment)
            for edit in session.exec(select(RedlineEdit).where(RedlineEdit.submission_id.in_(submission_ids))).all():
                session.delete(edit)
            for sub in session.exec(select(RedlineSubmission).where(RedlineSubmission.share_link_id.in_(share_link_ids))).all():
                session.delete(sub)
        for view in session.exec(select(ShareLinkView).where(ShareLinkView.share_link_id.in_(share_link_ids))).all():
            session.delete(view)
        for link in session.exec(select(ShareLink).where(ShareLink.generated_contract_id.in_(generated_ids))).all():
            session.delete(link)

    if generated_ids:
        # Same reasoning as delete_generated_forever above -- SigningRequest/
        # SigningRequestSigner carry a direct FK to a GeneratedContract, not
        # to the user, so they'd otherwise be left dangling by this sweep
        # the same way ShareLink was before bug tracker #38 added the
        # equivalent for RedlineComment. Files on disk (consent photos,
        # signed PDFs) live under this user's uploads folder either way and
        # are cleaned up by the shutil.rmtree below -- no separate
        # os.remove needed here, unlike the single-document delete above.
        signing_request_ids = [
            sr.id for sr in session.exec(
                select(SigningRequest).where(SigningRequest.generated_contract_id.in_(generated_ids))
            ).all()
        ]
        if signing_request_ids:
            for signer in session.exec(
                select(SigningRequestSigner).where(SigningRequestSigner.signing_request_id.in_(signing_request_ids))
            ).all():
                session.delete(signer)
            for sr in session.exec(
                select(SigningRequest).where(SigningRequest.id.in_(signing_request_ids))
            ).all():
                session.delete(sr)

    for gc in session.exec(select(GeneratedContract).where(GeneratedContract.owner_id == user_id)).all():
        session.delete(gc)
    for tpl in session.exec(select(Template).where(Template.owner_id == user_id)).all():
        for ph in session.exec(select(Placeholder).where(Placeholder.template_id == tpl.id)).all():
            session.delete(ph)
        session.delete(tpl)
    for alias in session.exec(select(EmailAlias).where(EmailAlias.user_id == user_id)).all():
        session.delete(alias)
    for req in session.exec(select(EmailDraftRequest).where(EmailDraftRequest.user_id == user_id)).all():
        session.delete(req)
    # Bug tracker #38: this docstring always claimed "everything that traces
    # back to" the user, but these two were never actually deleted --
    # GenerationEvent (the immutable per-generation quota log) and
    # Notification (in-app bell notifications) both carry a direct FK to
    # this user and were left behind as orphaned rows on every deletion.
    for event in session.exec(select(GenerationEvent).where(GenerationEvent.owner_id == user_id)).all():
        session.delete(event)
    for notif in session.exec(select(Notification).where(Notification.user_id == user_id)).all():
        session.delete(notif)

    session.delete(target)
    session.commit()

    shutil.rmtree(os.path.join(UPLOADS_DIR, str(user_id)), ignore_errors=True)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

static_dir = os.path.join(BASE_DIR, "static")


@app.get("/share/{token}")
def share_page(token: str):
    """Serves the standalone (no-login) client redlining page. A real path
    on the server, not a hash route, since this link goes to someone with
    no Rotely account of their own."""
    return FileResponse(os.path.join(static_dir, "share.html"))


@app.get("/sign/{token}")
def sign_page(token: str):
    """Serves the standalone (no-login) consent + photo + signing page --
    same no-account model as /share/{token} above, but deliberately its
    own page rather than reusing share.html/share.js: the two flows
    (redlining vs. signing) don't share any UI once you're past the
    topbar, and keeping them separate avoids one growing a pile of
    conditionals for the other's steps."""
    return FileResponse(os.path.join(static_dir, "sign.html"))


app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
