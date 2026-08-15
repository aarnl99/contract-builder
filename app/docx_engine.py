"""
Core .docx manipulation engine.

Responsibilities:
  1. Render a .docx's body paragraphs into HTML where every run of text is
     wrapped in a <span data-p="{paragraph index}" data-r="{run index}">
     so the browser can map a text selection back to an exact
     (paragraph, run, char-offset) location.
  2. Given such a selection, split/trim the underlying XML runs and replace
     the selected text with a "{{field_key}}" token, preserving the
     original run formatting (bold, italic, font, etc.) on either side of
     the token.
  3. Given a template's stored placeholders and a dict of user-supplied
     values, produce a finished .docx with every token replaced.

Scope / known limitation: only top-level body paragraphs (doc.paragraphs)
are rendered and markable. Text inside tables is not currently supported.
"""
import copy
import html
import re
from typing import Dict, List, Optional

from docx import Document
from docx.text.run import Run as DocxRun

TOKEN_RE = re.compile(r"^\{\{([a-zA-Z0-9_]+)\}\}$")


def token_for(field_key: str) -> str:
    return "{{%s}}" % field_key


def load(path: str) -> Document:
    return Document(path)


def save(doc: Document, path: str) -> None:
    doc.save(path)


# ---------------------------------------------------------------------------
# Rendering: docx -> run-tagged HTML
# ---------------------------------------------------------------------------

def render_paragraphs_html(doc: Document) -> str:
    """Render all top-level body paragraphs as HTML with data-p/data-r spans."""
    parts = []
    for p_idx, paragraph in enumerate(doc.paragraphs):
        runs = paragraph.runs
        if not runs:
            parts.append(f'<p class="para" data-p="{p_idx}">&nbsp;</p>')
            continue
        run_spans = []
        for r_idx, run in enumerate(runs):
            text = run.text or ""
            escaped = html.escape(text, quote=False)
            # preserve leading/trailing spaces visually
            style_bits = []
            if run.bold:
                style_bits.append("font-weight:bold")
            if run.italic:
                style_bits.append("font-style:italic")
            if run.underline:
                style_bits.append("text-decoration:underline")
            style_attr = f' style="{";".join(style_bits)}"' if style_bits else ""
            is_token = bool(TOKEN_RE.match(text.strip()))
            token_class = " token" if is_token else ""
            run_spans.append(
                f'<span class="run{token_class}" data-p="{p_idx}" data-r="{r_idx}"{style_attr}>{escaped}</span>'
            )
        parts.append(f'<p class="para" data-p="{p_idx}">' + "".join(run_spans) + "</p>")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Marking: replace a selection with a {{token}}
# ---------------------------------------------------------------------------

def _clone_run_with_text(anchor_run, text: str):
    """Deep-copy anchor_run's XML (to keep its formatting) and set new text."""
    new_r = copy.deepcopy(anchor_run._r)
    new_run = DocxRun(new_r, anchor_run._parent)
    new_run.text = text
    return new_run


def _split_run_insert_token(run, start: int, end: int, token_text: str) -> None:
    """The FIRST (visually leftmost) segment of a selection: split this run
    into [before][TOKEN][after], preserving formatting on before/after."""
    text = run.text or ""
    before = text[:start]
    after = text[end:]
    r_element = run._r

    if before:
        run.text = before

    new_run_middle = _clone_run_with_text(run, token_text)
    r_element.addnext(new_run_middle._r)

    if after:
        new_run_after = _clone_run_with_text(run, after)
        new_run_middle._r.addnext(new_run_after._r)

    if not before:
        parent_el = r_element.getparent()
        parent_el.remove(r_element)


def _remove_range_from_run(run, start: int, end: int) -> None:
    """A subsequent (non-first) segment of a multi-run selection: just cut
    out the covered characters, no token inserted here."""
    text = run.text or ""
    new_text = text[:start] + text[end:]
    if new_text:
        run.text = new_text
    else:
        r_element = run._r
        parent_el = r_element.getparent()
        parent_el.remove(r_element)


class MarkError(ValueError):
    pass


def mark_placeholder(doc: Document, paragraph_index: int, segments: List[dict], field_key: str) -> None:
    """
    segments: list of {"r": run_index, "start": int, "end": int}, all within
    the same paragraph, referring to ORIGINAL (pre-edit) run indices/offsets
    as captured by the browser at selection time.
    """
    if paragraph_index < 0 or paragraph_index >= len(doc.paragraphs):
        raise MarkError("Invalid paragraph index")
    paragraph = doc.paragraphs[paragraph_index]
    original_runs = list(paragraph.runs)

    if not segments:
        raise MarkError("No selection segments provided")

    segments = sorted(segments, key=lambda s: s["r"])

    for seg in segments:
        r_idx = seg["r"]
        if r_idx < 0 or r_idx >= len(original_runs):
            raise MarkError(f"Invalid run index {r_idx}")
        run_text_len = len(original_runs[r_idx].text or "")
        if not (0 <= seg["start"] <= seg["end"] <= run_text_len):
            raise MarkError(f"Invalid offsets for run {r_idx}")

    token_text = token_for(field_key)
    first_seg = segments[0]
    _split_run_insert_token(
        original_runs[first_seg["r"]], first_seg["start"], first_seg["end"], token_text
    )
    for seg in segments[1:]:
        _remove_range_from_run(original_runs[seg["r"]], seg["start"], seg["end"])


# ---------------------------------------------------------------------------
# Generation: fill tokens with values
# ---------------------------------------------------------------------------

def fill_template(doc: Document, values: Dict[str, str]) -> int:
    """Replace every {{field_key}} run with its value. Returns count filled."""
    filled = 0
    for paragraph in doc.paragraphs:
        for run in paragraph.runs:
            text = run.text or ""
            m = TOKEN_RE.match(text.strip())
            if m:
                key = m.group(1)
                if key in values:
                    run.text = values[key]
                    filled += 1
    return filled


def list_tokens(doc: Document) -> List[str]:
    """Utility: scan the doc and return all {{field_key}} tokens found."""
    found = []
    for paragraph in doc.paragraphs:
        for run in paragraph.runs:
            m = TOKEN_RE.match((run.text or "").strip())
            if m:
                found.append(m.group(1))
    return found
