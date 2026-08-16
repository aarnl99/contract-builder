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

// Redline directly in the document, the way you'd suggest an edit in a
// shared Google Doc: highlight a field, then a small "Suggest edit" action
// appears for it, and the document itself shows the strikethrough-old /
// underlined-new diff right where that text lives.
function DocumentView(data) {
  const shell = el("div", { class: "redline-shell" });

  // ---- header: title, subtype, instruction, parties, editing-as ----
  const header = el("div", { class: "redline-header" }, [
    el("h1", { class: "rh-title" }, data.name),
    el("div", { class: "rh-subtype" }, data.document_type),
    el("div", { class: "rh-instruction" }, "Select text to suggest a change."),
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

  const preview = el("div", { class: "contract-view" });
  preview.innerHTML = data.html || "<p>No preview available.</p>";

  const errBox = el("div", { style: "margin-top:14px;" });

  const fieldByKey = {};
  (data.fields || []).forEach((f) => { fieldByKey[f.field_key] = f; });
  const edits = {}; // field_key -> { value, comment }, only present when value differs from current_value

  if (data.draft && data.draft.edits) {
    data.draft.edits.forEach((e) => { edits[e.field_key] = { value: e.proposed_value, comment: e.comment || "" }; });
  }

  const hasInlineTargets = !!preview.querySelector(".field-value[data-field-key]");
  const orphanFields = hasInlineTargets ? [] : (data.fields || []); // older drafts made before inline highlighting existed

  // ---- stats bar ----
  const statsBar = el("div", { class: "stats-bar" });
  function renderStats() {
    statsBar.innerHTML = "";
    const total = (data.fields || []).length;
    const changed = Object.keys(edits).length;
    [
      [String(total), total === 1 ? "field open for redlining" : "fields open for redlining"],
      [String(changed), changed === 1 ? "change suggested" : "changes suggested"],
    ].forEach(([num, cap]) => {
      statsBar.appendChild(el("div", { class: "stat-tile" }, [el("div", { class: "num" }, num), el("div", { class: "cap" }, cap)]));
    });
  }

  // ---- redline list (sidebar) ----
  const redlineList = el("div", { class: "redline-list" });
  function renderList() {
    redlineList.innerHTML = "";
    const keys = Object.keys(edits);
    if (!keys.length) {
      redlineList.appendChild(el("div", { class: "redline-list-empty" }, "Nothing redlined yet. Highlight text in the document to get started."));
      return;
    }
    keys.forEach((key) => {
      const f = fieldByKey[key];
      const e = edits[key];
      const rows = [
        el("div", { class: "rl-diff" }, [
          el("span", { class: "old" }, (f && f.current_value) || "(blank)"),
          " → ",
          el("span", { class: "new" }, e.value || "(blank)"),
        ]),
      ];
      if (e.comment) rows.push(el("div", { class: "rl-comment" }, [`"${e.comment}"`]));
      redlineList.appendChild(
        el("div", { class: "redline-list-item" }, [
          el("div", { class: "rl-top" }, [
            el("div", { class: "rl-label" }, f ? f.label : key),
            el("div", { class: "rl-remove", onclick: () => setSuggestion(key, undefined, "") }, "Remove"),
          ]),
          ...rows,
        ])
      );
    });
  }

  function spansForKey(key) {
    return Array.from(preview.querySelectorAll(`.field-value[data-field-key="${cssEscape(key)}"]`));
  }

  function paintSpan(span, key) {
    const f = fieldByKey[key];
    const original = (f && f.current_value) || "";
    const e = edits[key];
    if (e) {
      span.classList.add("has-suggestion");
      span.innerHTML = "";
      span.appendChild(el("span", { class: "fv-del" }, original || "(blank)"));
      span.appendChild(el("span", { class: "fv-ins" }, e.value || "(blank)"));
    } else {
      span.classList.remove("has-suggestion");
      span.textContent = original;
    }
  }

  function refreshAll() {
    renderStats();
    renderList();
  }

  function setSuggestion(key, value, comment) {
    const f = fieldByKey[key];
    const original = ((f && f.current_value) || "").trim();
    if (value === undefined) {
      delete edits[key];
    } else if (value.trim() === original && !(comment || "").trim()) {
      delete edits[key];
    } else {
      edits[key] = { value: value.trim(), comment: (comment || "").trim() };
    }
    spansForKey(key).forEach((span) => paintSpan(span, key));
    refreshAll();
    closePopover();
    deselectField();
  }

  // ---- select-first interaction: click a field to select it, a small
  // floating "Suggest edit" action appears, THEN the popover opens ----
  let selectedSpan = null;
  let actionChip = null;

  function positionNear(el2, anchorRect) {
    el2.style.top = Math.min(window.innerHeight - 60, anchorRect.bottom + 8) + "px";
    el2.style.left = Math.min(window.innerWidth - 200, Math.max(8, anchorRect.left)) + "px";
  }

  function deselectField() {
    if (selectedSpan) selectedSpan.classList.remove("selected");
    selectedSpan = null;
    if (actionChip) { actionChip.remove(); actionChip = null; }
  }

  function selectField(span, key) {
    if (selectedSpan === span) return;
    deselectField();
    closePopover();
    span.classList.add("selected");
    selectedSpan = span;
    const label = edits[key] ? "Edit suggestion ✎" : "Suggest edit ✎";
    actionChip = el("button", { class: "field-action-chip" }, label);
    actionChip.addEventListener("click", (e) => { e.stopPropagation(); openPopover(span, key); });
    document.body.appendChild(actionChip);
    positionNear(actionChip, span.getBoundingClientRect());
  }

  let activePopover = null;
  function closePopover() {
    if (activePopover) { activePopover.remove(); activePopover = null; }
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest(".field-value") || e.target.closest(".field-action-chip") || e.target.closest(".redline-popover")) return;
    closePopover();
    deselectField();
  });

  function openPopover(anchorSpan, key) {
    closePopover();
    const f = fieldByKey[key];
    if (!f) return;
    const existing = edits[key];
    const current = existing ? existing.value : (f.current_value || "");
    let input;
    if (f.field_type === "multiline") input = el("textarea", {}, current);
    else if (f.field_type === "date") input = el("input", { type: "date", value: current });
    else if (f.field_type === "number") input = el("input", { type: "number", value: current });
    else input = el("input", { type: "text", value: current });
    const commentInput = el("textarea", { class: "rp-comment", placeholder: "Why? (optional)" }, existing ? existing.comment : "");

    const children = [
      el("div", { class: "rp-label" }, f.label),
      input,
      el("div", { class: "rp-label", style: "margin-top:10px;" }, "Comment"),
      commentInput,
      el("div", { class: "rp-actions" }, [
        el("button", { class: "btn secondary", onclick: () => { closePopover(); deselectField(); } }, "Cancel"),
        el("button", { class: "btn", onclick: () => setSuggestion(key, input.value, commentInput.value) }, "Suggest edit"),
      ]),
    ];
    if (existing) {
      children.push(el("div", { class: "rp-remove", onclick: () => setSuggestion(key, undefined, "") }, "Remove suggestion"));
    }

    const pop = el("div", { class: "redline-popover" }, children);
    document.body.appendChild(pop);
    const rect = anchorSpan.getBoundingClientRect();
    pop.style.top = Math.min(window.innerHeight - 280, rect.bottom + 8) + "px";
    pop.style.left = Math.min(window.innerWidth - 300, Math.max(8, rect.left)) + "px";
    activePopover = pop;
    input.focus();
  }

  preview.querySelectorAll(".field-value[data-field-key]").forEach((span) => {
    const key = span.getAttribute("data-field-key");
    span.addEventListener("click", (e) => { e.stopPropagation(); selectField(span, key); });
  });

  // apply any resumed draft to the spans before first paint
  Object.keys(edits).forEach((key) => spansForKey(key).forEach((span) => paintSpan(span, key)));

  const docCard = el("div", { class: "redline-doc-card" }, [preview]);

  // ---- fallback for contracts drafted before inline highlighting existed ----
  let orphanList = null;
  if (orphanFields.length) {
    orphanList = el("div", { class: "field-edit-list", style: "margin-top:16px;" });
    orphanFields.forEach((f) => {
      const existing = edits[f.field_key];
      let input;
      const val = existing ? existing.value : (f.current_value || "");
      if (f.field_type === "multiline") input = el("textarea", {}, val);
      else if (f.field_type === "date") input = el("input", { type: "date", value: val });
      else if (f.field_type === "number") input = el("input", { type: "number", value: val });
      else input = el("input", { type: "text", value: val });
      const commentInput = el("input", { type: "text", placeholder: "Comment (optional)", value: existing ? existing.comment : "" });
      const sync = () => setSuggestion(f.field_key, input.value, commentInput.value);
      input.addEventListener("change", sync);
      commentInput.addEventListener("change", sync);
      orphanList.appendChild(
        el("div", { class: "field-edit-card" }, [
          el("div", { class: "field-label-row" }, [
            el("div", { class: "field-label", style: "margin:0;" }, f.label),
            el("div", { class: "original" }, f.current_value ? `Currently: ${f.current_value}` : "Currently blank"),
          ]),
          input,
          commentInput,
        ])
      );
    });
    docCard.appendChild(orphanList);
  }

  const noteInput = el("textarea", { placeholder: "Anything else worth flagging that isn't one of the fields above?" }, (data.draft && data.draft.note) || "");
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
      const editList = Object.entries(edits).map(([field_key, e]) => ({ field_key, proposed_value: e.value, comment: e.comment }));
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
    const editList = Object.entries(edits).map(([field_key, e]) => ({ field_key, proposed_value: e.value, comment: e.comment }));
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

  refreshAll();

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
        // Countered fields become fresh suggestions for the next round; fold
        // them into the normal draft-resume path so DocumentView picks them
        // up the same way it would a saved-progress draft.
        const seeded = data.response.edits
          .filter((e) => e.decision === "countered")
          .map((e) => ({ field_key: e.field_key, proposed_value: e.counter_value, comment: "" }));
        const fresh = await api(`/api/share/${TOKEN}`);
        if (seeded.length) {
          fresh.draft = fresh.draft || { note: "", edits: [] };
          const existingKeys = new Set(fresh.draft.edits.map((e) => e.field_key));
          seeded.forEach((s) => { if (!existingKeys.has(s.field_key)) fresh.draft.edits.push(s); });
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
