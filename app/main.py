import os
import re
import json
import shutil
import secrets
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from sqlmodel import Session, select
from pydantic import BaseModel

from .db import init_db, get_session, UPLOADS_DIR
from .models import User, Template, Placeholder, GeneratedContract, PLAN_LIMITS, DEFAULT_PLAN, DOCUMENT_TYPES
from .auth import hash_password, verify_password, get_current_user, get_optional_user
from . import docx_engine as de

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


app = FastAPI(title="Draftly")
app.add_middleware(SessionMiddleware, secret_key=_load_or_create_secret(), same_site="lax")


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


@app.post("/api/register")
def register(body: RegisterBody, request: Request, session: Session = Depends(get_session)):
    email = body.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "Please provide a valid email address")
    if len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    existing = session.exec(select(User).where(User.email == email)).first()
    if existing:
        raise HTTPException(400, "An account with that email already exists")
    user = User(email=email, password_hash=hash_password(body.password), name=body.name.strip())
    session.add(user)
    session.commit()
    session.refresh(user)
    request.session["user_id"] = user.id
    return {"id": user.id, "email": user.email, "name": user.name}


@app.post("/api/login")
def login(body: LoginBody, request: Request, session: Session = Depends(get_session)):
    email = body.email.strip().lower()
    user = session.exec(select(User).where(User.email == email)).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Invalid email or password")
    request.session["user_id"] = user.id
    return {"id": user.id, "email": user.email, "name": user.name}


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


@app.get("/api/me")
def me(user: Optional[User] = Depends(get_optional_user), session: Session = Depends(get_session)):
    if not user:
        return {"user": None}
    return {
        "user": {"id": user.id, "email": user.email, "name": user.name},
        "plan": _plan_info(session, user),
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
            {"id": p.id, "field_key": p.field_key, "label": p.label, "field_type": p.field_type, "required": p.required, "order": p.order}
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


class MarkBody(BaseModel):
    paragraph_index: int
    segments: list[MarkSegment]
    label: str = ""
    field_type: str = "text"
    required: bool = True
    table_path: str = ""
    existing_field_key: str = ""


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
        placeholder = Placeholder(
            template_id=tpl.id,
            field_key=field_key,
            label=label,
            field_type=body.field_type,
            required=body.required,
            order=max_order + 1,
        )
        session.add(placeholder)
        session.commit()
        session.refresh(placeholder)

    doc2 = de.load(tpl.working_path)
    return {
        "placeholder": {"id": placeholder.id, "field_key": placeholder.field_key, "label": placeholder.label, "field_type": placeholder.field_type, "required": placeholder.required},
        "html": de.render_paragraphs_html(doc2),
    }


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
    de.fill_template(doc, body.values)

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
    gc = GeneratedContract(
        owner_id=user.id,
        template_id=tpl.id,
        template_name=tpl.name,
        document_type=tpl.document_type,
        name=display_name,
        file_path=out_path,
        values_json=json.dumps(values_snapshot),
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


@app.get("/api/generated")
def list_generated(
    archived: Optional[bool] = None,
    template_id: Optional[int] = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
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
# Static frontend
# ---------------------------------------------------------------------------

static_dir = os.path.join(BASE_DIR, "static")
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
