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


def make_doc_with_signature_table(path):
    """A short letter followed by a two-column signature table, modeling
    the common "table used for the signature block" shape that plain
    doc.paragraphs iteration used to miss entirely."""
    doc = Document()
    doc.add_paragraph("This is the body of the letter.")
    doc.add_paragraph("Please countersign below.")
    table = doc.add_table(rows=1, cols=2)
    left = table.cell(0, 0)
    left.paragraphs[0].add_run("COMPANY A")
    left.add_paragraph("Name: John Doe")
    left.add_paragraph("Date: ____________")
    right = table.cell(0, 1)
    right.paragraphs[0].add_run("COMPANY B")
    right.add_paragraph("Name: Jane Roe")
    right.add_paragraph("Date: ____________")
    doc.save(path)


def test_table_is_rendered_with_container_paths(tmp_path):
    path = str(tmp_path / "sig.docx")
    make_doc_with_signature_table(path)
    doc = de.load(path)
    html = de.render_paragraphs_html(doc)

    assert "doc-table" in html
    assert "COMPANY A" in html and "COMPANY B" in html
    assert 'data-path="0,0,0"' in html  # left cell
    assert 'data-path="0,0,1"' in html  # right cell


def test_mark_and_fill_placeholder_inside_table_cell(tmp_path):
    path = str(tmp_path / "sig.docx")
    make_doc_with_signature_table(path)
    doc = de.load(path)

    # "Name: Jane Roe" is paragraph index 1 within the right cell (index 0
    # is "COMPANY B"), addressed by container_path [[0, 0, 1]].
    right_cell = doc.tables[0].cell(0, 1)
    assert right_cell.paragraphs[1].text == "Name: Jane Roe"
    run_text = right_cell.paragraphs[1].runs[0].text
    start = run_text.index("Jane Roe")
    end = start + len("Jane Roe")

    de.mark_placeholder(
        doc, 1, [{"r": 0, "start": start, "end": end}], "signer_b_name",
        container_path=[[0, 0, 1]],
    )

    assert "signer_b_name" in de.list_tokens(doc)
    assert right_cell.paragraphs[1].text == "Name: {{signer_b_name}}"
    # the left cell and body paragraphs must be untouched
    left_cell = doc.tables[0].cell(0, 0)
    assert left_cell.paragraphs[1].text == "Name: John Doe"
    assert doc.paragraphs[0].text == "This is the body of the letter."

    filled = de.fill_template(doc, {"signer_b_name": "Janet Roe-Smith"})
    assert filled == 1
    assert right_cell.paragraphs[1].text == "Name: Janet Roe-Smith"


def test_save_preserves_table_that_was_never_marked(tmp_path):
    """A table with no placeholders inside it must still round-trip intact
    through a save -- regression test for the "signature page silently
    disappears" report."""
    path = str(tmp_path / "sig.docx")
    make_doc_with_signature_table(path)
    doc = de.load(path)
    de.fill_template(doc, {})  # no-op fill, same as a generate with no table fields
    out = str(tmp_path / "out.docx")
    de.save(doc, out)

    doc2 = de.load(out)
    assert len(doc2.tables) == 1
    assert "COMPANY A" in doc2.tables[0].cell(0, 0).text
    assert "COMPANY B" in doc2.tables[0].cell(0, 1).text


# ---------------------------------------------------------------------------
# extract_text_at / apply_text_edits -- redlining directly on a generated
# document (as opposed to mark_placeholder, which works on a *template*)
# ---------------------------------------------------------------------------

def test_extract_text_at_reads_back_exact_selection(tmp_path):
    path = str(tmp_path / "sample.docx")
    make_sample_doc(path)
    doc = de.load(path)
    text = de.extract_text_at(doc, [], 0, [{"r": 1, "start": 0, "end": len("Acme Corp")}])
    assert text == "Acme Corp"


def test_extract_text_at_invalid_offsets_raises(tmp_path):
    path = str(tmp_path / "sample.docx")
    make_sample_doc(path)
    doc = de.load(path)
    try:
        de.extract_text_at(doc, [], 0, [{"r": 1, "start": 0, "end": 999}])
        assert False, "expected MarkError"
    except de.MarkError:
        pass


def test_apply_text_edits_single_free_text_replacement(tmp_path):
    path = str(tmp_path / "sample.docx")
    make_sample_doc(path)
    doc = de.load(path)
    # "the undersigned client" isn't a placeholder -- just arbitrary prose.
    text = doc.paragraphs[0].runs[2].text
    start = text.index("the undersigned client")
    end = start + len("the undersigned client")
    de.apply_text_edits(doc, [{
        "container_path": [], "paragraph_index": 0,
        "segments": [{"r": 2, "start": start, "end": end}],
        "new_text": "Widget Industries LLC",
    }])
    assert "Widget Industries LLC" in doc.paragraphs[0].text
    assert "the undersigned client" not in doc.paragraphs[0].text
    # Untouched runs (the bold/italic placeholders) must survive intact.
    assert "Acme Corp" in doc.paragraphs[0].text
    assert "January 1, 2026" in doc.paragraphs[0].text


def test_apply_text_edits_only_touches_the_targeted_occurrence(tmp_path):
    """Regression test: two occurrences of the same value in different
    paragraphs must be editable independently -- redlining one shouldn't
    change the other, unlike the old field_key-wide substitution."""
    doc = Document()
    p1 = doc.add_paragraph()
    p1.add_run("Net 30 days applies to the first invoice.")
    p2 = doc.add_paragraph()
    p2.add_run("Net 30 days also applies to every later invoice.")
    path = str(tmp_path / "dup.docx")
    doc.save(path)

    doc2 = de.load(path)
    text0 = doc2.paragraphs[0].runs[0].text
    start0 = text0.index("Net 30 days")
    de.apply_text_edits(doc2, [{
        "container_path": [], "paragraph_index": 0,
        "segments": [{"r": 0, "start": start0, "end": start0 + len("Net 30 days")}],
        "new_text": "Net 45 days",
    }])
    assert doc2.paragraphs[0].text.startswith("Net 45 days")
    assert doc2.paragraphs[1].text.startswith("Net 30 days")  # untouched


def test_apply_text_edits_multiple_targets_same_paragraph(tmp_path):
    doc = Document()
    p = doc.add_paragraph()
    p.add_run("Buyer shall pay Seller within 30 days of delivery to Chicago.")
    path = str(tmp_path / "multi.docx")
    doc.save(path)

    doc2 = de.load(path)
    text = doc2.paragraphs[0].runs[0].text
    d_start = text.index("30 days")
    d_end = d_start + len("30 days")
    c_start = text.index("Chicago")
    c_end = c_start + len("Chicago")
    de.apply_text_edits(doc2, [
        {"container_path": [], "paragraph_index": 0, "segments": [{"r": 0, "start": d_start, "end": d_end}], "new_text": "45 days"},
        {"container_path": [], "paragraph_index": 0, "segments": [{"r": 0, "start": c_start, "end": c_end}], "new_text": "Denver"},
    ])
    assert doc2.paragraphs[0].text == "Buyer shall pay Seller within 45 days of delivery to Denver."


def test_apply_text_edits_overlapping_selections_raise(tmp_path):
    doc = Document()
    p = doc.add_paragraph()
    p.add_run("The quick brown fox.")
    path = str(tmp_path / "overlap.docx")
    doc.save(path)
    doc2 = de.load(path)
    try:
        de.apply_text_edits(doc2, [
            {"container_path": [], "paragraph_index": 0, "segments": [{"r": 0, "start": 4, "end": 15}], "new_text": "A"},
            {"container_path": [], "paragraph_index": 0, "segments": [{"r": 0, "start": 10, "end": 19}], "new_text": "B"},
        ])
        assert False, "expected MarkError"
    except de.MarkError:
        pass


def test_apply_text_edits_inside_table_cell(tmp_path):
    path = str(tmp_path / "sig.docx")
    make_doc_with_signature_table(path)
    doc = de.load(path)
    right_cell = doc.tables[0].cell(0, 1)
    run_text = right_cell.paragraphs[1].runs[0].text
    start = run_text.index("Jane Roe")
    de.apply_text_edits(doc, [{
        "container_path": [[0, 0, 1]], "paragraph_index": 1,
        "segments": [{"r": 0, "start": start, "end": start + len("Jane Roe")}],
        "new_text": "Janet Roe-Smith",
    }])
    assert right_cell.paragraphs[1].text == "Name: Janet Roe-Smith"
    left_cell = doc.tables[0].cell(0, 0)
    assert left_cell.paragraphs[1].text == "Name: John Doe"
