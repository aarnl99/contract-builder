// Standalone client-facing redline page. Deliberately separate from app.js
// -- the person here has no Rotely account, and the session token they get
// after entering the access code lives only in memory (this variable),
// never in localStorage/sessionStorage/cookies, so it's gone the moment
// they close or reload the tab and they simply enter the code again next
// time, matching how this was scoped. In-progress redlines themselves are
// saved server-side via "Save progress" instead, so re-entering the code
// later picks up where they left off even though the session token itself
// doesn't persist.

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

const TOKEN = location.pathname.replace(/^\/share\//, "").replace(/\/$/, "");
let sessionToken = null;

// Tracks whether there's redlining work sitting only in this tab's memory
// that hasn't been sent to the server yet, via either "Save progress" or
// "Finalize and submit" -- an accidental reload or tab close would silently
// lose it with no warning otherwise. Module-level (not local to
// DocumentView) so it survives DocumentView being torn down and rebuilt
// mid-session (e.g. after acknowledging a response) without stacking up
// duplicate beforeunload listeners that could reference stale state.
let hasUnsavedChanges = false;
window.addEventListener("beforeunload", (e) => {
  if (!hasUnsavedChanges) return;
  e.preventDefault();
  e.returnValue = ""; // required for Chrome to show the native confirmation
});

async function api(path, opts = {}) {
  const headers = opts.body ? { "Content-Type": "application/json" } : {};
  if (sessionToken) headers["X-Share-Session"] = sessionToken;
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      msg = data.detail || msg;
    } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

const app = document.getElementById("app");
function render(view) {
  app.innerHTML = "";
  app.appendChild(view);
}

function topbar() {
  return el("div", { class: "share-topbar" }, [
    el("a", { class: "brand", href: "https://rotely.ai", style: "text-decoration:none;color:inherit;" }, [el("div", { class: "word" }, ["Rotely", el("span", { class: "dot" }, ".ai")])]),
  ]);
}

function GateView() {
  const codeInput = el("input", { type: "text", placeholder: "e.g. 7F3KQ9ZP", style: "text-transform:uppercase;letter-spacing:0.06em;text-align:center;font-size:16px;" });
  const errBox = el("div");
  const submitBtn = el("button", { class: "btn block" }, "View document");

  async function submit() {
    errBox.innerHTML = "";
    if (!codeInput.value.trim()) {
      errBox.appendChild(el("div", { class: "error-box" }, "Enter the access code you were given."));
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Checking...";
    try {
      const res = await api(`/api/share/${TOKEN}/verify`, { method: "POST", body: { access_code: codeInput.value.trim() } });
      sessionToken = res.session_token;
      loadDocument();
    } catch (e) {
      errBox.appendChild(el("div", { class: "error-box" }, e.message));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "View document";
    }
  }
  submitBtn.addEventListener("click", submit);
  codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  const card = el("div", { class: "card gate-card" }, [
    el("h1", {}, "This document is ready for your review"),
    el("p", { class: "subtitle" }, "Enter the access code the sender gave you to view it and propose changes."),
    errBox,
    el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Access code"), codeInput]),
    submitBtn,
  ]);
  return el("div", { class: "share-main" }, [card]);
}

function ThanksView() {
  return el("div", { class: "share-main" }, [
    el("div", { class: "card thanks-card" }, [
      el("h1", {}, "Thanks! Your changes were sent"),
      el("p", { class: "subtitle" }, "The sender has been notified and will review what you proposed. You can close this page."),
    ]),
  ]);
}

// Shown when the sender has reviewed a submitted round (accept/reject/
// counter, batched together) and the client hasn't seen the outcome yet.
// Countered fields become fresh suggestions once they continue, so they can
// accept the counter as-is or adjust it further before the next round.
function ResponseView(data, onContinue) {
  const resp = data.response;
  // See RedlineSubmission.origin, phase 5 (#23): an "owner_edit" round
  // isn't a response to anything you sent -- the sender edited the shared
  // document directly, and it's queued here for your decision, same as a
  // fresh counter. No "you proposed" line (you didn't) and no outcome
  // badge (nothing's decided yet); just what changed.
  const isOwnerEdit = resp.origin === "owner_edit";
  const rows = resp.edits.map((e) => {
    if (isOwnerEdit) {
      return el("div", { class: "response-edit-row" }, [
        el("div", { class: "re-label" }, e.label),
        el("div", { class: "re-diff" }, [
          el("span", { class: "old" }, e.original_value || "(blank)"),
          " → ",
          el("span", { class: "new" }, e.counter_value || "(blank)"),
        ]),
      ]);
    }
    let outcomeEl;
    if (e.decision === "accepted") {
      outcomeEl = el("div", { class: "re-outcome outcome-accepted" }, "Accepted");
    } else if (e.decision === "rejected") {
      outcomeEl = el("div", { class: "re-outcome outcome-rejected" }, "Declined — kept as-is");
    } else {
      outcomeEl = el("div", { class: "re-outcome outcome-countered" }, ["Countered with: ", el("strong", {}, e.counter_value)]);
    }
    return el("div", { class: "response-edit-row" }, [
      el("div", { class: "re-label" }, e.label),
      el("div", { class: "re-diff" }, ["You proposed: ", el("span", { class: "new" }, e.proposed_value || "(blank)")]),
      outcomeEl,
    ]);
  });

  const continueBtn = el("button", { class: "btn block" }, "Continue redlining");
  continueBtn.addEventListener("click", onContinue);

  return el("div", { class: "share-main" }, [
    el("div", { class: "card response-card" }, [
      el("h1", {}, isOwnerEdit ? "The sender made a change for you to review" : "The sender responded to your redlines"),
      el("p", { class: "subtitle" }, isOwnerEdit
        ? "They edited the document directly. Review it below, then accept it, decline it, or suggest something different."
        : "Here's what happened to each one. Anything countered becomes a new suggestion you can accept or adjust."),
      el("div", { class: "response-edit-list" }, rows),
      continueBtn,
    ]),
  ]);
}

function JoinCta() {
  return el("div", { class: "join-cta" }, [
    el("div", { class: "join-cta-inner" }, [
      el("div", { class: "jc-eyebrow" }, "Like how this felt?"),
      el("h2", {}, "Close the Friction. Get signatures faster."),
      el("p", {}, "Rotely turns a contract you already know into a reusable template, drafts finished copies in seconds, and lets people redline it right here, no other tools involved."),
      el("div", { class: "jc-actions" }, [
        el("a", { class: "btn on-dark", href: "/" }, "Create an account"),
        el("a", { class: "btn secondary on-dark", href: "/" }, "Log in to save this"),
      ]),
    ]),
  ]);
}

// Maps a browser text selection back to an exact (paragraph, run,
// char-offset) location the way template authoring already does for
// marking placeholders (see app.js's computeSelectionSegments) -- reused
// here so a client can redline ANY text in the document, not just spots the
// sender pre-marked as a field.
function computeSelectionSegments(containerEl) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!containerEl.contains(range.commonAncestorContainer)) return null;

  function toTextNode(node, offset) {
    if (node.nodeType === 3) return { node, offset };
    if (offset < node.childNodes.length) {
      let n = node.childNodes[offset];
      while (n && n.nodeType !== 3 && n.firstChild) n = n.firstChild;
      if (n && n.nodeType === 3) return { node: n, offset: 0 };
    }
    let n = node.lastChild;
    while (n && n.nodeType !== 3 && n.lastChild) n = n.lastChild;
    if (n && n.nodeType === 3) return { node: n, offset: n.length };
    return { node: null, offset: 0 };
  }

  function findAncestorWithClass(node, cls) {
    let e = node.nodeType === 3 ? node.parentElement : node;
    while (e && !(e.classList && e.classList.contains(cls))) e = e.parentElement;
    return e;
  }

  const startTN = toTextNode(range.startContainer, range.startOffset);
  const endTN = toTextNode(range.endContainer, range.endOffset);
  if (!startTN.node || !endTN.node) return null;

  const startRunEl = findAncestorWithClass(startTN.node, "run");
  const endRunEl = findAncestorWithClass(endTN.node, "run");
  const startParaEl = findAncestorWithClass(startTN.node, "para");
  const endParaEl = findAncestorWithClass(endTN.node, "para");
  if (!startRunEl || !endRunEl || !startParaEl || !endParaEl) return null;
  if (startParaEl !== endParaEl) return { error: "cross-paragraph" };

  const pIndex = parseInt(startParaEl.dataset.p, 10);
  const tablePath = startParaEl.dataset.path || "";
  const text = range.toString();

  if (startRunEl === endRunEl) {
    const r = parseInt(startRunEl.dataset.r, 10);
    let s = startTN.offset, e = endTN.offset;
    if (s > e) [s, e] = [e, s];
    return { paragraph_index: pIndex, table_path: tablePath, segments: [{ r, start: s, end: e }], text };
  }

  const allRuns = Array.from(startParaEl.querySelectorAll(".run"));
  const startIdx = allRuns.indexOf(startRunEl);
  const endIdx = allRuns.indexOf(endRunEl);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null;

  const segments = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const runEl = allRuns[i];
    const r = parseInt(runEl.dataset.r, 10);
    const runLen = (runEl.textContent || "").length;
    let s, e;
    if (i === startIdx) { s = startTN.offset; e = runLen; }
    else if (i === endIdx) { s = 0; e = endTN.offset; }
    else { s = 0; e = runLen; }
    if (s < e) segments.push({ r, start: s, end: e });
  }
  if (!segments.length) return null;
  return { paragraph_index: pIndex, table_path: tablePath, segments, text };
}

function locKey(loc) {
  return `${loc.table_path || ""}|${loc.paragraph_index}|${loc.segments.map((s) => `${s.r}:${s.start}:${s.end}`).join(",")}`;
}

// Redline directly in the document, the way you'd suggest an edit in a
// shared Google Doc: select any text (a pre-marked field's value, or any
// other word/clause), a small "Suggest edit" action appears for exactly
// that spot, and the document itself shows the strikethrough-old /
// underlined-new diff right where that text lives. Each edit is tied to
// its own exact location, so two occurrences of the same field (or the
// same phrase) can be redlined independently -- changing one never
// changes the other.
function DocumentView(data) {
  const shell = el("div", { class: "redline-shell" });

  // ---- header: title, subtype, instruction, parties, editing-as ----
  const header = el("div", { class: "redline-header" }, [
    el("h1", { class: "rh-title" }, data.name),
    el("div", { class: "rh-subtype" }, data.document_type),
    el("div", { class: "rh-instruction" }, "Select any text in the document to suggest a change — a highlighted field or any other word or clause."),
  ]);
  if (data.parties && data.parties.length) {
    header.appendChild(
      el("div", { class: "rh-parties" }, [el("span", { class: "rh-parties-label" }, "Parties: "), data.parties.join("  ·  ")])
    );
  }
  if (data.client_email) {
    const fullName = [data.client_first_name, data.client_last_name].filter(Boolean).join(" ");
    header.appendChild(
      el("div", { class: "rh-editing-as" }, fullName ? `Editing as: ${fullName} (${data.client_email})` : `Editing as: ${data.client_email}`)
    );
  }
  if (data.owner_updated_since_last_view) {
    header.appendChild(
      el("div", { class: "rh-updated-notice" }, "The sender updated this document since your last visit — the text below reflects the latest version.")
    );
  }
  shell.appendChild(header);

  const pristineHtml = data.html || "<p>No preview available.</p>";
  const preview = el("div", { class: "contract-view" });
  preview.innerHTML = pristineHtml;

  const errBox = el("div", { style: "margin-top:14px;" });

  const fieldByKey = {};
  (data.fields || []).forEach((f) => { fieldByKey[f.field_key] = f; });

  // locKey(location) -> { field_key, label, location, original_text, value, comment,
  // counterPending, clientOriginalValue, sourceEditId }. counterPending marks a
  // spot the sender just countered that the client hasn't explicitly accepted,
  // rejected, or re-suggested yet -- see handleRunClick / renderList below,
  // where those get a 3-way Accept/Reject/Suggest chip instead of the
  // normal single "Edit suggestion" one. sourceEditId, when set, is the id of
  // the sender's countered RedlineEdit this spot originated from -- sent back
  // as accepting_edit_id on submit so the server can recognize "the client is
  // just taking the sender's own counter" and skip re-asking the sender to
  // approve a value they already proposed themselves (see acceptCounter).
  const edits = {};

  if (data.draft && data.draft.edits) {
    data.draft.edits.forEach((e) => {
      if (!e.location || !e.location.segments || !e.location.segments.length) return;
      const loc = { table_path: e.location.table_path || "", paragraph_index: e.location.paragraph_index, segments: e.location.segments };
      edits[locKey(loc)] = {
        field_key: e.field_key || "", label: e.label || "", location: loc,
        original_text: e.original_value || "", value: e.proposed_value, comment: e.comment || "",
        counterPending: !!e.is_counter, clientOriginalValue: e.client_original_value || "",
        sourceEditId: e.source_edit_id || null,
      };
    });
  }

  function findParaEl(tablePath, pIdx) {
    const sel = tablePath
      ? `.para[data-path="${cssEscape(tablePath)}"][data-p="${pIdx}"]`
      : `.para[data-p="${pIdx}"]:not([data-path])`;
    return preview.querySelector(sel);
  }

  // ---- stats bar ----
  const statsBar = el("div", { class: "stats-bar" });
  function renderStats() {
    statsBar.innerHTML = "";
    const changed = Object.keys(edits).length;
    statsBar.appendChild(
      el("div", { class: "stat-tile" }, [
        el("div", { class: "num" }, String(changed)),
        el("div", { class: "cap" }, changed === 1 ? "change suggested" : "changes suggested"),
      ])
    );
  }

  // ---- redline list (sidebar) ----
  const redlineList = el("div", { class: "redline-list" });
  function renderList() {
    redlineList.innerHTML = "";
    const keys = Object.keys(edits);
    if (!keys.length) {
      redlineList.appendChild(el("div", { class: "redline-list-empty" }, "Nothing redlined yet. Highlight any text in the document to get started."));
      return;
    }
    keys.forEach((key) => {
      const e = edits[key];
      const rows = [
        el("div", { class: "rl-diff" }, [
          el("span", { class: "old" }, e.original_text || "(blank)"),
          " → ",
          el("span", { class: "new" }, e.value || "(blank)"),
        ]),
      ];
      if (e.comment) rows.push(el("div", { class: "rl-comment" }, [`"${e.comment}"`]));
      let topRight;
      if (e.counterPending) {
        rows.unshift(el("div", { class: "rl-counter-note" }, "The sender countered this — accept it, reject it, or suggest something else."));
        topRight = el("div", { class: "rl-counter-actions" }, [
          el("button", { class: "rl-mini-btn accept", onclick: () => acceptCounter(key) }, "Accept"),
          el("button", { class: "rl-mini-btn reject", onclick: () => rejectCounter(key) }, "Reject"),
          el("button", { class: "rl-mini-btn", onclick: (ev) => openSuggestPopoverForKey(key, ev.currentTarget.getBoundingClientRect()) }, "Suggest edit"),
        ]);
      } else {
        topRight = el("div", { class: "rl-remove", onclick: () => removeSuggestion(key) }, "Remove");
      }
      redlineList.appendChild(
        el("div", { class: "redline-list-item" + (e.counterPending ? " counter-pending" : "") }, [
          el("div", { class: "rl-top" }, [
            el("div", { class: "rl-label" }, e.label || "Custom edit"),
            topRight,
          ]),
          ...rows,
        ])
      );
    });
  }

  function acceptCounter(key) {
    if (!edits[key]) return;
    edits[key].counterPending = false;
    closePopover();
    deselectField();
    repaint();
  }

  function rejectCounter(key) {
    if (!edits[key]) return;
    edits[key].value = edits[key].clientOriginalValue;
    edits[key].counterPending = false;
    closePopover();
    deselectField();
    repaint();
  }

  function openSuggestPopoverForKey(key, anchorRect) {
    const e = edits[key];
    if (!e) return;
    const f = fieldByKey[e.field_key];
    openEditPopover({
      key, location: e.location, fieldKey: e.field_key, label: e.label,
      originalText: e.original_text, currentValue: e.value, currentComment: e.comment,
      fieldType: f ? f.field_type : "", anchorRect,
    });
  }

  // ---- repaint: always redraw from the pristine HTML, then re-apply every
  // current edit's del/ins diff at its exact run/offset location. Simpler
  // and far less error-prone than mutating the live DOM incrementally,
  // since two edits can land in the same run and need to be spliced
  // together in one pass. ----
  function repaint() {
    preview.innerHTML = pristineHtml;
    const byPara = {};
    // Carry each edit's key along (not just its value) so the fv-del/fv-ins
    // spans below can be tagged with data-edit-key -- handleRunClick needs
    // that to find exactly this edit's span(s) within a run that might
    // otherwise span a whole clause. See the click-to-decide highlight fix
    // just below.
    Object.entries(edits).forEach(([key, e]) => {
      const pk = `${e.location.table_path || ""} ${e.location.paragraph_index}`;
      (byPara[pk] = byPara[pk] || []).push({ key, edit: e });
    });
    Object.entries(byPara).forEach(([pk, list]) => {
      const [tablePath, pIdxStr] = pk.split(" ");
      const paraEl = findParaEl(tablePath, parseInt(pIdxStr, 10));
      if (!paraEl) return;
      const runEls = Array.from(paraEl.querySelectorAll(".run"));
      const byRun = {};
      list.forEach(({ key, edit }) => {
        edit.location.segments.forEach((seg) => {
          (byRun[seg.r] = byRun[seg.r] || []).push({ seg, edit, key });
        });
      });
      Object.entries(byRun).forEach(([rIdxStr, segEdits]) => {
        const runEl = runEls[parseInt(rIdxStr, 10)];
        if (!runEl) return;
        segEdits.sort((a, b) => a.seg.start - b.seg.start);
        const text = runEl.textContent;
        const frag = document.createDocumentFragment();
        const seen = new Set();
        let cursor = 0;
        segEdits.forEach(({ seg, edit, key }) => {
          if (seg.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, seg.start)));
          // The counter-pending indicator is scoped to just the del/ins pair
          // for THIS edit, not the whole .run -- a run can span an entire
          // clause (Word often merges a whole sentence into one run when
          // there's no formatting boundary), so marking the run itself
          // visually underlined every word in it, not just the countered
          // one. See has-counter-pending's CSS comment. data-edit-key is
          // the same scoping fix applied to the click-to-decide highlight
          // -- see handleRunClick.
          const pendingCls = edit.counterPending ? " counter-pending" : "";
          frag.appendChild(el("span", { class: "fv-del" + pendingCls, "data-edit-key": key }, text.slice(seg.start, seg.end)));
          if (!seen.has(edit)) {
            frag.appendChild(el("span", { class: "fv-ins" + pendingCls, "data-edit-key": key }, edit.value || "(blank)"));
            seen.add(edit);
          }
          cursor = seg.end;
        });
        if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
        runEl.classList.add("has-suggestion");
        runEl.innerHTML = "";
        runEl.appendChild(frag);
      });
    });
    renderStats();
    renderList();
  }

  function commitSuggestion(key, location, fieldKey, label, originalText, value, comment) {
    const trimmed = (value || "").trim();
    // Carry the chain reference forward if this spot already had one --
    // see the sourceEditId comment above and bug tracker #20. Without
    // this, suggesting a different value than the sender's counter (the
    // "Suggest edit" button on a counterPending spot, as opposed to
    // "Accept") rebuilt this entry from scratch and silently dropped the
    // link back to the counter it was responding to, so the sender's next
    // review saw an unrelated fresh redline instead of a continued
    // negotiation.
    const priorSourceEditId = (edits[key] || {}).sourceEditId || null;
    if (trimmed === (originalText || "").trim() && !(comment || "").trim()) {
      delete edits[key];
    } else {
      edits[key] = {
        field_key: fieldKey, label, location, original_text: originalText, value: trimmed,
        comment: (comment || "").trim(), sourceEditId: priorSourceEditId,
      };
    }
    hasUnsavedChanges = true;
    closePopover();
    deselectField();
    repaint();
  }

  function removeSuggestion(key) {
    delete edits[key];
    hasUnsavedChanges = true;
    closePopover();
    deselectField();
    repaint();
  }

  // ---- select-first interaction: select something (a click on an
  // already-highlighted field, or a drag over any text), a small floating
  // "Suggest edit" action appears, THEN the popover opens ----
  let selectedEls = [];
  let actionChip = null;
  // A free-text drag can cover only PART of a .run (e.g. one word inside a
  // run that holds a whole clause) -- highlighting the whole run in that
  // case would visually mark far more than was actually selected, even
  // though the edit itself only ever targets the true start/end offsets.
  // These small fixed-position overlays are drawn from the selection
  // Range's own client rects instead, so the highlight always matches
  // exactly what was dragged over, line-wraps and all, without touching
  // the run's DOM (which whole-run .selected already relies on elsewhere).
  let selectionHighlightEls = [];

  function clearSelectionHighlight() {
    selectionHighlightEls.forEach((elx) => elx.remove());
    selectionHighlightEls = [];
  }

  function highlightRange(range) {
    clearSelectionHighlight();
    Array.from(range.getClientRects()).forEach((r) => {
      if (r.width <= 0 || r.height <= 0) return;
      const box = el("div", { class: "text-selection-highlight" });
      box.style.top = r.top + "px";
      box.style.left = r.left + "px";
      box.style.width = r.width + "px";
      box.style.height = r.height + "px";
      document.body.appendChild(box);
      selectionHighlightEls.push(box);
    });
  }

  function deselectField() {
    selectedEls.forEach((elx) => elx.classList.remove("selected"));
    selectedEls = [];
    clearSelectionHighlight();
    if (actionChip) { actionChip.remove(); actionChip = null; }
  }

  function showActionChip(anchorRect, label, onClick) {
    if (actionChip) actionChip.remove();
    actionChip = el("button", { class: "field-action-chip" }, label);
    actionChip.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    document.body.appendChild(actionChip);
    actionChip.style.top = Math.min(window.innerHeight - 60, anchorRect.bottom + 8) + "px";
    actionChip.style.left = Math.min(window.innerWidth - 200, Math.max(8, anchorRect.left)) + "px";
  }

  // Same floating placement as showActionChip, but for a spot the sender
  // just countered -- offers all three real responses (accept the counter,
  // reject it back to what the client originally asked for, or suggest
  // something else) instead of a single generic "edit" action.
  function showDecisionChip(anchorRect, { onAccept, onReject, onSuggest }) {
    if (actionChip) actionChip.remove();
    const acceptBtn = el("button", { class: "fdc-btn fdc-accept" }, "Accept");
    const rejectBtn = el("button", { class: "fdc-btn fdc-reject" }, "Reject");
    const suggestBtn = el("button", { class: "fdc-btn fdc-suggest" }, "Suggest edit ✎");
    acceptBtn.addEventListener("click", (e) => { e.stopPropagation(); onAccept(); });
    rejectBtn.addEventListener("click", (e) => { e.stopPropagation(); onReject(); });
    suggestBtn.addEventListener("click", (e) => { e.stopPropagation(); onSuggest(); });
    actionChip = el("div", { class: "field-decision-chip" }, [acceptBtn, rejectBtn, suggestBtn]);
    document.body.appendChild(actionChip);
    actionChip.style.top = Math.min(window.innerHeight - 60, anchorRect.bottom + 8) + "px";
    actionChip.style.left = Math.min(window.innerWidth - 270, Math.max(8, anchorRect.left)) + "px";
  }

  let activePopover = null;
  function closePopover() {
    if (activePopover) { activePopover.remove(); activePopover = null; }
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest(".run") || e.target.closest(".field-action-chip") || e.target.closest(".field-decision-chip") || e.target.closest(".redline-popover")) return;
    closePopover();
    deselectField();
  });

  function openEditPopover(opts) {
    closePopover();
    const { key, location, fieldKey, label, originalText, currentValue, currentComment, fieldType, anchorRect } = opts;
    let input;
    if (fieldType === "multiline") input = el("textarea", {}, currentValue);
    else if (fieldType === "date") input = el("input", { type: "date", value: currentValue });
    else if (fieldType === "number") input = el("input", { type: "number", value: currentValue });
    else if (fieldType === "text") input = el("input", { type: "text", value: currentValue });
    else input = el("textarea", { rows: "2" }, currentValue); // free-text selection, not a known field -- could be a whole clause
    const commentInput = el("textarea", { class: "rp-comment", placeholder: "Why? (optional)" }, currentComment || "");

    const children = [
      el("div", { class: "rp-label" }, label || "Selected text"),
      el("div", { style: "font-size:12.5px;color:var(--muted);margin:-2px 0 8px;" }, [`Currently: "${originalText || "(blank)"}"`]),
      input,
      el("div", { class: "rp-label", style: "margin-top:10px;" }, "Comment"),
      commentInput,
      el("div", { class: "rp-actions" }, [
        el("button", { class: "btn secondary", onclick: () => { closePopover(); deselectField(); } }, "Cancel"),
        el("button", { class: "btn", onclick: () => commitSuggestion(key, location, fieldKey, label, originalText, input.value, commentInput.value) }, "Suggest edit"),
      ]),
    ];
    if (edits[key]) {
      children.push(el("div", { class: "rp-remove", onclick: () => removeSuggestion(key) }, "Remove suggestion"));
    }

    const pop = el("div", { class: "redline-popover" }, children);
    document.body.appendChild(pop);
    pop.style.top = Math.min(window.innerHeight - 280, anchorRect.bottom + 8) + "px";
    pop.style.left = Math.min(window.innerWidth - 300, Math.max(8, anchorRect.left)) + "px";
    activePopover = pop;
    input.focus();
  }

  // A run belongs to an existing edit if its (table_path, paragraph_index,
  // run index) shows up in that edit's segments.
  function findEditForRun(tablePath, pIdx, rIdx) {
    return Object.entries(edits).find(([, e]) => {
      const loc = e.location;
      return loc.table_path === tablePath && loc.paragraph_index === pIdx && loc.segments.some((s) => s.r === rIdx);
    });
  }

  function handleRunClick(runEl) {
    const paraEl = runEl.closest(".para");
    if (!paraEl) return;
    const pIdx = parseInt(paraEl.dataset.p, 10);
    const tablePath = paraEl.dataset.path || "";
    const rIdx = parseInt(runEl.dataset.r, 10);

    const found = findEditForRun(tablePath, pIdx, rIdx);
    if (found) {
      const [key, e] = found;
      deselectField();
      // Highlight and anchor on just THIS edit's fv-del/fv-ins span(s), not
      // the whole run -- a run can span an entire clause (Word merges a
      // whole sentence into one run with no formatting break), so marking
      // .selected on runEl made deciding on a single inserted word look
      // like the entire clause was up for review. data-edit-key is set by
      // repaint() precisely so this lookup can be exact. Falls back to the
      // run itself only if something's out of sync (shouldn't happen --
      // repaint() always tags every edit's spans before this can be
      // clicked).
      const spans = Array.from(runEl.querySelectorAll(`[data-edit-key="${cssEscape(key)}"]`));
      const targets = spans.length ? spans : [runEl];
      targets.forEach((t) => t.classList.add("selected"));
      selectedEls = targets;
      const anchorRect = targets[targets.length - 1].getBoundingClientRect();
      if (e.counterPending) {
        showDecisionChip(anchorRect, {
          onAccept: () => acceptCounter(key),
          onReject: () => rejectCounter(key),
          onSuggest: () => openSuggestPopoverForKey(key, anchorRect),
        });
        return;
      }
      showActionChip(anchorRect, "Edit suggestion ✎", () => {
        openSuggestPopoverForKey(key, anchorRect);
      });
      return;
    }

    const fieldKey = runEl.getAttribute("data-field-key");
    if (fieldKey) {
      const runLen = (runEl.textContent || "").length;
      const loc = { table_path: tablePath, paragraph_index: pIdx, segments: [{ r: rIdx, start: 0, end: runLen }] };
      const f = fieldByKey[fieldKey];
      deselectField();
      runEl.classList.add("selected");
      selectedEls = [runEl];
      showActionChip(runEl.getBoundingClientRect(), "Suggest edit ✎", () => {
        openEditPopover({
          key: locKey(loc), location: loc, fieldKey, label: f ? f.label : fieldKey,
          originalText: runEl.textContent, currentValue: runEl.textContent, currentComment: "",
          fieldType: f ? f.field_type : "text", anchorRect: runEl.getBoundingClientRect(),
        });
      });
      return;
    }

    // Plain prose, plain click with no drag -- nothing to do; the person
    // needs to select (drag over) the text they want to redline.
    deselectField();
    closePopover();
  }

  function handleTextSelection(info, anchorRect, range) {
    const loc = { table_path: info.table_path || "", paragraph_index: info.paragraph_index, segments: info.segments };
    const key = locKey(loc);
    const existing = edits[key];
    deselectField();
    // Highlight exactly the dragged-over text, not the whole run(s) it sits
    // inside -- a run can hold an entire clause, so marking the full run
    // here would visually cover far more than the person actually selected
    // (the proposed edit itself has always correctly used just info's start/
    // end offsets; only this highlight was overshooting).
    if (range) highlightRange(range);
    showActionChip(anchorRect, existing ? "Edit suggestion ✎" : "Suggest edit ✎", () => {
      openEditPopover({
        key, location: loc, fieldKey: existing ? existing.field_key : "", label: existing ? existing.label : "",
        originalText: existing ? existing.original_text : info.text,
        currentValue: existing ? existing.value : info.text,
        currentComment: existing ? existing.comment : "",
        fieldType: existing && existing.field_key ? (fieldByKey[existing.field_key] || {}).field_type || "" : "",
        anchorRect,
      });
    });
  }

  function attachRunHandlers() {
    preview.addEventListener("mouseup", onPreviewMouseUp);
  }

  function onPreviewMouseUp(e) {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      if (sel.isCollapsed) {
        const runEl = e.target.closest ? e.target.closest(".run") : null;
        if (!runEl || !preview.contains(runEl)) { deselectField(); closePopover(); return; }
        handleRunClick(runEl);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!preview.contains(range.commonAncestorContainer)) return;
      const rect = range.getBoundingClientRect();
      const info = computeSelectionSegments(preview);
      sel.removeAllRanges();
      if (!info) return;
      if (info.error === "cross-paragraph") {
        alert("Please select text within a single paragraph.");
        return;
      }
      handleTextSelection(info, rect, range);
    }, 0);
  }

  attachRunHandlers();
  repaint();

  const docCard = el("div", { class: "redline-doc-card" }, [preview]);

  const noteInput = el("textarea", { placeholder: "Anything else worth flagging that isn't captured above?" }, (data.draft && data.draft.note) || "");
  noteInput.addEventListener("input", () => {
    hasUnsavedChanges = true;
    renderStats();
  });
  docCard.appendChild(
    el("div", { class: "form-row", style: "margin-top:20px;" }, [el("label", { class: "field-label" }, "General comment (optional)"), noteInput])
  );
  docCard.appendChild(errBox);

  // ---- Shared: open comment thread on a redline (client side). Same
  // widget as app.js's buildCommentThread (owner side) -- kept in sync by
  // hand since the two files have no module system between them and
  // different api()/auth patterns. Open on ANY redline regardless of its
  // accept/reject/counter decision; "Resolved" is independent of that
  // decision, and posting into a resolved thread auto-reopens it (server
  // does this, we just mirror the flag locally after each call). ----
  function buildCommentThread(edit, editPath) {
    let comments = (edit.comments || []).slice();
    let resolved = !!edit.comments_resolved;
    let expanded = false;

    const toggleBtn = el("button", { class: "comment-toggle-btn" }, "");
    const resolvedBadge = el("span", { class: "comment-resolved-badge", style: "display:none;" }, "Resolved");
    const bodyEl = el("div", { class: "comment-thread-body", style: "display:none;" });
    const wrap = el("div", { class: "comment-thread" }, [
      el("div", { class: "comment-thread-toggle-row" }, [toggleBtn, resolvedBadge]),
      bodyEl,
    ]);

    function renderToggle() {
      toggleBtn.textContent = comments.length
        ? `💬 ${comments.length} comment${comments.length === 1 ? "" : "s"}`
        : "💬 Add a comment";
      resolvedBadge.style.display = resolved ? "" : "none";
    }

    function renderBody() {
      bodyEl.innerHTML = "";
      const list = el("div", { class: "comment-list" });
      if (!comments.length) {
        list.appendChild(el("div", { class: "comment-empty" }, "No comments yet."));
      } else {
        comments.forEach((c) => {
          list.appendChild(
            el("div", { class: "comment-bubble " + (c.author_type === "client" ? "mine" : "theirs") }, [
              el("div", { class: "comment-meta" }, [
                el("span", { class: "comment-author" }, c.author_name),
                el("span", { class: "comment-time" }, new Date(c.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })),
              ]),
              el("div", { class: "comment-body-text" }, c.body),
            ])
          );
        });
      }
      bodyEl.appendChild(list);

      const resolveBtn = el("button", { class: "btn secondary small" }, resolved ? "Reopen" : "Mark resolved");
      resolveBtn.addEventListener("click", async () => {
        resolveBtn.disabled = true;
        try {
          const res = await api(`${editPath}/${resolved ? "reopen" : "resolve"}`, { method: "POST" });
          resolved = res.comments_resolved;
          renderToggle();
          renderBody();
        } catch (e) {
          alert(e.message);
          resolveBtn.disabled = false;
        }
      });
      bodyEl.appendChild(el("div", { class: "comment-resolve-row" }, [resolveBtn]));

      const textarea = el("textarea", { class: "comment-composer-input", placeholder: "Reply..." });
      const sendBtn = el("button", { class: "btn small" }, "Send");
      async function send() {
        const text = textarea.value.trim();
        if (!text) return;
        sendBtn.disabled = true;
        sendBtn.textContent = "Sending...";
        try {
          const c = await api(editPath, { method: "POST", body: { body: text } });
          comments = comments.concat([c]);
          resolved = false; // mirrors the server's auto-reopen-on-reply
          renderToggle();
          renderBody();
        } catch (e) {
          alert(e.message);
        } finally {
          sendBtn.disabled = false;
          sendBtn.textContent = "Send";
        }
      }
      sendBtn.addEventListener("click", send);
      bodyEl.appendChild(el("div", { class: "comment-composer" }, [textarea, sendBtn]));
    }

    toggleBtn.addEventListener("click", () => {
      expanded = !expanded;
      bodyEl.style.display = expanded ? "" : "none";
      if (expanded) renderBody();
    });

    renderToggle();
    return wrap;
  }

  // ---- redline history: every round of redlines ever submitted through
  // this link, with the sender's decision on each one -- accepted,
  // declined, or countered -- and an open comment thread on every edit,
  // regardless of that decision. Unlike ResponseView (which only shows up
  // once, right after a fresh response, and disappears for good once
  // "Continue redlining" is clicked), this stays available on every visit
  // for as long as the link is open, so what was approved/declined/
  // countered is never just gone. ----
  const redlineHistoryList = el("div", { style: "display:block;" });
  function renderRedlineHistoryEdit(edit, subOrigin) {
    // See RedlineSubmission.origin, phase 5 (#23): an owner_edit edit's
    // proposed_value deliberately mirrors original_value (there's no
    // separate "what the client asked for" -- the sender IS the counter),
    // so the diff has to read against counter_value instead, or it'd show
    // "X → X".
    const isOwnerEdit = subOrigin === "owner_edit";
    const rows = [
      el("div", { class: "rl-diff" }, [
        el("span", { class: "old" }, edit.original_value || "(blank)"),
        " → ",
        el("span", { class: "new" }, (isOwnerEdit ? edit.counter_value : edit.proposed_value) || "(blank)"),
      ]),
    ];
    if (edit.comment) rows.push(el("div", { class: "rl-comment" }, [`"${edit.comment}"`]));

    let decisionEl;
    if (isOwnerEdit) {
      // The diff above already shows the sender's actual change -- no
      // separate "Countered with" line needed, since this isn't a counter
      // to anything the client proposed.
      decisionEl = el("div", { class: "re-outcome outcome-countered" }, "Proposed by the sender");
    } else if (edit.decision === "accepted") decisionEl = el("div", { class: "re-outcome outcome-accepted" }, "Accepted");
    else if (edit.decision === "rejected") decisionEl = el("div", { class: "re-outcome outcome-rejected" }, "Declined");
    else if (edit.decision === "countered") decisionEl = el("div", { class: "re-outcome outcome-countered" }, ["Countered with: ", el("strong", {}, edit.counter_value)]);
    else decisionEl = el("div", { class: "re-outcome outcome-pending" }, "Awaiting the sender's decision");

    const rowChildren = [
      el("div", { class: "rl-label" }, edit.label || "Custom edit"),
    ];
    // See RedlineEdit.source_edit_id -- either the sender reconsidering an
    // earlier decision on this same spot (#19, subOrigin ===
    // "owner_reconsideration"), or this very edit having been the
    // client's own response to one of the sender's counters (#20). Either
    // way, surface the link instead of leaving it invisible.
    if (edit.responding_to) {
      rowChildren.push(
        el("div", { class: "rl-chain-note" }, [
          subOrigin === "owner_reconsideration" ? "↩ Updates the sender's earlier response: " : "↩ Responds to the sender's counter: ",
          el("strong", {}, edit.responding_to.counter_value || edit.responding_to.proposed_value || edit.responding_to.label),
        ])
      );
    }
    rowChildren.push(...rows, decisionEl, buildCommentThread(edit, `/api/share/${TOKEN}/edits/${edit.id}/comments`));

    return el("div", { class: "redline-history-edit-row" }, rowChildren);
  }

  function loadRedlineHistory() {
    redlineHistoryList.innerHTML = "";
    redlineHistoryList.appendChild(el("div", { style: "font-size:12.5px;color:var(--muted);" }, "Loading..."));
    api(`/api/share/${TOKEN}/redlines`)
      .then((data) => {
        redlineHistoryList.innerHTML = "";
        if (!data.submissions.length) {
          redlineHistoryList.appendChild(el("div", { style: "font-size:12.5px;color:var(--muted);" }, "Nothing submitted yet."));
          return;
        }
        data.submissions.forEach((sub) => {
          // See RedlineSubmission.origin -- an owner_reconsideration round
          // is the sender updating their own earlier decision, and an
          // owner_edit round (phase 5) is the sender proposing a direct
          // edit -- neither is a round the client submitted, so each gets
          // its own label.
          const statusLabel = sub.origin === "owner_reconsideration"
            ? "Sender updated a decision"
            : sub.origin === "owner_edit"
            ? "Sender proposed a change"
            : sub.status === "reviewed" ? "Applied" : sub.responded_at ? "Response sent" : "Awaiting response";
          const subBox = el("div", { class: "redline-submission" }, [
            el("div", { class: "sub-header" }, [
              el("div", { style: "font-weight:700;font-size:13px;" }, statusLabel),
              el("div", { class: "when" }, new Date(sub.submitted_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })),
            ]),
          ]);
          if (sub.note) subBox.appendChild(el("div", { class: "note-box" }, sub.note));
          sub.edits.forEach((edit) => subBox.appendChild(renderRedlineHistoryEdit(edit, sub.origin)));
          redlineHistoryList.appendChild(subBox);
        });
      })
      .catch((e) => {
        // Without this, a failed request left "Loading..." on screen
        // forever with no way to tell anything went wrong, let alone try
        // again -- redline history isn't consulted every visit, so this
        // could sit broken for a long time before anyone noticed.
        redlineHistoryList.innerHTML = "";
        redlineHistoryList.appendChild(el("div", { class: "error-box" }, e.message || "Couldn't load redline history."));
        const retryBtn = el("button", { class: "btn secondary small", style: "margin-top:8px;" }, "Retry");
        retryBtn.addEventListener("click", loadRedlineHistory);
        redlineHistoryList.appendChild(retryBtn);
      });
  }
  loadRedlineHistory();

  // ---- activity history: every time this document (and its revisions)
  // was drafted, shared, viewed, or redlined -- in local time, every
  // occurrence, not just the latest. Same lineage data the sender sees on
  // their side, minus anything internal (no ids, no document names, and
  // never redline threshold rules -- consistent with get_share_document
  // never sending those either). ----
  const historyList = el("div", { class: "chain", style: "display:block;border-top:none;background:transparent;padding:0;" });
  function loadHistory() {
    historyList.innerHTML = "";
    historyList.appendChild(el("div", { style: "font-size:12.5px;color:var(--muted);" }, "Loading..."));
    api(`/api/share/${TOKEN}/history`)
      .then((hist) => {
        historyList.innerHTML = "";
        if (!hist.timeline.length) {
          historyList.appendChild(el("div", { style: "font-size:12.5px;color:var(--muted);" }, "No activity yet."));
          return;
        }
        const LABELS = {
          drafted: ["•", "draft", "Drafted"],
          redline_applied: ["✓", "final", "Redlines applied"],
          shared: ["→", "pending", "Shared for review"],
          viewed: ["○", "draft", "Viewed"],
          redline_submitted: ["✎", "pending", "Redline submitted"],
          // The sender reconsidered an already-decided redline -- see
          // RedlineSubmission.origin and #19 in the bug tracker. Distinct
          // from redline_submitted since the client, not the sender, sent
          // nothing here.
          owner_reconsidered: ["↻", "pending", "Sender updated a decision"],
          // The sender edited the shared document directly -- see
          // RedlineSubmission.origin and #23/phase 5 in the bug tracker.
          owner_edit_proposed: ["✎", "pending", "Sender proposed a change"],
        };
        hist.timeline.forEach((ev) => {
          const [dot, cls, title] = LABELS[ev.type] || ["•", "draft", ev.type];
          historyList.appendChild(
            el("div", { class: "chain-item" }, [
              el("div", { class: "chain-dot " + cls }, dot),
              el("div", { class: "chain-body" }, [
                el("div", { class: "chain-title-row" }, [el("span", { class: "chain-title" }, title)]),
                el("div", { class: "chain-meta" }, [new Date(ev.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })]),
              ]),
            ])
          );
        });
      })
      .catch((e) => {
        // Same reasoning as loadRedlineHistory's catch -- without this the
        // panel was stuck on "Loading..." forever with no error and no
        // retry if the request failed.
        historyList.innerHTML = "";
        historyList.appendChild(el("div", { class: "error-box" }, e.message || "Couldn't load activity history."));
        const retryBtn = el("button", { class: "btn secondary small", style: "margin-top:8px;" }, "Retry");
        retryBtn.addEventListener("click", loadHistory);
        historyList.appendChild(retryBtn);
      });
  }
  loadHistory();

  const sideCol = el("div", { class: "redline-side-col" }, [
    statsBar,
    el("h2", { class: "redline-list-heading" }, "Redlines"),
    redlineList,
    el("h2", { class: "redline-list-heading", style: "margin-top:22px;" }, "Redline history"),
    redlineHistoryList,
    el("h2", { class: "redline-list-heading", style: "margin-top:22px;" }, "Activity"),
    historyList,
  ]);

  shell.appendChild(el("div", { class: "redline-layout" }, [el("div", { class: "redline-doc-col" }, [docCard]), sideCol]));

  // ---- bottom action bar ----
  const saveBtn = el("button", { class: "btn secondary" }, "Save progress");
  const saveNote = el("span", { class: "save-note" }, "");
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    try {
      // counter_decided: #32 -- accepting_edit_id alone doesn't tell the
      // server whether this row was actually decided; sourceEditId stays
      // set on a countered row from the moment it's loaded, whether or not
      // the client has clicked Accept/Reject. counterPending only ever
      // flips to false via acceptCounter/rejectCounter, so !counterPending
      // is the accurate "did the client actually decide this" signal --
      // without it, Save progress on an untouched counter used to get
      // silently recorded server-side as accepted.
      const editList = Object.values(edits).map((e) => ({ field_key: e.field_key, proposed_value: e.value, comment: e.comment, label: e.label, location: e.location, accepting_edit_id: e.sourceEditId || null, counter_decided: !e.counterPending }));
      await api(`/api/share/${TOKEN}/save-progress`, { method: "POST", body: { edits: editList, note: noteInput.value.trim() } });
      hasUnsavedChanges = false;
      saveNote.textContent = "Saved — come back anytime with your access code.";
    } catch (e) {
      saveNote.textContent = e.message;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save progress";
      setTimeout(() => (saveNote.textContent = ""), 4000);
    }
  });

  const downloadBtn = el("button", { class: "btn secondary" }, "Download");
  downloadBtn.addEventListener("click", async () => {
    downloadBtn.disabled = true;
    downloadBtn.textContent = "Downloading...";
    try {
      const res = await fetch(`/api/share/${TOKEN}/download`, { headers: { "X-Share-Session": sessionToken } });
      if (!res.ok) throw new Error("Couldn't download this document.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^"]+)"?/);
      a.href = url;
      a.download = m ? m[1] : "contract.docx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      errBox.innerHTML = "";
      errBox.appendChild(el("div", { class: "error-box" }, e.message));
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = "Download";
    }
  });

  const submitBtn = el("button", { class: "btn" }, "Finalize and submit");
  submitBtn.addEventListener("click", async () => {
    errBox.innerHTML = "";
    // Hard block -- bug tracker #21 / phase 4. Inaction on a counter used
    // to default to silent acceptance the moment this button was hit;
    // every counter-pending spot (see the `edits` comment above and
    // renderList's counterPending branch) now needs an explicit
    // Accept/Reject/Suggest before Finalize will go through. "Save
    // progress" deliberately has no such check -- the client can still
    // save and come back later to decide. The server enforces this too
    // (see submit_redlines), so this is just the fast, no-round-trip path
    // to the same message.
    const stillPending = Object.values(edits).filter((e) => e.counterPending);
    if (stillPending.length) {
      errBox.appendChild(
        el("div", { class: "error-box" }, `Decide on the sender's countered change${stillPending.length === 1 ? "" : "s"} before submitting — accept, reject, or suggest something else for each one.`)
      );
      return;
    }
    // counter_decided -- see the same field on the Save-progress payload
    // above (#32). Every row here has already passed the stillPending
    // check, so this is always true at Finalize; sent anyway so the
    // server's own hard-block (submit_redlines) doesn't have to trust
    // anything this endpoint wasn't explicitly told.
    // Bug tracker #57: this used to also block here when there were zero
    // suggested edits AND an empty note, even though the comment field
    // right above is labeled "(optional)" -- there was no way to finalize
    // a review that's genuinely just "I looked it over, nothing to flag,"
    // which is a real outcome, not an accidental empty click. The server
    // (submit_redlines) no longer rejects this either, so nothing further
    // is needed here beyond just letting it through.
    const editList = Object.values(edits).map((e) => ({ field_key: e.field_key, proposed_value: e.value, comment: e.comment, label: e.label, location: e.location, accepting_edit_id: e.sourceEditId || null, counter_decided: !e.counterPending }));
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";
    try {
      await api(`/api/share/${TOKEN}/submit`, { method: "POST", body: { edits: editList, note: noteInput.value.trim() } });
      hasUnsavedChanges = false;
      render(el("div", {}, [topbar(), ThanksView(), JoinCta()]));
    } catch (e) {
      errBox.appendChild(el("div", { class: "error-box" }, e.message));
      submitBtn.disabled = false;
      submitBtn.textContent = "Finalize and submit";
    }
  });

  shell.appendChild(
    el("div", { class: "redline-bottom-bar" }, [saveBtn, downloadBtn, submitBtn, saveNote])
  );

  if (data.sender_email) {
    shell.appendChild(
      el("div", { class: "redline-contact" }, ["Questions? Contact the document sender: ", el("a", { href: `mailto:${data.sender_email}` }, data.sender_email)])
    );
  }

  return shell;
}

function showDocument(data) {
  render(el("div", {}, [topbar(), DocumentView(data), JoinCta()]));
}

async function loadDocument() {
  render(el("div", {}, [topbar(), el("div", { class: "share-main" }, el("p", { class: "subtitle" }, "Loading..."))]));
  try {
    const data = await api(`/api/share/${TOKEN}`);
    if (data.response) {
      render(el("div", {}, [topbar(), ResponseView(data, async () => {
        try {
          await api(`/api/share/${TOKEN}/acknowledge-response`, { method: "POST", body: { submission_id: data.response.submission_id } });
        } catch (e) { /* non-fatal -- worst case it shows again next visit */ }
        // Countered edits become fresh suggestions for the next round; fold
        // them into the normal draft-resume path so DocumentView picks them
        // up the same way it would a saved-progress draft. Only ones that
        // still carry a usable location can be seeded -- matches what
        // DocumentView itself requires to resume a draft edit.
        const seeded = data.response.edits
          .filter((e) => e.decision === "countered" && e.location && e.location.segments && e.location.segments.length)
          .map((e) => ({
            field_key: e.field_key, label: e.label, proposed_value: e.counter_value, comment: "", location: e.location,
            original_value: e.original_value, is_counter: true, client_original_value: e.proposed_value,
            source_edit_id: e.id,
          }));
        const fresh = await api(`/api/share/${TOKEN}`);
        if (seeded.length) {
          fresh.draft = fresh.draft || { note: "", edits: [] };
          const existingKeys = new Set(
            fresh.draft.edits.filter((e) => e.location && e.location.segments).map((e) => locKey(e.location))
          );
          seeded.forEach((s) => { if (!existingKeys.has(locKey(s.location))) fresh.draft.edits.push(s); });
        }
        showDocument(fresh);
        // The seeded counter-acceptances above exist only in this tab's
        // memory until "Save progress" or "Finalize" actually sends them --
        // see the comment on hasUnsavedChanges. Without this, accepting a
        // counter and then reloading before saving would silently lose it
        // with no warning at all.
        if (seeded.length) hasUnsavedChanges = true;
      })]));
    } else {
      showDocument(data);
    }
  } catch (e) {
    sessionToken = null;
    render(el("div", {}, [topbar(), GateView()]));
  }
}

render(el("div", {}, [topbar(), GateView()]));
