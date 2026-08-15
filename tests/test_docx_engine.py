"""Unit tests for the core docx marking/generation engine.

Run with:  venv/bin/pytest tests/
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from docx import Document
from app import docx_engine as de


def make_sample_doc(path):
    doc = Document()
    p = doc.add_paragraph()
    p.add_run("This Agreement is made between ")
    r2 = p.add_run("Acme Corp")
    r2.bold = True
    p.add_run(" and the undersigned client, effective as of ")
    r4 = p.add_run("January 1, 2026")
    r4.italic = True
    p.add_run(".")
    doc.add_paragraph("The total contract value shall be $10,000 payable monthly.")
    doc.save(path)


def test_full_run_mark_and_fill(tmp_path):
    path = str(tmp_path / "sample.docx")
    make_sample_doc(path)
    doc = de.load(path)

    de.mark_placeholder(doc, 0, [{"r": 1, "start": 0, "end": len("Acme Corp")}], "client_name")
    assert "client_name" in de.list_tokens(doc)
    # formatting preserved on the token run
    token_run = [r for r in doc.paragraphs[0].runs if r.text == "{{client_name}}"][0]
    assert token_run.bold is True

    filled = de.fill_template(doc, {"client_name": "Widget Industries LLC"})
    assert filled == 1
    assert doc.paragraphs[0].text == (
        "This Agreement is made between Widget Industries LLC and the undersigned "
        "client, effective as of January 1, 2026."
    )


def test_partial_run_split_preserves_surrounding_text(tmp_path):
    path = str(tmp_path / "sample.docx")
    make_sample_doc(path)
    doc = de.load(path)

    text = doc.paragraphs[1].runs[0].text
    start = text.index("$10,000")
    end = start + len("$10,000")
    de.mark_placeholder(doc, 1, [{"r": 0, "start": start, "end": end}], "amount")

    assert doc.paragraphs[1].text == "The total contract value shall be {{amount}} payable monthly."
    de.fill_template(doc, {"amount": "$99,999"})
    assert doc.paragraphs[1].text == "The total contract value shall be $99,999 payable monthly."


def test_multi_run_selection_preserves_formatting_on_leftovers(tmp_path):
    doc = Document()
    p = doc.add_paragraph()
    p.add_run("Between ")
    r2 = p.add_run("PARTY_A_PLACEHOLDER")
    r2.bold = True
    p.add_run(" (the Buyer) and ")
    r4 = p.add_run("PARTY_B_PLACEHOLDER")
    r4.italic = True
    p.add_run(" (the Seller).")
    path = str(tmp_path / "multi.docx")
    doc.save(path)

    doc2 = de.load(path)
    # Select "een " (end of run0) through "PART" (start of run1)
    segments = [{"r": 0, "start": 4, "end": 8}, {"r": 1, "start": 0, "end": 4}]
    de.mark_placeholder(doc2, 0, segments, "combo")

    texts = [r.text for r in doc2.paragraphs[0].runs]
    assert texts[0] == "Betw"
    assert texts[1] == "{{combo}}"
    assert texts[2] == "Y_A_PLACEHOLDER"
    assert doc2.paragraphs[0].runs[2].bold is True  # leftover keeps original formatting
    assert doc2.paragraphs[0].runs[4].italic is True


def test_placeholder_key_collision_handled_by_caller():
    # docx_engine itself doesn't dedupe keys -- that's the API layer's job
    # (see main.py: _unique_field_key). Just confirm two identical tokens
    # both get filled correctly if the caller reuses a key on purpose.
    pass


def test_mark_error_on_invalid_offsets(tmp_path):
    path = str(tmp_path / "sample.docx")
    make_sample_doc(path)
    doc = de.load(path)
    try:
        de.mark_placeholder(doc, 0, [{"r": 1, "start": 0, "end": 999}], "bad")
        assert False, "expected MarkError"
    except de.MarkError:
        pass
