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
    el("div", { class: "brand" }, [el("div", { class: "word" }, ["Rotely", el("span", { class: "dot" }, ".ai")])]),
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
    el("div", { class: "icon" }, "🔒"),
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
      el("div", { class: "icon" }, "✅"),
      el("h1", {}, "Thanks — your changes were sent"),
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
  const rows = resp.edits.map((e) => {
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
      el("div", { class: "icon" }, "📝"),
      el("h1", {}, "The sender responded to your redlines"),
      el("p", { class: "subtitle" }, "Here's what happened to each one. Anything countered becomes a new suggestion you can accept or adjust."),
      el("div", { class: "response-edit-list" }, rows),
      continueBtn,
    ]),
  ]);
}

function JoinCta() {
  return el("div", { class: "join-cta" }, [
    el("div", { class: "join-cta-inner" }, [
      el("div", { class: "jc-eyebrow" }, "Like how this felt?"),
      el("h2", {}, "Want to remove friction from your contract process?"),
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
    header.appendChild(el("div", { class: "rh-editing-as" }, `Editing as: ${data.client_email}`));
  }
  shell.appendChild(header);

  const pristineHtml = data.html || "<p>No preview available.</p>";
  const preview = el("div", { class: "contract-view" });
  preview.innerHTML = pristineHtml;

  const errBox = el("div", { style: "margin-top:14px;" });

  const fieldByKey = {};
  (data.fields || []).forEach((f) => { fieldByKey[f.field_key] = f; });

  // locKey(location) -> { field_key, label, location, original_text, value, comment }
  const edits = {};

  if (data.draft && data.draft.edits) {
    data.draft.edits.forEach((e) => {
      if (!e.location || !e.location.segments || !e.location.segments.length) return;
      const loc = { table_path: e.location.table_path || "", paragraph_index: e.location.paragraph_index, segments: e.location.segments };
      edits[locKey(loc)] = {
        field_key: e.field_key || "", label: e.label || "", location: loc,
        original_text: e.original_value || "", value: e.proposed_value, comment: e.comment || "",
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
      redlineList.appendChild(
        el("div", { class: "redline-list-item" }, [
          el("div", { class: "rl-top" }, [
            el("div", { class: "rl-label" }, e.label || "Custom edit"),
            el("div", { class: "rl-remove", onclick: () => removeSuggestion(key) }, "Remove"),
          ]),
          ...rows,
        ])
      );
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
    Object.values(edits).forEach((e) => {
      const pk = `${e.location.table_path || ""} ${e.location.paragraph_index}`;
      (byPara[pk] = byPara[pk] || []).push(e);
    });
    Object.entries(byPara).forEach(([pk, list]) => {
      const [tablePath, pIdxStr] = pk.split(" ");
      const paraEl = findParaEl(tablePath, parseInt(pIdxStr, 10));
      if (!paraEl) return;
      const runEls = Array.from(paraEl.querySelectorAll(".run"));
      const byRun = {};
      list.forEach((e) => {
        e.location.segments.forEach((seg) => {
          (byRun[seg.r] = byRun[seg.r] || []).push({ seg, edit: e });
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
        segEdits.forEach(({ seg, edit }) => {
          if (seg.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, seg.start)));
          frag.appendChild(el("span", { class: "fv-del" }, text.slice(seg.start, seg.end)));
          if (!seen.has(edit)) {
            frag.appendChild(el("span", { class: "fv-ins" }, edit.value || "(blank)"));
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
    if (trimmed === (originalText || "").trim() && !(comment || "").trim()) {
      delete edits[key];
    } else {
      edits[key] = { field_key: fieldKey, label, location, original_text: originalText, value: trimmed, comment: (comment || "").trim() };
    }
    closePopover();
    deselectField();
    repaint();
  }

  function removeSuggestion(key) {
    delete edits[key];
    closePopover();
    deselectField();
    repaint();
  }

  // ---- select-first interaction: select something (a click on an
  // already-highlighted field, or a drag over any text), a small floating
  // "Suggest edit" action appears, THEN the popover opens ----
  let selectedEl = null;
  let actionChip = null;

  function deselectField() {
    if (selectedEl) selectedEl.classList.remove("selected");
    selectedEl = null;
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

  let activePopover = null;
  function closePopover() {
    if (activePopover) { activePopover.remove(); activePopover = null; }
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest(".run") || e.target.closest(".field-action-chip") || e.target.closest(".redline-popover")) return;
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
      runEl.classList.add("selected");
      selectedEl = runEl;
      showActionChip(runEl.getBoundingClientRect(), "Edit suggestion ✎", () => {
        const f = fieldByKey[e.field_key];
        openEditPopover({
          key, location: e.location, fieldKey: e.field_key, label: e.label,
          originalText: e.original_text, currentValue: e.value, currentComment: e.comment,
          fieldType: f ? f.field_type : "", anchorRect: runEl.getBoundingClientRect(),
        });
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
      selectedEl = runEl;
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

  function handleTextSelection(info, anchorRect) {
    const loc = { table_path: info.table_path || "", paragraph_index: info.paragraph_index, segments: info.segments };
    const key = locKey(loc);
    const existing = edits[key];
    deselectField();
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
      handleTextSelection(info, rect);
    }, 0);
  }

  attachRunHandlers();
  repaint();

  const docCard = el("div", { class: "redline-doc-card" }, [preview]);

  const noteInput = el("textarea", { placeholder: "Anything else worth flagging that isn't captured above?" }, (data.draft && data.draft.note) || "");
  noteInput.addEventListener("input", renderStats);
  docCard.appendChild(
    el("div", { class: "form-row", style: "margin-top:20px;" }, [el("label", { class: "field-label" }, "General comment (optional)"), noteInput])
  );
  docCard.appendChild(errBox);

  const sideCol = el("div", { class: "redline-side-col" }, [statsBar, el("h2", { class: "redline-list-heading" }, "Redlines"), redlineList]);

  shell.appendChild(el("div", { class: "redline-layout" }, [el("div", { class: "redline-doc-col" }, [docCard]), sideCol]));

  // ---- bottom action bar ----
  const saveBtn = el("button", { class: "btn secondary" }, "Save progress");
  const saveNote = el("span", { class: "save-note" }, "");
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    try {
      const editList = Object.values(edits).map((e) => ({ field_key: e.field_key, proposed_value: e.value, comment: e.comment, label: e.label, location: e.location }));
      await api(`/api/share/${TOKEN}/save-progress`, { method: "POST", body: { edits: editList, note: noteInput.value.trim() } });
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
    const editList = Object.values(edits).map((e) => ({ field_key: e.field_key, proposed_value: e.value, comment: e.comment, label: e.label, location: e.location }));
    if (!editList.length && !noteInput.value.trim()) {
      errBox.appendChild(el("div", { class: "error-box" }, "Suggest a change or add a comment before submitting."));
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";
    try {
      await api(`/api/share/${TOKEN}/submit`, { method: "POST", body: { edits: editList, note: noteInput.value.trim() } });
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
          .map((e) => ({ field_key: e.field_key, label: e.label, proposed_value: e.counter_value, comment: "", location: e.location }));
        const fresh = await api(`/api/share/${TOKEN}`);
        if (seeded.length) {
          fresh.draft = fresh.draft || { note: "", edits: [] };
          const existingKeys = new Set(
            fresh.draft.edits.filter((e) => e.location && e.location.segments).map((e) => locKey(e.location))
          );
          seeded.forEach((s) => { if (!existingKeys.has(locKey(s.location))) fresh.draft.edits.push(s); });
        }
        showDocument(fresh);
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
