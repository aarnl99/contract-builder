"""
Core .docx manipulation engine.

Responsibilities:
  1. Render a .docx's content -- top-level paragraphs AND paragraphs inside
     table cells (recursing into nested tables), in document order -- into
     HTML where every run of text is wrapped in a
     <span data-p="{paragraph index}" data-r="{run index}"> so the browser
     can map a text selection back to an exact
     (container, paragraph, run, char-offset) location.
  2. Given such a selection, split/trim the underlying XML runs and replace
     the selected text with a "{{field_key}}" token, preserving the
     original run formatting (bold, italic, font, etc.) on either side of
     the token.
  3. Given a template's stored placeholders and a dict of user-supplied
     values, produce a finished .docx with every token replaced, wherever
     in the document it lives (body paragraph or table cell).

A "container" is either the document body itself or a single table cell.
Every container exposes `.paragraphs`, `.tables`, and `.iter_inner_content()`
(python-docx gives both Document and _Cell this interface), which is what
lets the same rendering/lookup code walk into cells and nested tables
without caring which kind of container it's in.

A "container path" is how we address a specific cell from the document
root: a list of [table_index, row_index, col_index] triples, one per level
of nesting. [] means "the top-level document body". table_index/row_index/
col_index are all local to their immediate parent container, matching
python-docx's own `.tables` / cell-grid indexing.

Known limitation: headers and footers are separate document parts and are
still not rendered or markable. Merged table cells are rendered as a single
cell without recomputing colspan/rowspan, so a merged region may look
slightly narrower/shorter in the marking view than in Word -- the content
itself is still fully present and markable.
"""
import copy
import html
import re
from typing import Dict, List, Optional

from docx import Document
from docx.table import Table, _Cell
from docx.text.paragraph import Paragraph
from docx.text.run import Run as DocxRun

TOKEN_RE = re.compile(r"^\{\{([a-zA-Z0-9_]+)\}\}$")


def token_for(field_key: str) -> str:
    return "{{%s}}" % field_key


def load(path: str) -> Document:
    return Document(path)


def save(doc: Document, path: str) -> None:
    doc.save(path)


class MarkError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Container helpers: walking body paragraphs + table cells uniformly
# ---------------------------------------------------------------------------

def _iter_unique_cells(table: Table):
    """Yield (row_idx, col_idx, cell) for each physically distinct cell in
    the table, addressed by the (row, col) of its first occurrence in
    reading order. A cell spanned by a horizontal/vertical merge is the
    same underlying XML element for every grid position it covers, so we
    skip it on repeat occurrences -- each physical cell is yielded once."""
    seen = set()
    for r_idx, row in enumerate(table.rows):
        for c_idx, cell in enumerate(row.cells):
            key = id(cell._tc)
            if key in seen:
                continue
            seen.add(key)
            yield r_idx, c_idx, cell


def _resolve_container(doc: Document, path: List[List[int]]):
    """Walk a container path from the document root and return the
    container (Document or _Cell) it points to."""
    container = doc
    for step in path:
        if len(step) != 3:
            raise MarkError("Invalid container path")
        t_idx, r_idx, c_idx = step
        tables = container.tables
        if t_idx < 0 or t_idx >= len(tables):
            raise MarkError(f"Invalid table index {t_idx}")
        table = tables[t_idx]
        found = None
        for rr, cc, cell in _iter_unique_cells(table):
            if rr == r_idx and cc == c_idx:
                found = cell
                break
        if found is None:
            raise MarkError(f"Invalid cell address ({r_idx}, {c_idx})")
        container = found
    return container


def _iter_all_paragraphs(container):
    """Recursively yield every paragraph in a container: its own top-level
    paragraphs plus, for every table it contains, every paragraph in every
    cell of that table (recursing into nested tables)."""
    for block in container.iter_inner_content():
        if isinstance(block, Paragraph):
            yield block
        elif isinstance(block, Table):
            for _, _, cell in _iter_unique_cells(block):
                yield from _iter_all_paragraphs(cell)


# ---------------------------------------------------------------------------
# Rendering: docx -> run-tagged HTML
# ---------------------------------------------------------------------------

def _path_str(path: List[List[int]]) -> str:
    return ";".join(",".join(str(x) for x in step) for step in path)


def _render_run_span(run, p_idx: int, r_idx: int, field_key: Optional[str] = None) -> str:
    text = run.text or ""
    escaped = html.escape(text, quote=False)
    style_bits = []
    if run.bold:
        style_bits.append("font-weight:bold")
    if run.italic:
        style_bits.append("font-style:italic")
    if run.underline:
        style_bits.append("text-decoration:underline")
    style_attr = f' style="{";".join(style_bits)}"' if style_bits else ""
    is_token = bool(TOKEN_RE.match(text.strip()))
    extra_class = ""
    extra_attr = ""
    if is_token:
        extra_class = " token"
    elif field_key:
        extra_class = " field-value"
        extra_attr = f' data-field-key="{html.escape(field_key, quote=True)}"'
    return f'<span class="run{extra_class}" data-p="{p_idx}" data-r="{r_idx}"{extra_attr}{style_attr}>{escaped}</span>'


def _render_paragraph_html(paragraph: Paragraph, p_idx: int, path: List[List[int]], field_lookup: Optional[Dict] = None) -> str:
    path_attr = f' data-path="{_path_str(path)}"' if path else ""
    runs = paragraph.runs
    if not runs:
        return f'<p class="para" data-p="{p_idx}"{path_attr}>&nbsp;</p>'
    path_key = _path_str(path)
    run_spans = [
        _render_run_span(run, p_idx, r_idx, field_lookup.get((path_key, p_idx, r_idx)) if field_lookup else None)
        for r_idx, run in enumerate(runs)
    ]
    return f'<p class="para" data-p="{p_idx}"{path_attr}>' + "".join(run_spans) + "</p>"


def _render_table_html(table: Table, t_idx: int, parent_path: List[List[int]], field_lookup: Optional[Dict] = None) -> str:
    rows: Dict[int, List[str]] = {}
    for r_idx, c_idx, cell in _iter_unique_cells(table):
        cell_path = parent_path + [[t_idx, r_idx, c_idx]]
        cell_html = _render_container_html(cell, cell_path, field_lookup)
        rows.setdefault(r_idx, []).append(cell_html or "&nbsp;")
    trs = []
    for r_idx in sorted(rows):
        tds = "".join(f'<td class="doc-td">{cell_html}</td>' for cell_html in rows[r_idx])
        trs.append(f"<tr>{tds}</tr>")
    return f'<table class="doc-table" data-table="{t_idx}"><tbody>' + "".join(trs) + "</tbody></table>"


def _render_container_html(container, path: List[List[int]], field_lookup: Optional[Dict] = None) -> str:
    parts = []
    p_idx = 0
    t_idx = 0
    for block in container.iter_inner_content():
        if isinstance(block, Paragraph):
            parts.append(_render_paragraph_html(block, p_idx, path, field_lookup))
            p_idx += 1
        elif isinstance(block, Table):
            parts.append(_render_table_html(block, t_idx, path, field_lookup))
            t_idx += 1
    return "\n".join(parts)


def render_paragraphs_html(doc: Document, field_positions: Optional[List[Dict]] = None) -> str:
    """Render the whole document body -- paragraphs and tables, in document
    order, recursing into table cells and nested tables -- as HTML with
    data-p/data-r spans for exact-offset selection mapping.

    If field_positions is given (a list of {"path", "p", "r", "field_key"}
    dicts, as produced by fill_template_tracked), the runs at those exact
    positions get a `field-value` class and `data-field-key` attribute so a
    client-facing page can find and highlight each drafted field inline,
    in place, instead of needing a separate form."""
    field_lookup = None
    if field_positions:
        field_lookup = {(fp["path"], fp["p"], fp["r"]): fp["field_key"] for fp in field_positions}
    return _render_container_html(doc, [], field_lookup)


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


def mark_placeholder(
    doc: Document,
    paragraph_index: int,
    segments: List[dict],
    field_key: str,
    container_path: Optional[List[List[int]]] = None,
) -> None:
    """
    segments: list of {"r": run_index, "start": int, "end": int}, all within
    the same paragraph, referring to ORIGINAL (pre-edit) run indices/offsets
    as captured by the browser at selection time.

    container_path: [] (or None) for a top-level body paragraph, or a list
    of [table_index, row_index, col_index] triples locating the table cell
    the paragraph lives in (see module docstring).
    """
    container = _resolve_container(doc, container_path or [])
    paragraphs = container.paragraphs
    if paragraph_index < 0 or paragraph_index >= len(paragraphs):
        raise MarkError("Invalid paragraph index")
    paragraph = paragraphs[paragraph_index]
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
    """Replace every {{field_key}} run with its value, wherever it lives in
    the document (body paragraph or table cell, at any nesting depth).
    Returns count filled."""
    filled = 0
    for paragraph in _iter_all_paragraphs(doc):
        for run in paragraph.runs:
            text = run.text or ""
            m = TOKEN_RE.match(text.strip())
            if m:
                key = m.group(1)
                if key in values:
                    run.text = values[key]
                    filled += 1
    return filled


def fill_template_tracked(doc: Document, values: Dict[str, str]) -> List[Dict]:
    """Same fill as fill_template, but walks the document with the exact
    same container/path/paragraph-index/run-index scheme as
    render_paragraphs_html, and records where each field ended up. The
    returned list -- [{"path", "p", "r", "field_key"}, ...] -- can be
    stored alongside a generated contract and handed back into
    render_paragraphs_html later so a rendered copy of that same doc (e.g.
    on the client-facing share page) can highlight each field inline,
    without needing to content-match filled-in text back to a field."""
    positions: List[Dict] = []

    def walk(container, path: List[List[int]]) -> None:
        path_key = _path_str(path)
        p_idx = 0
        t_idx = 0
        for block in container.iter_inner_content():
            if isinstance(block, Paragraph):
                for r_idx, run in enumerate(block.runs):
                    text = run.text or ""
                    m = TOKEN_RE.match(text.strip())
                    if m:
                        key = m.group(1)
                        if key in values:
                            run.text = values[key]
                            positions.append({"path": path_key, "p": p_idx, "r": r_idx, "field_key": key})
                p_idx += 1
            elif isinstance(block, Table):
                for r_idx, c_idx, cell in _iter_unique_cells(block):
                    walk(cell, path + [[t_idx, r_idx, c_idx]])
                t_idx += 1

    walk(doc, [])
    return positions


def list_tokens(doc: Document) -> List[str]:
    """Utility: scan the whole doc (including table cells) and return all
    {{field_key}} tokens found."""
    found = []
    for paragraph in _iter_all_paragraphs(doc):
        for run in paragraph.runs:
            m = TOKEN_RE.match((run.text or "").strip())
            if m:
                found.append(m.group(1))
    return found
