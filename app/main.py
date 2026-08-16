import os
import re
import json
import shutil
import secrets
import string
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
    User, Template, Placeholder, GeneratedContract, PLAN_LIMITS, DEFAULT_PLAN, DOCUMENT_TYPES,
    ShareLink, ShareLinkView, RedlineSubmission, RedlineEdit, EmailAlias, EmailDraftRequest, Notification,
)
from .auth import hash_password, verify_password, validate_password_strength, get_current_user, get_optional_user
from . import docx_engine as de
from . import redline_engine as rl
from . import email_engine as ee

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

app = FastAPI(title="Rotely")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, same_site="lax")

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


class LoginBody(BaseModel):
    email: str
    password: str


class ResendVerificationBody(BaseModel):
    email: str


RESEND_VERIFICATION_COOLDOWN = 60  # seconds -- keeps "resend" from being spammed


def _base_url(request: Request) -> str:
    """Absolute origin for building links that go out in email (e.g. the
    verify-email link), since those are opened outside this app's own
    hash-routed pages and need a real, fully-qualified URL."""
    return f"{request.url.scheme}://{request.url.netloc}"


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


@app.post("/api/register")
def register(body: RegisterBody, request: Request, session: Session = Depends(get_session)):
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


@app.post("/api/login")
def login(body: LoginBody, request: Request, session: Session = Depends(get_session)):
    email = body.email.strip().lower()
    user = session.exec(select(User).where(User.email == email)).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Invalid email or password")
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
def google_auth_start(request: Request):
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(503, "Google sign-in isn't configured on this deploy.")
    state = secrets.token_urlsafe(24)
    request.session["google_oauth_state"] = state
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
    if not user:
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
    rows = session.exec(
        select(GeneratedContract).where(
            GeneratedContract.owner_id == user_id,
            GeneratedContract.created_at >= _month_start(),
        )
    ).all()
    return len(rows)


def _plan_info(session: Session, user: User) -> dict:
    limit = PLAN_LIMITS.get(user.plan, PLAN_LIMITS[DEFAULT_PLAN])
    used = _usage_this_month(session, user.id)
    return {
        "plan": user.plan,
        "limit": limit,
        "used": used,
        "remaining": None if limit is None else max(0, limit - used),
    }


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


# ---------------------------------------------------------------------------
# Notifications -- the bell in the topbar. Deliberately narrow: the only two
# things that ever create a row are a client submitting redlines and a
# client acknowledging the owner's response (see _notify's call sites).
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
    unread_count = len([n for n in rows if n.read_at is None])
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


@app.post("/api/templates")
def upload_template(
    name: str = Form(...),
    document_type: str = Form("Other"),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not file.filename.lower().endswith(".docx"):
        raise HTTPException(400, "Please upload a .docx file (Word format).")

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
    with open(original_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    shutil.copyfile(original_path, working_path)

    # Validate it actually opens as a docx
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
    de.fill_template(doc, {ph.field_key: ph.label})
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
    shutil.rmtree(_template_dir(user.id, tpl.id), ignore_errors=True)
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

    plan = _plan_info(session, user)
    if plan["limit"] is not None and plan["used"] >= plan["limit"]:
        raise HTTPException(
            402,
            f"You have used all {plan['limit']} contracts included in your {user.plan} plan this month. "
            f"Upgrade your plan to draft more.",
        )

    missing = [p.label for p in tpl.placeholders if p.required and not (body.values.get(p.field_key) or "").strip()]
    if missing:
        raise HTTPException(400, f"Missing required fields: {', '.join(missing)}")

    doc = de.load(tpl.working_path)
    field_positions = de.fill_template_tracked(doc, body.values)

    gen_dir = os.path.join(_template_dir(user.id, tpl.id), "generated")
    os.makedirs(gen_dir, exist_ok=True)
    out_path = os.path.join(gen_dir, f"{secrets.token_hex(8)}.docx")
    de.save(doc, out_path)

    safe_name = re.sub(r"[^A-Za-z0-9 _\-]+", "", tpl.name).strip() or "Contract"
    display_name = f"{safe_name} - {datetime.utcnow().strftime('%b %d, %Y')}"

    values_snapshot = [
        {"label": p.label, "field_key": p.field_key, "value": body.values.get(p.field_key, "")}
        for p in tpl.placeholders
    ]
    parties = [p.strip() for p in body.parties if p.strip()][:6]
    gc = GeneratedContract(
        owner_id=user.id,
        template_id=tpl.id,
        template_name=tpl.name,
        document_type=tpl.document_type,
        name=display_name,
        file_path=out_path,
        values_json=json.dumps(values_snapshot),
        field_positions_json=json.dumps(field_positions),
        parties_json=json.dumps(parties),
    )
    session.add(gc)
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
    A redlined-and-applied document's parent is found by walking
    source_submission_id -> RedlineSubmission.share_link_id ->
    ShareLink.generated_contract_id; a directly-edited revision's parent is
    just source_generated_id. Either way the walk continues back until a
    document with no parent is reached. Defensive about broken chains (a
    deleted parent, etc.) -- those just fall back to being their own root
    rather than erroring."""
    by_id = {g.id: g for g in rows}
    sub_ids = {g.source_submission_id for g in rows if g.source_submission_id}
    subs = {}
    if sub_ids:
        subs = {s.id: s for s in session.exec(select(RedlineSubmission).where(RedlineSubmission.id.in_(sub_ids))).all()}
    link_ids = {s.share_link_id for s in subs.values()}
    links = {}
    if link_ids:
        links = {l.id: l for l in session.exec(select(ShareLink).where(ShareLink.id.in_(link_ids))).all()}

    roots: dict = {}

    def _parent_id(gc):
        if gc.source_submission_id:
            sub = subs.get(gc.source_submission_id)
            link = links.get(sub.share_link_id) if sub else None
            return link.generated_contract_id if link else None
        if gc.source_generated_id:
            return gc.source_generated_id
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
        events.append({
            "type": "redline_submitted", "at": s.submitted_at.isoformat() + "Z",
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
        }
        for g in rows
    ]


@app.get("/api/generated/{generated_id}")
def get_generated(generated_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    gc = _get_owned_generated(session, user, generated_id)
    html = None
    if os.path.exists(gc.file_path):
        html = de.render_paragraphs_html(de.load(gc.file_path))
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
    never sends redline threshold rules to the client."""
    full = _lineage_timeline(gc, session)
    return {
        "revision_count": len(full["documents"]),
        "timeline": [{"type": e["type"], "at": e["at"]} for e in full["timeline"]],
    }


class DirectEditBody(BaseModel):
    table_path: str = ""
    paragraph_index: int
    segments: list  # [{"r": int, "start": int, "end": int}, ...] -- same shape the browser already captures for template field-marking and redlining
    new_text: str


@app.post("/api/generated/{generated_id}/edit")
def edit_generated_document(
    generated_id: int,
    body: DirectEditBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Owner-side direct editing: select a chunk of text right in the
    generated document and replace it, applied immediately -- no client
    approval step, since it's the owner editing their own document. Reuses
    the exact same docx-splicing engine as accepted redlines
    (docx_engine.apply_text_edits), and saves the result as a new revision
    so it slots into the same lineage/history trail as redlines do (see
    GeneratedContract.source_generated_id)."""
    gc = _get_owned_generated(session, user, generated_id)
    if not os.path.exists(gc.file_path):
        raise HTTPException(410, "This file is no longer available.")
    if not body.segments:
        raise HTTPException(400, "No selection to edit.")

    container_path = (
        [[int(x) for x in triple.split(",")] for triple in body.table_path.split(";")]
        if body.table_path else []
    )

    doc = de.load(gc.file_path)
    try:
        de.apply_text_edits(doc, [{
            "container_path": container_path,
            "paragraph_index": body.paragraph_index,
            "segments": body.segments,
            "new_text": body.new_text,
        }])
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
    )
    session.add(new_gc)
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
    session.commit()
    return {"id": gc.id, "archived": gc.archived}


@app.delete("/api/generated/{generated_id}")
def delete_generated_forever(generated_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    gc = _get_owned_generated(session, user, generated_id)
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
        "sender_email": link.sender_email,
        "url": f"/share/{link.token}",
        "status": link.status,
        "created_at": link.created_at.isoformat(),
        "last_viewed_at": link.last_viewed_at.isoformat() if link.last_viewed_at else None,
    }


def _generate_access_code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(8))


class CreateShareBody(BaseModel):
    client_email: str = ""  # optional -- shown to the client as "Editing as"
    # Optional override for what the client sees as the sender's contact
    # email -- falls back to the account's own login email when blank.
    sender_email: str = ""


@app.post("/api/generated/{generated_id}/share")
def create_share_link(
    generated_id: int,
    body: CreateShareBody = CreateShareBody(),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Returns the account's existing open share link for this document if
    there is one, otherwise creates a new one with a fresh access code."""
    gc = _get_owned_generated(session, user, generated_id)
    client_email = body.client_email.strip()[:200]
    sender_email = body.sender_email.strip()[:200]
    existing = session.exec(
        select(ShareLink).where(ShareLink.generated_contract_id == gc.id, ShareLink.status == "open")
    ).first()
    if existing:
        changed = False
        if client_email and client_email != existing.client_email:
            existing.client_email = client_email
            changed = True
        if sender_email != existing.sender_email:
            existing.sender_email = sender_email
            changed = True
        if changed:
            session.add(existing)
            session.commit()
            session.refresh(existing)
        return _share_link_payload(existing)
    link = ShareLink(
        generated_contract_id=gc.id, token=secrets.token_urlsafe(16), access_code=_generate_access_code(),
        client_email=client_email, sender_email=sender_email,
    )
    session.add(link)
    session.commit()
    session.refresh(link)
    return _share_link_payload(link)


@app.post("/api/generated/{generated_id}/share/close")
def close_share_link(
    generated_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    gc = _get_owned_generated(session, user, generated_id)
    link = session.exec(
        select(ShareLink).where(ShareLink.generated_contract_id == gc.id, ShareLink.status == "open")
    ).first()
    if not link:
        raise HTTPException(404, "No open review link for this document.")
    link.status = "closed"
    session.add(link)
    session.commit()
    return {"ok": True}


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

    link = session.exec(
        select(ShareLink).where(ShareLink.generated_contract_id == gc.id).order_by(ShareLink.created_at.desc())
    ).first()

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

    if not link:
        return {"header": header, "share": None, "submissions": []}

    # "draft" submissions are just the client's in-progress "Save progress"
    # state -- not a real submission yet, so the owner never sees them here.
    submissions = session.exec(
        select(RedlineSubmission)
        .where(RedlineSubmission.share_link_id == link.id, RedlineSubmission.status != "draft")
        .order_by(RedlineSubmission.submitted_at.desc())
    ).all()
    out = []
    for s in submissions:
        edits = session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == s.id)).all()
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
            })
        out.append({
            "id": s.id,
            "note": s.note,
            "submitted_at": s.submitted_at.isoformat(),
            "status": s.status,
            "responded_at": s.responded_at.isoformat() if s.responded_at else None,
            "edits": edit_rows,
        })
    return {"header": header, "share": _share_link_payload(link), "submissions": out}


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

    for item in body.decisions:
        if item.decision not in ("accepted", "rejected", "countered"):
            raise HTTPException(400, "decision must be 'accepted', 'rejected', or 'countered'")
        edit = edits_by_id.get(item.edit_id)
        if not edit:
            raise HTTPException(400, "One of those redlines no longer exists.")
        if item.decision == "countered" and not item.counter_value.strip():
            raise HTTPException(400, f"Enter a counter value for \"{edit.label}\" or choose accept/reject instead.")
        edit.decision = item.decision
        edit.counter_value = item.counter_value.strip() if item.decision == "countered" else ""
        session.add(edit)

    submission.responded_at = datetime.utcnow()
    submission.client_ack_at = None  # a new response always needs a fresh look from the client
    session.add(submission)
    session.commit()
    return {"id": submission.id, "responded_at": submission.responded_at.isoformat()}


@app.post("/api/redline-submissions/{submission_id}/apply")
def apply_redline_submission(
    submission_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Applies every accepted edit (anything explicitly accepted, plus
    anything auto-approved that the owner hasn't overridden by rejecting
    it) directly onto the exact document that was shared -- splicing each
    edit's new text in at its recorded location, rather than regenerating
    the whole document from the master template with a field_key -> value
    map. That's what makes redlining two occurrences of the same field
    independently correct: each occurrence has its own location, so
    changing one never touches the other. Produces a new GeneratedContract
    row, same as a normal draft, so the version history stays intact. Not
    counted against the monthly plan limit -- this is finishing a document
    already in progress, not starting a new one."""
    submission = session.get(RedlineSubmission, submission_id)
    if not submission:
        raise HTTPException(404, "Submission not found")
    link = session.get(ShareLink, submission.share_link_id)
    gc = session.get(GeneratedContract, link.generated_contract_id) if link else None
    if not gc or gc.owner_id != user.id:
        raise HTTPException(404, "Submission not found")
    tpl = session.get(Template, gc.template_id) if gc.template_id else None
    if not tpl:
        raise HTTPException(400, "The master document this was drafted from no longer exists.")
    if not os.path.exists(gc.file_path):
        raise HTTPException(410, "This document is no longer available.")

    edits = session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == submission.id)).all()
    to_apply = [e for e in edits if e.decision == "accepted" or (e.decision == "pending" and e.evaluation == "auto_approved")]
    if not to_apply:
        raise HTTPException(400, "No accepted edits to apply yet.")

    edit_targets = []  # (RedlineEdit, location dict) -- only edits with a still-usable recorded location
    for e in to_apply:
        loc = json.loads(e.location_json or "{}")
        if loc.get("segments"):
            edit_targets.append((e, loc))
    if not edit_targets:
        raise HTTPException(400, "None of the accepted edits have a usable location to apply anymore.")

    doc = de.load(gc.file_path)
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
        owner_id=user.id, template_id=tpl.id, template_name=tpl.name, document_type=tpl.document_type,
        name=display_name, file_path=out_path, values_json=json.dumps(values_snapshot),
        field_positions_json=gc.field_positions_json,
        parties_json=gc.parties_json,  # carry the parties forward from the original draft
        source_submission_id=submission.id,
    )
    session.add(new_gc)

    applied_ids = {e.id for e, _ in edit_targets}
    for e in to_apply:
        if e.id in applied_ids and e.decision == "pending":
            e.decision = "accepted"
            session.add(e)
    submission.status = "reviewed"
    session.add(submission)
    session.commit()
    session.refresh(new_gc)

    preview_doc = de.load(out_path)
    return {"generated_id": new_gc.id, "name": new_gc.name, "html": de.render_paragraphs_html(preview_doc)}


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
                    "location": json.loads(e.location_json or "{}") or None,
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
            "edits": [
                {
                    "field_key": e.field_key, "label": e.label,
                    "proposed_value": e.proposed_value, "decision": e.decision, "counter_value": e.counter_value,
                    "location": json.loads(e.location_json or "{}") or None,
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
        "sender_email": sender_email,
        "draft": draft_payload,
        "response": response_payload,
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


class ShareSubmitBody(BaseModel):
    edits: list[ShareEditBody]
    note: str = ""


def _resolve_edits(session: Session, gc: GeneratedContract, edits_in: list[ShareEditBody]):
    """Shared between save-progress and submit: re-reads each proposed
    edit's *current* text directly from the generated document at its exact
    recorded location (rather than trusting whatever the browser sent) so a
    stale or malformed selection is rejected here, and computes each field
    edit's threshold evaluation. Returns a list of kwargs dicts ready for
    RedlineEdit(...)."""
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
        if proposed == original_text.strip():
            continue  # not actually a change

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
            proposed_value=proposed,
            comment=e.comment.strip()[:1000],
            evaluation=evaluation,
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

    resolved = _resolve_edits(session, gc, body.edits)

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
    if not body.edits and not body.note.strip():
        raise HTTPException(400, "No changes or comments were provided.")

    resolved = _resolve_edits(session, gc, body.edits)

    # Finalizing replaces any in-progress "Save progress" draft -- it's now
    # a real submission, not a draft anymore.
    draft = _existing_draft(session, link.id)
    if draft:
        for old_edit in session.exec(select(RedlineEdit).where(RedlineEdit.submission_id == draft.id)).all():
            session.delete(old_edit)
        session.delete(draft)
        session.commit()

    submission = RedlineSubmission(share_link_id=link.id, note=body.note.strip()[:2000], status="pending")
    session.add(submission)
    session.commit()
    session.refresh(submission)

    for kwargs in resolved:
        session.add(RedlineEdit(submission_id=submission.id, **kwargs))
    session.commit()

    owner = session.get(User, gc.owner_id)
    if owner:
        _send_redlines_submitted_notification(owner, gc, link, len(resolved), body.note.strip())
        who = link.client_email.strip() or "A reviewer"
        _notify(
            session, owner.id, "redline_submitted",
            title=f'{who} sent redlines on "{gc.name}"',
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
    reappearing on later visits once the client has continued past it. Also
    the second (and last) trigger for the owner's notification bell -- the
    owner learns the client actually looked at their accept/reject/counter
    call, without needing to keep checking back themselves."""
    link = _require_share_session(request, token, session)
    submission = session.get(RedlineSubmission, body.submission_id)
    if not submission or submission.share_link_id != link.id:
        raise HTTPException(404, "Response not found.")
    submission.client_ack_at = datetime.utcnow()
    session.add(submission)
    session.commit()

    gc = session.get(GeneratedContract, link.generated_contract_id)
    owner = session.get(User, gc.owner_id) if gc else None
    if owner and gc:
        _send_response_acknowledged_notification(owner, gc, link)
        who = link.client_email.strip() or "The reviewer"
        _notify(
            session, owner.id, "response_acknowledged",
            title=f'{who} saw your response on "{gc.name}"',
            generated_contract_id=gc.id,
        )
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
    lines = [f'{who} sent back redlines on "{gc.name}".']
    if edit_count:
        lines.append(f"{edit_count} change{'s' if edit_count != 1 else ''} proposed.")
    if note:
        lines.append(f'\nTheir note: "{note}"')
    lines.append("\nLog in to your Rotely documents library to review and respond.")
    body = "\n".join(lines) + "\n\n- Rotely"
    try:
        ee.send_email(
            owner.email, f'New redlines on "{gc.name}"', body,
            reply_to=(link.client_email.strip() or None),
        )
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured yet -- the submission is still recorded, just no email goes out


def _send_response_acknowledged_notification(owner: User, gc: GeneratedContract, link: ShareLink):
    """Lets the owner know the client actually opened and moved past their
    accept/reject/counter response, the second (and last) of the two
    triggers for owner-facing notifications -- see acknowledge_response."""
    who = link.client_email.strip() or "The reviewer"
    body = (
        f'{who} saw your response on "{gc.name}" and continued.\n\n'
        "Log in to your Rotely documents library for the full history.\n\n- Rotely"
    )
    try:
        ee.send_email(
            owner.email, f'{who} saw your response on "{gc.name}"', body,
            reply_to=(link.client_email.strip() or None),
        )
    except RuntimeError:
        pass  # SENDGRID_API_KEY not configured yet -- the in-app notification below still lands either way


def _notify(session: Session, user_id: int, type_: str, title: str, body: str = "", generated_contract_id: Optional[int] = None):
    """Writes one row to the owner's in-app notification bell. The ONLY two
    call sites for this, on purpose (see the Notification model docstring):
    submit_redlines (a client submitted redlines) and acknowledge_response
    (a client acknowledged the owner's response). Nothing else should call
    this -- keeping the bell to exactly those two triggers is a deliberate
    product decision, not an oversight."""
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
    submissions/edits, email alias, and draft requests -- plus their uploads
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
            for edit in session.exec(select(RedlineEdit).where(RedlineEdit.submission_id.in_(submission_ids))).all():
                session.delete(edit)
            for sub in session.exec(select(RedlineSubmission).where(RedlineSubmission.share_link_id.in_(share_link_ids))).all():
                session.delete(sub)
        for view in session.exec(select(ShareLinkView).where(ShareLinkView.share_link_id.in_(share_link_ids))).all():
            session.delete(view)
        for link in session.exec(select(ShareLink).where(ShareLink.generated_contract_id.in_(generated_ids))).all():
            session.delete(link)

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


app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
