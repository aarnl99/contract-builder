"""Duplicating a master document: copies the Word file and every field as an
independent new master document, with a unique 'Name (copy)' name.

Run with:  venv/bin/pytest tests/
"""
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

if "app.db" not in sys.modules:
    os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="rotely_test_duplicate_")

import pytest  # noqa: E402
from docx import Document  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from app import main as m  # noqa: E402
from app.auth import hash_password  # noqa: E402
from app.db import engine, init_db  # noqa: E402
from app.models import GeneratedContract, Placeholder, Template, User  # noqa: E402

init_db()


def _make_user(session, tag):
    u = User(email="dup-%s-%d@x.test" % (tag, time.time_ns()), password_hash=hash_password("pw"),
             email_verified=True, name="Dup " + tag)
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _make_template(session, user, name="Freelance Agreement", fields=2):
    tpl = Template(owner_id=user.id, name=name, document_type="Consulting", original_filename="f.docx", working_path="")
    session.add(tpl)
    session.commit()
    session.refresh(tpl)
    d = m._template_dir(user.id, tpl.id)
    os.makedirs(d, exist_ok=True)
    doc = Document()
    doc.add_paragraph("Between {{client_name}} and {{freelancer}}.")
    orig = os.path.join(d, "original.docx")
    doc.save(orig)
    work = os.path.join(d, "working.docx")
    doc.save(work)
    tpl.working_path = work
    session.add(tpl)
    for i in range(fields):
        session.add(Placeholder(template_id=tpl.id, field_key="f%d" % i, label="Field %d" % i, order=i,
                                threshold_type="approved_list", threshold_config='{"allowed": ["a"]}',
                                preset_options_json='[{"name": "x", "text": "y"}]'))
    session.commit()
    session.refresh(tpl)
    return tpl


@pytest.fixture()
def env():
    with Session(engine) as s:
        owner = _make_user(s, "owner")
        other = _make_user(s, "other")
        tpl = _make_template(s, owner)
        ids = (owner.id, other.id, tpl.id)
    owner_id, other_id, tpl_id = ids

    m.app.dependency_overrides[m.get_current_user] = lambda: _load(owner_id)
    c = TestClient(m.app)
    yield c, owner_id, other_id, tpl_id
    m.app.dependency_overrides.pop(m.get_current_user, None)


def _load(uid):
    with Session(engine) as s:
        u = s.get(User, uid)
        s.expunge(u)
        return u


def test_duplicate_copies_file_and_fields(env):
    c, owner_id, _other, tpl_id = env
    r = c.post("/api/templates/%d/duplicate" % tpl_id)
    assert r.status_code == 200, r.text
    new_id = r.json()["id"]
    assert r.json()["name"] == "Freelance Agreement (copy)"
    assert new_id != tpl_id
    with Session(engine) as s:
        new = s.get(Template, new_id)
        assert new.owner_id == owner_id and new.document_type == "Consulting"
        assert os.path.exists(new.working_path) and new.working_path != s.get(Template, tpl_id).working_path
        assert os.path.exists(os.path.join(m._template_dir(owner_id, new_id), "original.docx"))
        phs = s.exec(select(Placeholder).where(Placeholder.template_id == new_id)).all()
        assert sorted(p.field_key for p in phs) == ["f0", "f1"]
        assert all(p.threshold_type == "approved_list" and "x" in p.preset_options_json for p in phs)
        # originals untouched
        assert len(s.exec(select(Placeholder).where(Placeholder.template_id == tpl_id)).all()) == 2


def test_duplicate_names_are_unique(env):
    c, _o, _x, tpl_id = env
    names = [c.post("/api/templates/%d/duplicate" % tpl_id).json()["name"] for _ in range(3)]
    assert names == ["Freelance Agreement (copy)", "Freelance Agreement (copy 2)", "Freelance Agreement (copy 3)"]
    # duplicating a copy doesn't stack "(copy) (copy)"
    new_id = c.post("/api/templates/%d/duplicate" % tpl_id).json()["id"]
    again = c.post("/api/templates/%d/duplicate" % new_id).json()["name"]
    assert again == "Freelance Agreement (copy 5)"


def test_duplicate_is_independent(env):
    c, owner_id, _x, tpl_id = env
    new_id = c.post("/api/templates/%d/duplicate" % tpl_id).json()["id"]
    assert c.delete("/api/templates/%d" % new_id).status_code == 200
    with Session(engine) as s:
        assert s.get(Template, tpl_id) is not None
        assert os.path.exists(s.get(Template, tpl_id).working_path)
        assert len(s.exec(select(Placeholder).where(Placeholder.template_id == tpl_id)).all()) == 2


def test_cannot_duplicate_someone_elses(env):
    c, _o, other_id, tpl_id = env
    m.app.dependency_overrides[m.get_current_user] = lambda: _load(other_id)
    r = c.post("/api/templates/%d/duplicate" % tpl_id)
    assert r.status_code == 404


def test_missing_file_is_a_clean_error(env):
    c, _o, _x, tpl_id = env
    with Session(engine) as s:
        os.remove(s.get(Template, tpl_id).working_path)
    r = c.post("/api/templates/%d/duplicate" % tpl_id)
    assert r.status_code == 404
    # no half-made copy left behind
    names = [t["name"] for t in c.get("/api/templates").json()]
    assert not any("(copy" in n for n in names)


def test_list_has_last_used_and_field_labels(env):
    c, owner_id, _x, tpl_id = env
    row = [t for t in c.get("/api/templates").json() if t["id"] == tpl_id][0]
    assert row["last_used_at"] is None
    assert row["field_labels"] == ["Field 0", "Field 1"]
    with Session(engine) as s:
        s.add(GeneratedContract(owner_id=owner_id, template_id=tpl_id, template_name="t", name="d",
                                file_path="/x", values_json="[]"))
        s.commit()
    row = [t for t in c.get("/api/templates").json() if t["id"] == tpl_id][0]
    assert row["last_used_at"] is not None
