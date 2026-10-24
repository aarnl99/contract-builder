"""Client redlines beyond replace: a pure insert, a comment-only note, a delete,
and a whole new paragraph (with bold/italic/underline). Covers the engine and
the submit -> accept -> apply path end to end.

Run with:  venv/bin/pytest tests/
"""
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402
from docx import Document  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from test_multi_signer import env  # noqa: E402,F401
from app import docx_engine as de  # noqa: E402
from app import main as m  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import GeneratedContract, RedlineEdit, RedlineSubmission, ShareLink, Template  # noqa: E402


def _doc(paras):
    d = Document()
    for t in paras:
        d.add_paragraph(t)
    return d


def _texts(d):
    return [p.text for p in d.paragraphs]


# ---------- engine ----------

def test_clean_format_orders_and_dedupes():
    assert de.clean_format("uib") == "biu"
    assert de.clean_format("bbx") == "b"
    assert de.clean_format("") == ""


def test_new_paragraph_inserted_after_target_with_format():
    d = _doc(["a. First", "b. Second", "c. Third"])
    de.apply_text_edits(d, [{"container_path": [], "paragraph_index": 1, "segments": [],
                             "new_paragraph": True, "new_text": "b.1 Added", "format": "bi"}])
    assert _texts(d) == ["a. First", "b. Second", "b.1 Added", "c. Third"]
    run = d.paragraphs[2].runs[0]
    assert run.bold and run.italic and not run.underline


def test_two_new_paragraphs_after_same_target_keep_order():
    d = _doc(["one", "two"])
    de.apply_text_edits(d, [
        {"container_path": [], "paragraph_index": 0, "segments": [], "new_paragraph": True, "new_text": "X"},
        {"container_path": [], "paragraph_index": 0, "segments": [], "new_paragraph": True, "new_text": "Y"},
    ])
    assert _texts(d) == ["one", "X", "Y", "two"]


def test_new_paragraph_on_bad_index_or_empty_text_raises():
    d = _doc(["one"])
    with pytest.raises(de.MarkError):
        de.apply_text_edits(d, [{"container_path": [], "paragraph_index": 9, "segments": [],
                                 "new_paragraph": True, "new_text": "x"}])
    with pytest.raises(de.MarkError):
        de.apply_text_edits(d, [{"container_path": [], "paragraph_index": 0, "segments": [],
                                 "new_paragraph": True, "new_text": ""}])


def test_pure_insert_and_formatted_insert():
    d = _doc(["The fee is due"])
    de.apply_text_edits(d, [{"container_path": [], "paragraph_index": 0,
                             "segments": [{"r": 0, "start": 11, "end": 11}], "new_text": "in full ", "format": "b"}])
    assert d.paragraphs[0].text == "The fee is in full due"
    assert any(r.bold and r.text == "in full " for r in d.paragraphs[0].runs)


def test_new_paragraph_keeps_automatic_numbering():
    d = _doc(["Clause one"])
    p = d.paragraphs[0]
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    ppr = p._p.get_or_add_pPr()
    num = OxmlElement("w:numPr")
    il = OxmlElement("w:ilvl"); il.set(qn("w:val"), "0")
    ni = OxmlElement("w:numId"); ni.set(qn("w:val"), "1")
    num.append(il); num.append(ni); ppr.append(num)
    de.apply_text_edits(d, [{"container_path": [], "paragraph_index": 0, "segments": [],
                             "new_paragraph": True, "new_text": "Clause two"}])
    new = d.paragraphs[1]
    assert new._p.pPr is not None and new._p.pPr.find(qn("w:numPr")) is not None


# ---------- server ----------

def _link(env):
    with Session(engine) as s:
        gc = s.get(GeneratedContract, env.gid)
        if not gc.template_id:
            tpl = Template(owner_id=gc.owner_id, name="T", document_type="Other", original_filename="t.docx",
                           working_path=gc.file_path, finalized=True)
            s.add(tpl)
            s.commit()
            s.refresh(tpl)
            gc.template_id = tpl.id
            s.add(gc)
            s.commit()
        link = ShareLink(generated_contract_id=env.gid, token="tok-%d" % time.time_ns(), access_code="ABCD",
                         client_email="client@x.test", client_first_name="Jamie", client_last_name="Client")
        s.add(link)
        s.commit()
        s.refresh(link)
        return link.token, link.id


def _submit(env, token, link_id, edits):
    return TestClient(m.app).post(f"/api/share/{token}/submit", json={"edits": edits, "note": ""},
                                  headers={"x-share-session": m._issue_share_session(link_id)})


def _new_para_edit(idx, text, fmt=""):
    return {"proposed_value": text, "location": {"paragraph_index": idx, "segments": [],
                                                 "new_paragraph": True, "format": fmt}}


def _latest_edits(link_id):
    with Session(engine) as s:
        sub = s.exec(select(RedlineSubmission).where(RedlineSubmission.share_link_id == link_id)
                     .order_by(RedlineSubmission.id.desc())).first()
        return sub.id, s.exec(select(RedlineEdit).where(RedlineEdit.submission_id == sub.id)).all()


def _accept_all_and_apply(env, sub_id, edits):
    r = env.post(f"/api/redline-submissions/{sub_id}/respond",
                 json={"decisions": [{"edit_id": e.id, "decision": "accepted"} for e in edits]})
    assert r.status_code == 200, r.text
    return env.post(f"/api/redline-submissions/{sub_id}/apply")


def test_client_new_paragraph_round_trip(env):
    token, link_id = _link(env)
    r = _submit(env, token, link_id, [_new_para_edit(1, "Casey adds: a new clause", "bu")])
    assert r.status_code == 200, r.text
    sub_id, edits = _latest_edits(link_id)
    assert len(edits) == 1
    import json
    loc = json.loads(edits[0].location_json)
    assert loc["new_paragraph"] is True and loc["format"] == "bu" and loc["anchor"].startswith("CFO signs")
    assert edits[0].original_value == ""

    r = _accept_all_and_apply(env, sub_id, edits)
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        gcs = s.exec(select(GeneratedContract).order_by(GeneratedContract.id.desc())).first()
        d = Document(gcs.file_path)
    texts = _texts(d)
    i = next(k for k, t in enumerate(texts) if t.startswith("CFO signs"))
    assert texts[i + 1] == "Casey adds: a new clause"
    assert d.paragraphs[i + 1].runs[0].bold and d.paragraphs[i + 1].runs[0].underline


def test_empty_new_paragraph_is_ignored_and_bad_index_rejected(env):
    token, link_id = _link(env)
    assert _submit(env, token, link_id, [_new_para_edit(1, "   ")]).status_code == 200
    with Session(engine) as s:
        sub = s.exec(select(RedlineSubmission).where(RedlineSubmission.share_link_id == link_id)).first()
        assert not s.exec(select(RedlineEdit).where(RedlineEdit.submission_id == sub.id)).all()
    token, link_id = _link(env)
    assert _submit(env, token, link_id, [_new_para_edit(99, "x")]).status_code == 400


def test_pure_insert_from_client_keeps_spaces_and_applies(env):
    token, link_id = _link(env)
    edit = {"proposed_value": " (and more)", "location": {
        "paragraph_index": 0, "segments": [{"r": 0, "start": 11, "end": 11}], "format": "i"}}
    r = _submit(env, token, link_id, [edit])
    assert r.status_code == 200, r.text
    sub_id, edits = _latest_edits(link_id)
    assert edits[0].proposed_value == " (and more)"
    assert _accept_all_and_apply(env, sub_id, edits).status_code == 200
    with Session(engine) as s:
        gc = s.exec(select(GeneratedContract).order_by(GeneratedContract.id.desc())).first()
        d = Document(gc.file_path)
    assert d.paragraphs[0].text == "CEO signs:  (and more)______"


def test_apply_flags_stale_new_paragraph(env):
    token, link_id = _link(env)
    assert _submit(env, token, link_id, [_new_para_edit(1, "late addition")]).status_code == 200
    sub_id, edits = _latest_edits(link_id)
    # The document changes underneath: paragraph 1 is no longer the one the client saw.
    with Session(engine) as s:
        gc = s.get(GeneratedContract, env.gid)
        d = Document(gc.file_path)
        d.paragraphs[1].insert_paragraph_before("Brand new opener")
        d.save(gc.file_path)
    r = _accept_all_and_apply(env, sub_id, edits)
    assert r.status_code == 400 and "document has changed" in r.text, r.text


# ---------- owner direct edits ----------

def test_owner_direct_new_paragraph_and_insert_instant(env):
    r = env.post(f"/api/generated/{env.gid}/edit", json={"edits": [
        {"paragraph_index": 0, "segments": [], "new_text": "Owner adds a line", "format": "i", "new_paragraph": True},
        {"paragraph_index": 2, "segments": [{"r": 0, "start": 11, "end": 11}], "new_text": "(Client) ", "format": ""},
    ]})
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        gc = s.exec(select(GeneratedContract).where(GeneratedContract.owner_id == s.get(GeneratedContract, env.gid).owner_id)
                    .order_by(GeneratedContract.id.desc())).first()
        d = Document(gc.file_path)
    texts = _texts(d)
    assert texts[:2] == ["CEO signs: ______", "Owner adds a line"]
    assert any("(Client) " in t for t in texts)
    assert d.paragraphs[1].runs[0].italic


def test_owner_direct_new_paragraph_queued_when_link_open(env):
    token, link_id = _link(env)
    # an open share link means the edit goes to the client as a counter, not straight into the document
    assert _submit(env, token, link_id, []).status_code == 200
    r = env.post(f"/api/generated/{env.gid}/edit", json={"edits": [
        {"paragraph_index": 0, "segments": [], "new_text": "Owner proposes this", "format": "b", "new_paragraph": True}]})
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        rows = s.exec(select(RedlineEdit).where(RedlineEdit.counter_value == "Owner proposes this")).all()
    assert rows, "queued owner edit should be stored as a countered redline"
    import json
    loc = json.loads(rows[0].location_json)
    assert loc["new_paragraph"] is True and loc["format"] == "b"


def test_owner_direct_new_paragraph_empty_is_rejected(env):
    r = env.post(f"/api/generated/{env.gid}/edit", json={"edits": [
        {"paragraph_index": 0, "segments": [], "new_text": "  ", "new_paragraph": True}]})
    assert r.status_code == 400, r.text
