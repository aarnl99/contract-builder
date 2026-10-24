// Standalone client-facing redline page. Deliberately separate from app.js
// -- the person here has no Rotely account, and the session token they get
// after entering the access code lives only in memory (this variable),
// never in localStorage/sessionStorage/cookies, so it's gone the moment
// they close or reload the tab and they simply enter the code again next
// time, matching how this was scoped. In-progress redlines themselves are
// saved server-side by autosave instead, so re-entering the code
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
// that hasn't been sent to the server yet, via either autosave or
// "Finalize and submit" -- an accidental reload or tab close would silently
// lose it with no warning otherwise. Module-level (not local to
// DocumentView) so it survives DocumentView being torn down and rebuilt
// mid-session (e.g. after acknowledging a response) without stacking up
// duplicate beforeunload listeners that could reference stale state.
let hasUnsavedChanges = false;
// The page saves a moment after the last edit (see the bottom bar in
// DocumentView, which sets this hook), so there is no Save button to forget.
let autosaveHook = null;
function markDirty() {
  hasUnsavedChanges = true;
  if (autosaveHook) autosaveHook();
}
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
    // HTTP/2 (Render's edge) has no status-reason phrase, so statusText is
    // "" -- and an unhandled server crash is a plain-text 500 with no JSON
    // "detail". Both used to surface as a blank error box. FastAPI's 422
    // also sends detail as an ARRAY of {msg, loc}, which "[object Object]"-ed.
    let msg = "";
    try {
      const data = await res.json();
      const d = data && data.detail;
      if (typeof d === "string") msg = d;
      else if (Array.isArray(d)) msg = d.map((x) => (x && x.msg) || "").filter(Boolean).join("; ");
      else if (d && typeof d === "object") msg = d.message || "";
    } catch (e) {}
    if (!msg) msg = res.statusText || "";
    if (!msg) msg = res.status >= 500
      ? `Something went wrong on our end (error ${res.status}). Please try again in a moment.`
      : `Something went wrong (error ${res.status}). Please try again.`;
    throw new Error(msg);
  }
  return res.json();
}

const app = document.getElementById("app");
function render(view) {
  app.innerHTML = "";
  app.appendChild(view);
  if (BRAND) app.appendChild(poweredBy());
}


// ---- owner's branding (logo or name) in place of the Rotely wordmark, plus
// a small "Powered by Rotely.ai" footer. Loaded once, in the background, so
// the page never waits on it; if it can't be loaded the page just keeps the
// default Rotely look.
let BRAND = null;

function poweredBy() {
  return el("div", { class: "powered-by" }, [
    "Powered by ",
    el("a", { href: "https://rotely.ai", target: "_blank", rel: "noopener" }, ["Rotely", el("span", { class: "dot" }, ".ai")]),
  ]);
}

async function loadBrand() {
  try {
    const res = await fetch(`/api/share/${TOKEN}/brand`);
    if (!res.ok) return;
    BRAND = await res.json();
    if (!BRAND || !BRAND.name) { BRAND = null; return; }
    document.querySelectorAll(".share-topbar").forEach((n) => n.replaceWith(topbar()));
    if (!document.querySelector(".powered-by")) app.appendChild(poweredBy());
  } catch (e) { /* keep the default look */ }
}

function topbar() {
  if (BRAND && BRAND.name) {
    const mark = [
      BRAND.logo_url
        ? el("img", { class: "brand-logo", src: BRAND.logo_url, alt: BRAND.name })
        : el("div", { class: "brand-name" }, BRAND.name),
    ];
    // Clickable only when the owner chose a website for it (plain http(s) only).
    const clickable = typeof BRAND.link === "string" && /^https?:\/\//i.test(BRAND.link);
    return el("div", { class: "share-topbar" }, [
      clickable
        ? el("a", { class: "brand brand-custom", href: BRAND.link, target: "_blank", rel: "noopener noreferrer", title: "Visit " + BRAND.name }, mark)
        : el("div", { class: "brand brand-custom" }, mark),
    ]);
  }
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
// One edit described in plain words: an addition (with its style), a
// removal, a comment on unchanged text, or before -> after.
function changeLine(original, shown, loc, comment, prefix) {
  original = original || ""; shown = shown || "";
  const RU = window.RedlineUI;
  const fw = RU.fmtWords(loc && loc.format);
  const fwNote = fw ? ` (${fw})` : "";
  const pre = prefix ? prefix + " " : "";
  if (!original && shown.trim()) {
    return el("div", { class: "re-diff" }, [pre + (loc && loc.new_paragraph ? "Add a new paragraph: “" : "Add: “"), el("span", { class: "new" }, shown.trim()), `”${fwNote}`]);
  }
  if (original && !shown.trim()) {
    return el("div", { class: "re-diff" }, [pre + "Remove: “", el("span", { class: "old" }, original), "”"]);
  }
  if (original && original.trim() === shown.trim() && comment) {
    return el("div", { class: "re-diff" }, [pre + "Comment on: “", el("span", {}, original), "”"]);
  }
  return el("div", { class: "re-diff" }, [
    pre, el("span", { class: "old" }, original || "(blank)"), " → ", el("span", { class: "new" }, shown || "(blank)"), fwNote,
  ]);
}

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
        changeLine(e.original_value, e.counter_value, e.location, e.comment),
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
      !e.original_value || !(e.proposed_value || "").trim() || (e.original_value || "").trim() === (e.proposed_value || "").trim()
        ? changeLine(e.original_value, e.proposed_value, e.location, e.comment, "You proposed:")
        : el("div", { class: "re-diff" }, ["You proposed: ", el("span", { class: "new" }, e.proposed_value || "(blank)")]),
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

function locKey(loc) {
  if (loc.new_paragraph) return `${loc.table_path || ""}|${loc.paragraph_index}|P${loc.uid}`;
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
  // The key stays pinned while the person reads and edits.
  shell.appendChild(window.RedlineUI.keyBar());

  const pristineHtml = data.html || "<p>No preview available.</p>";
  const preview = el("div", { class: "contract-view" });
  preview.innerHTML = pristineHtml;

  const errBox = el("div", { style: "margin-top:14px;" });

  const fieldByKey = {};
  (data.fields || []).forEach((f) => { fieldByKey[f.field_key] = f; });

  // locKey(location) -> { field_key, label, location, original_text, value, comment,
  // counterPending, clientOriginalValue, sourceEditId }. counterPending marks a
  // spot the sender just countered that the client hasn't explicitly accepted,
  // rejected, or re-suggested yet -- see handleMarkClick / renderList below,
  // where those get a 3-way Accept/Reject/Suggest chip instead of the
  // normal "Edit / Remove" one. sourceEditId, when set, is the id of
  // the sender's countered RedlineEdit this spot originated from -- sent back
  // as accepting_edit_id on submit so the server can recognize "the client is
  // just taking the sender's own counter" and skip re-asking the sender to
  // approve a value they already proposed themselves (see acceptCounter).
  //
  // What an entry means is read from its location + value (see kindOf):
  //   insert    zero-width segment (start == end): words added between two others
  //   paragraph location.new_paragraph: a whole new paragraph after paragraph_index
  //   delete    a selection with an empty value
  //   comment   a selection whose value is unchanged, with a comment
  //   replace   a selection with different text
  // location.format ("b", "i", "u" in any mix) styles the new text.
  const edits = {};
  const RU = window.RedlineUI;
  let newParaSeq = 0;

  // The document exactly as the server sent it, kept off-screen so we can look
  // up the original text around a click (for spacing and list labels) no
  // matter what has been painted into the visible copy.
  const pristineRoot = document.createElement("div");
  pristineRoot.innerHTML = pristineHtml;
  function pristinePara(tablePath, pIdx) {
    const sel = tablePath
      ? `.para[data-path="${cssEscape(tablePath)}"][data-p="${pIdx}"]`
      : `.para[data-p="${pIdx}"]:not([data-path])`;
    return pristineRoot.querySelector(sel);
  }
  function pristineParaText(tablePath, pIdx) {
    const p = pristinePara(tablePath, pIdx);
    return p ? p.textContent : "";
  }
  function pristineRunText(tablePath, pIdx, r) {
    const p = pristinePara(tablePath, pIdx);
    const run = p ? p.querySelector(`.run[data-r="${r}"]`) : null;
    return run ? run.textContent : "";
  }

  function kindOf(e) {
    const l = e.location;
    if (l.new_paragraph) return "paragraph";
    if (l.segments.length && l.segments.every((s) => s.start === s.end)) return "insert";
    const val = (e.value || "").trim(), orig = (e.original_text || "").trim();
    if (!val && orig) return "delete";
    if (val === orig) return "comment";
    return "replace";
  }
  const KIND_LABEL = { insert: "Insert", paragraph: "New paragraph", replace: "Replace", delete: "Delete", comment: "Comment" };

  function truncate(s, n) {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  if (data.draft && data.draft.edits) {
    data.draft.edits.forEach((e) => {
      const l = e.location;
      if (!l) return;
      const isNew = !!l.new_paragraph;
      if (!isNew && (!l.segments || !l.segments.length)) return;
      const loc = {
        table_path: l.table_path || "", paragraph_index: l.paragraph_index,
        segments: isNew ? [] : l.segments, format: l.format || "",
      };
      if (isNew) { loc.new_paragraph = true; loc.uid = ++newParaSeq; }
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
  // Set once the bottom bar exists; keeps its message and Finalize button
  // in step with the edits (see the bar below).
  let barUpdate = () => {};
  function renderStats() {
    barUpdate();
    statsBar.innerHTML = "";
    const changed = Object.keys(edits).length;
    statsBar.appendChild(
      el("div", { class: "stat-tile" }, [
        el("div", { class: "num" }, String(changed)),
        el("div", { class: "cap" }, changed === 1 ? "change suggested" : "changes suggested"),
      ])
    );
  }

  // ---- redline list (sidebar): numbered like the badges in the document ----
  const redlineList = el("div", { class: "redline-list" });
  function renderList() {
    redlineList.innerHTML = "";
    const keys = Object.keys(edits);
    if (!keys.length) {
      redlineList.appendChild(el("div", { class: "redline-list-empty" }, "Nothing yet. Highlight some text, or click between two words."));
      return;
    }
    keys.forEach((key, idx) => {
      const e = edits[key];
      const kind = kindOf(e);
      const fw = RU.fmtWords(e.location.format);
      const fwNote = fw ? ` (${fw})` : "";
      let main;
      if (kind === "insert") main = el("div", { class: "rl-diff" }, [`Add “`, el("span", { class: "new" }, (e.value || "").trim()), `”${fwNote}`]);
      else if (kind === "paragraph") main = el("div", { class: "rl-diff" }, [`Add paragraph “`, el("span", { class: "new" }, truncate(e.value, 90)), `”${fwNote}`]);
      else if (kind === "delete") main = el("div", { class: "rl-diff" }, [`Remove “`, el("span", { class: "old" }, truncate(e.original_text, 90)), `”`]);
      else if (kind === "comment") main = el("div", { class: "rl-diff" }, [`“${truncate(e.original_text, 90)}”`]);
      else main = el("div", { class: "rl-diff" }, [
        el("span", { class: "old" }, e.original_text || "(blank)"), " → ", el("span", { class: "new" }, e.value || "(blank)"),
      ]);
      const rows = [main];
      if (e.comment) rows.push(el("div", { class: "rl-comment" }, [`"${e.comment}"`]));
      let topRight;
      if (e.counterPending) {
        rows.unshift(el("div", { class: "rl-counter-note" }, "The sender countered this — accept it, reject it, or suggest something else."));
        topRight = el("div", { class: "rl-counter-actions" }, [
          el("button", { class: "rl-mini-btn accept", onclick: (ev) => { ev.stopPropagation(); acceptCounter(key); } }, "Accept"),
          el("button", { class: "rl-mini-btn suggest", onclick: (ev) => { ev.stopPropagation(); editFromKey(key, ev.currentTarget.getBoundingClientRect()); } }, "Suggest edit"),
          el("button", { class: "rl-mini-btn reject", onclick: (ev) => { ev.stopPropagation(); rejectCounter(key); } }, "Reject"),
        ]);
      } else {
        topRight = el("div", { class: "rl-remove", onclick: (ev) => { ev.stopPropagation(); removeSuggestion(key); } }, "Remove");
      }
      redlineList.appendChild(
        el("div", {
          class: "redline-list-item" + (e.counterPending ? " counter-pending" : ""),
          onclick: () => {
            const m = preview.querySelector(`[data-edit-key="${cssEscape(key)}"]`);
            if (m) m.scrollIntoView({ block: "center", behavior: "smooth" });
          },
        }, [
          el("div", { class: "rl-top" }, [
            el("span", { class: "rl-num" }, String(idx + 1)),
            el("span", { class: "rl-tag " + kind }, KIND_LABEL[kind]),
            el("div", { class: "rl-label" }, e.label || ""),
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
    markDirty();
    dismiss();
    repaint();
  }

  function rejectCounter(key) {
    if (!edits[key]) return;
    edits[key].value = edits[key].clientOriginalValue;
    edits[key].counterPending = false;
    markDirty();
    dismiss();
    repaint();
  }

  // ---- painting: always redraw from the pristine HTML, then re-apply every
  // current edit at its exact run/offset location. Simpler and far less
  // error-prone than mutating the live DOM incrementally, since two edits can
  // land in the same run and need to be spliced together in one pass. The
  // "ghost" is an unsaved edit being typed in a card; it is painted through
  // the very same path, so what you see while typing is what you get. ----
  const GHOST = "__ghost";
  let ghost = null; // { kind, edit, replacesKey }

  function badgeEl(key, n) {
    return el("span", { class: "rl-badge", "data-edit-key": key, title: "See your note" }, String(n));
  }

  function paintDocument() {
    preview.innerHTML = pristineHtml;
    const order = Object.keys(edits);
    const entries = order.filter((k) => !(ghost && ghost.replacesKey === k)).map((k) => [k, edits[k]]);
    if (ghost) entries.push([GHOST, ghost.edit]);
    const byPara = {}, newParas = {};
    entries.forEach(([key, e]) => {
      const pk = `${e.location.table_path || ""} ${e.location.paragraph_index}`;
      const bucket = e.location.new_paragraph ? newParas : byPara;
      (bucket[pk] = bucket[pk] || []).push({ key, edit: e });
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
        segEdits.sort((a, b) => a.seg.start - b.seg.start || a.seg.end - b.seg.end);
        const text = runEl.textContent;
        const frag = document.createDocumentFragment();
        const seen = new Set();
        let cursor = 0;
        segEdits.forEach(({ seg, edit, key }) => {
          const start = Math.max(seg.start, cursor);
          const end = Math.max(seg.end, start);
          if (start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, start)));
          const isGhost = key === GHOST;
          const kind = isGhost ? ghost.kind : kindOf(edit);
          // The counter-pending indicator is scoped to just the marks for
          // THIS edit, not the whole .run -- a run can span an entire
          // clause (Word often merges a whole sentence into one run when
          // there's no formatting boundary). data-edit-key scopes the
          // click-to-decide highlight the same way -- see handleMarkClick.
          const pendingCls = edit.counterPending ? " counter-pending" : "";
          const keyAttr = isGhost ? {} : { "data-edit-key": key };
          const first = !seen.has(edit);
          seen.add(edit);
          const n = order.indexOf(key) + 1;
          const withBadge = (node) => {
            frag.appendChild(node);
            if (first && !isGhost && edit.comment) frag.appendChild(badgeEl(key, n));
          };
          const fmt = RU.fmtClasses(edit.location.format);
          const insNode = () => el("span", { class: (isGhost ? "fv-ghost" : "fv-ins") + fmt + pendingCls, ...keyAttr }, edit.value || "");
          if (kind === "insert") {
            if (first) withBadge(insNode());
          } else if (kind === "comment") {
            const c = el("span", { class: "rl-cmt" + pendingCls, ...keyAttr }, text.slice(start, end));
            frag.appendChild(c);
            if (first && edit.comment) frag.appendChild(badgeEl(key, n));
          } else {
            frag.appendChild(el("span", { class: "fv-del" + pendingCls, ...keyAttr }, text.slice(start, end)));
            if (kind === "replace" && first) withBadge(insNode());
            else if (kind === "delete" && first && edit.comment && !isGhost) frag.appendChild(badgeEl(key, n));
          }
          cursor = end;
        });
        if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
        runEl.classList.add("has-suggestion");
        runEl.innerHTML = "";
        runEl.appendChild(frag);
      });
    });

    // New paragraphs go in after their paragraph, in the order they were made.
    Object.entries(newParas).forEach(([pk, list]) => {
      const [tablePath, pIdxStr] = pk.split(" ");
      let anchor = findParaEl(tablePath, parseInt(pIdxStr, 10));
      if (!anchor) return;
      list.forEach(({ key, edit }) => {
        const isGhost = key === GHOST;
        const pendingCls = edit.counterPending ? " counter-pending" : "";
        const p = el("p", {
          class: "newp-mark" + (isGhost ? " ghost" : "") + RU.fmtClasses(edit.location.format) + pendingCls,
          ...(isGhost ? {} : { "data-edit-key": key }),
        }, [el("span", { class: "np-text" }, edit.value || "")]);
        if (!isGhost && edit.comment) p.appendChild(badgeEl(key, order.indexOf(key) + 1));
        anchor.after(p);
        anchor = p;
      });
    });
  }

  function repaint() {
    paintDocument();
    renderStats();
    renderList();
  }

  function endGhost() {
    if (!ghost) return;
    ghost = null;
    paintDocument();
  }

  // ---- saving a suggestion into the list ----
  function overlaps(loc, ignoreKey) {
    if (loc.new_paragraph) return false;
    return Object.entries(edits).some(([k, e]) => {
      if (k === ignoreKey || e.location.new_paragraph) return false;
      if (e.location.table_path !== loc.table_path || e.location.paragraph_index !== loc.paragraph_index) return false;
      return e.location.segments.some((a) => loc.segments.some((b) => {
        if (a.r !== b.r) return false;
        const aZero = a.start === a.end, bZero = b.start === b.end;
        if (aZero && bZero) return a.start === b.start;
        if (aZero) return a.start > b.start && a.start < b.end;
        if (bZero) return b.start > a.start && b.start < a.end;
        return a.start < b.end && b.start < a.end;
      }));
    });
  }

  function paddedInsert(loc, value) {
    const seg = loc.segments[0];
    const t = pristineRunText(loc.table_path, loc.paragraph_index, seg.r);
    return RU.padInsert(t[seg.start - 1] || "", t[seg.start] || "", value);
  }

  function commit(o) {
    // Carry the chain reference forward if this spot already had one --
    // see the sourceEditId comment above and bug tracker #20. Without
    // this, suggesting a different value than the sender's counter (the
    // "Suggest edit" button on a counterPending spot, as opposed to
    // "Accept") rebuilt this entry from scratch and silently dropped the
    // link back to the counter it was responding to, so the sender's next
    // review saw an unrelated fresh redline instead of a continued
    // negotiation.
    const priorSourceEditId = (edits[o.key] || {}).sourceEditId || null;
    const comment = (o.comment || "").trim();
    const loc = { ...o.location, format: "" };
    let value, keep = true;
    if (o.mode === "insert") {
      // Unlike a replacement, an insert's spaces matter ("in full " between two
      // words), so it is never trimmed; we add the missing spaces instead.
      keep = !!(o.value || "").trim();
      value = keep ? paddedInsert(loc, o.value) : "";
      loc.format = o.format || "";
    } else if (o.mode === "paragraph") {
      value = (o.value || "").trim();
      keep = !!value && value !== (o.prefill || "").trim();
      loc.format = o.format || "";
    } else if (o.mode === "comment") {
      value = (o.originalText || "").trim();
      keep = !!comment;
    } else if (o.mode === "delete") {
      value = "";
    } else {
      value = (o.value || "").trim();
      loc.format = o.format || "";
      if (value === (o.originalText || "").trim() && !comment) keep = false;
      if (value === (o.originalText || "").trim()) loc.format = "";
    }
    if (!keep) {
      delete edits[o.key];
    } else {
      edits[o.key] = {
        field_key: o.fieldKey || "", label: o.label || "", location: loc,
        original_text: o.mode === "paragraph" || o.mode === "insert" ? "" : o.originalText,
        value, comment, sourceEditId: priorSourceEditId,
      };
    }
    markDirty();
    dismiss();
    repaint();
  }

  function removeSuggestion(key) {
    delete edits[key];
    markDirty();
    dismiss();
    repaint();
  }

  // ---- selection, highlight and the floating menus ----
  let selectedEls = [];
  let actionChip = null;
  // A free-text drag can cover only PART of a .run (e.g. one word inside a
  // run that holds a whole clause) -- highlighting the whole run in that
  // case would visually mark far more than was actually selected, even
  // though the edit itself only ever targets the true start/end offsets.
  // These small fixed-position overlays are drawn from the selection
  // Range's own client rects instead, so the highlight always matches
  // exactly what was dragged over, line-wraps and all, without touching
  // the run's DOM.
  let selectionHighlightEls = [];

  function clearSelectionHighlight() {
    selectionHighlightEls.forEach((elx) => elx.remove());
    selectionHighlightEls = [];
  }

  // The overlays are position:fixed, so they have to be redrawn when the page
  // scrolls or resizes or they float away from the words they mark.
  let highlightedRange = null;
  function redrawHighlight() {
    if (!highlightedRange) return;
    try { highlightRange(highlightedRange); } catch (e) { clearSelectionHighlight(); }
  }
  window.addEventListener("scroll", redrawHighlight, true);
  window.addEventListener("resize", redrawHighlight);

  function highlightRange(range) {
    clearSelectionHighlight();
    highlightedRange = range;
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
    highlightedRange = null;
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
    const suggestBtn = el("button", { class: "fdc-btn fdc-suggest" }, "Suggest edit");
    acceptBtn.addEventListener("click", (e) => { e.stopPropagation(); onAccept(); });
    rejectBtn.addEventListener("click", (e) => { e.stopPropagation(); onReject(); });
    suggestBtn.addEventListener("click", (e) => { e.stopPropagation(); onSuggest(); });
    actionChip = el("div", { class: "field-decision-chip" }, [
      el("div", { class: "fdc-ask" }, "The sender countered. Decide:"),
      el("div", { class: "fdc-row" }, [acceptBtn, suggestBtn, rejectBtn]),
    ]);
    document.body.appendChild(actionChip);
    actionChip.style.top = Math.min(window.innerHeight - 60, anchorRect.bottom + 8) + "px";
    actionChip.style.left = Math.min(window.innerWidth - 270, Math.max(8, anchorRect.left)) + "px";
  }

  function showPill(anchorRect, buttons) {
    if (actionChip) actionChip.remove();
    actionChip = RU.pill(buttons, anchorRect);
  }

  let activePopover = null;
  function closePopover() {
    if (activePopover) { activePopover.remove(); activePopover = null; }
  }
  // Close whatever is open: card, pill, highlight and any half-typed ghost.
  function dismiss() {
    closePopover();
    deselectField();
    endGhost();
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest(".contract-view") || e.target.closest(".field-action-chip") || e.target.closest(".field-decision-chip") || e.target.closest(".rl-pill") || e.target.closest(".redline-popover")) return;
    dismiss();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") dismiss(); });

  // ---- the card: one form for comment / replace / insert / new paragraph ----
  function openCard(o) {
    closePopover();
    if (actionChip) { actionChip.remove(); actionChip = null; }
    const mode = o.mode;
    const st = RU.fmtFlags(o.currentFormat);
    const isTyped = mode === "replace" && (o.fieldType === "date" || o.fieldType === "number");
    const canFormat = !isTyped && mode !== "comment";
    const live = mode === "insert" || mode === "paragraph";

    let input;
    if (mode === "comment") input = el("textarea", { rows: "3", placeholder: "What do you want to say about this?" }, o.currentComment || "");
    else if (mode === "insert") input = el("textarea", { rows: "3", placeholder: "Type the words to add…" }, o.currentValue || "");
    else if (mode === "paragraph") input = el("textarea", { rows: "3", placeholder: "Type the new paragraph…" }, o.currentValue || "");
    else if (o.fieldType === "multiline") input = el("textarea", {}, o.currentValue);
    else if (o.fieldType === "date") input = el("input", { type: "date", value: o.currentValue });
    else if (o.fieldType === "number") input = el("input", { type: "number", value: o.currentValue });
    else if (o.fieldType === "text") input = el("input", { type: "text", value: o.currentValue });
    else input = el("textarea", { rows: "2" }, o.currentValue); // free-text selection, not a known field -- could be a whole clause
    input.classList.add("rl-main-input");
    const commentInput = mode === "comment" ? null
      : el("textarea", { class: "rp-comment", placeholder: "Why? (optional)" }, o.currentComment || "");

    const TITLES = { comment: "Comment on this text", replace: o.label || "Replace with", insert: "Insert text here", paragraph: "New paragraph below" };
    const OK = { comment: "Add comment", replace: "Suggest replacement", insert: "Add text", paragraph: "Add paragraph" };
    let quote = null;
    if (mode === "comment" || mode === "replace") quote = `Currently: “${truncate(o.originalText, 160) || "(blank)"}”`;
    if (mode === "paragraph") quote = `After: “${truncate(o.contextText, 80)}”`;
    let hint = null;
    if (mode === "comment") hint = "The wording stays as it is. Your note goes to the sender next to this passage.";
    if (mode === "insert") hint = "You can see it in the contract as you type. Nothing existing is removed, and we add spaces around it if needed.";
    if (mode === "paragraph") hint = (o.prefill
      ? `Your list uses typed labels, so it starts with “${o.prefill.trim()}”. Change it if you like. `
      : "It copies the look of the paragraph above. ") + "Nothing existing is changed.";

    let okBtn;
    const syncGhost = () => {
      if (!live) return;
      ghost.edit.value = mode === "insert" ? paddedInsert(ghost.edit.location, input.value) : input.value;
      ghost.edit.location = { ...ghost.edit.location, format: RU.fmtString(st) };
      paintDocument();
    };
    const syncOk = () => {
      if (!okBtn) return;
      const v = input.value.trim();
      if (mode === "comment" || mode === "insert") okBtn.disabled = !v;
      else if (mode === "paragraph") okBtn.disabled = !v || v === (o.prefill || "").trim();
      else okBtn.disabled = false;
    };

    const fmtRow = canFormat ? RU.formatButtons(st, syncGhost) : null;
    const labelRow = el("div", { class: "rp-label rl-label-row" }, [
      el("span", {}, mode === "insert" ? "New text" : mode === "paragraph" ? "Paragraph text" : mode === "comment" ? "Your comment" : (o.label ? "Replace with" : "New text")),
      fmtRow,
    ]);

    const kids = [
      el("div", { class: "rp-label" }, TITLES[mode]),
      quote ? el("div", { class: "rl-quote" }, quote) : null,
      labelRow, input, commentInput,
      hint ? el("div", { class: "rl-hint" }, hint) : null,
    ];
    okBtn = el("button", { class: "btn", onclick: () => commit({
      mode, key: o.key, location: o.location, fieldKey: o.fieldKey, label: o.label,
      originalText: o.originalText, value: input.value, comment: commentInput ? commentInput.value : input.value,
      format: canFormat ? RU.fmtString(st) : "", prefill: o.prefill || "",
    }) }, OK[mode]);
    kids.push(el("div", { class: "rp-actions" }, [
      el("button", { class: "btn secondary", onclick: () => dismiss() }, "Cancel"),
      okBtn,
    ]));
    if (edits[o.key]) kids.push(el("div", { class: "rp-remove", onclick: () => removeSuggestion(o.key) }, "Remove suggestion"));

    // Paint the live ghost first so the card can sit next to it.
    let anchorRect = o.anchorRect;
    if (live) {
      ghost = {
        kind: mode, replacesKey: edits[o.key] ? o.key : null,
        edit: { location: { ...o.location, format: RU.fmtString(st) }, value: mode === "insert" ? paddedInsert(o.location, o.currentValue || "") : (o.currentValue || ""), comment: "" },
      };
      paintDocument();
      const g = preview.querySelector(".fv-ghost, .newp-mark.ghost");
      if (g) {
        anchorRect = g.getBoundingClientRect();
        // On a phone the card covers the bottom of the screen, so bring the
        // spot being edited up into the visible part first.
        if (window.innerWidth <= 640 && anchorRect.bottom > window.innerHeight * 0.45) {
          window.scrollBy(0, anchorRect.bottom - window.innerHeight * 0.35);
          anchorRect = g.getBoundingClientRect();
        }
      }
    }

    const pop = el("div", { class: "redline-popover rl-card" }, kids);
    document.body.appendChild(pop);
    RU.place(pop, anchorRect || { left: 20, bottom: 80, top: 60 }, 320);
    activePopover = pop;
    if (live) input.addEventListener("input", () => { syncGhost(); syncOk(); });
    else input.addEventListener("input", syncOk);
    syncOk();
    input.focus();
    if (input.setSelectionRange && mode !== "replace") { try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {} }
  }

  // Open the right card for a suggestion that already exists.
  function editFromKey(key, anchorRect) {
    const e = edits[key];
    if (!e) return;
    const kind = kindOf(e);
    const f = fieldByKey[e.field_key];
    const mode = kind === "delete" ? "replace" : kind;
    const loc = e.location;
    openCard({
      mode, key, location: loc, fieldKey: e.field_key, label: e.label,
      originalText: e.original_text,
      currentValue: kind === "comment" ? e.original_text : e.value,
      currentComment: e.comment, currentFormat: loc.format,
      fieldType: f ? f.field_type : "", anchorRect,
      contextText: kind === "paragraph" ? pristineParaText(loc.table_path, loc.paragraph_index) : "",
      prefill: "",
    });
  }

  // ---- what happens when the person clicks or highlights ----
  function handleMarkClick(key, markEl) {
    const e = edits[key];
    if (!e) return;
    dismiss();
    const spans = Array.from(preview.querySelectorAll(`[data-edit-key="${cssEscape(key)}"]`)).filter((n) => !n.classList.contains("rl-badge"));
    const targets = spans.length ? spans : [markEl];
    targets.forEach((t) => t.classList.add("selected"));
    selectedEls = targets;
    const anchorRect = targets[targets.length - 1].getBoundingClientRect();
    if (e.counterPending) {
      showDecisionChip(anchorRect, {
        onAccept: () => acceptCounter(key),
        onReject: () => rejectCounter(key),
        onSuggest: () => editFromKey(key, anchorRect),
      });
      return;
    }
    showPill(anchorRect, [
      { label: "✎ Edit", onClick: () => editFromKey(key, anchorRect) },
      { label: "Remove", cls: "warn", onClick: () => removeSuggestion(key) },
    ]);
  }

  function startParagraph(base, anchorRect) {
    const loc = { table_path: base.table_path, paragraph_index: base.paragraph_index, segments: [], new_paragraph: true, uid: ++newParaSeq, format: "" };
    const above = pristineParaText(loc.table_path, loc.paragraph_index);
    const label = RU.nextLabel(above);
    openCard({
      mode: "paragraph", key: locKey(loc), location: loc, currentValue: label, prefill: label,
      contextText: above, anchorRect,
    });
  }

  // Click between two words.
  function handleCaretClick(ev) {
    const sel = window.getSelection();
    const fallback = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const info = RU.caretInfo(preview, ev.clientX, ev.clientY, fallback);
    if (!info) { dismiss(); return; }
    const loc = { table_path: info.table_path, paragraph_index: info.paragraph_index, segments: info.segments, format: "" };
    const key = locKey(loc);
    dismiss();
    if (edits[key]) { editFromKey(key, info.rect); return; }
    // Show the blinking caret where the words would go.
    ghost = { kind: "insert", replacesKey: null, edit: { location: loc, value: "", comment: "" } };
    paintDocument();
    const g = preview.querySelector(".fv-ghost");
    const rect = g ? g.getBoundingClientRect() : info.rect;
    showPill(rect, [
      { label: "＋ Insert text here", onClick: () => openCard({ mode: "insert", key, location: loc, currentValue: "", currentComment: "", anchorRect: rect }) },
      { label: "¶ New paragraph below", onClick: () => startParagraph(loc, rect) },
    ]);
  }

  function handleRunClick(runEl, ev) {
    const paraEl = runEl.closest(".para");
    if (!paraEl) return;
    const pIdx = parseInt(paraEl.dataset.p, 10);
    const tablePath = paraEl.dataset.path || "";
    const rIdx = parseInt(runEl.dataset.r, 10);

    const fieldKey = runEl.getAttribute("data-field-key");
    if (fieldKey && !runEl.classList.contains("has-suggestion")) {
      const runLen = (runEl.textContent || "").length;
      const loc = { table_path: tablePath, paragraph_index: pIdx, segments: [{ r: rIdx, start: 0, end: runLen }], format: "" };
      const f = fieldByKey[fieldKey];
      dismiss();
      runEl.classList.add("selected");
      selectedEls = [runEl];
      showActionChip(runEl.getBoundingClientRect(), "Suggest edit ✎", () => {
        openCard({
          mode: "replace", key: locKey(loc), location: loc, fieldKey, label: f ? f.label : fieldKey,
          originalText: runEl.textContent, currentValue: runEl.textContent, currentComment: "",
          fieldType: f ? f.field_type : "text", anchorRect: runEl.getBoundingClientRect(),
        });
      });
      return;
    }
    handleCaretClick(ev);
  }

  // A drag-selection: Comment / Replace / Delete.
  function handleTextSelection(info, anchorRect, range) {
    const loc = { table_path: info.table_path || "", paragraph_index: info.paragraph_index, segments: info.segments, format: "" };
    const key = locKey(loc);
    dismiss();
    if (edits[key]) { editFromKey(key, anchorRect); return; }
    if (overlaps(loc, key)) {
      alert("Part of that already has a suggestion. Click the mark to change or remove it, or pick different words.");
      return;
    }
    // Highlight exactly the dragged-over text, not the whole run(s) it sits
    // inside -- a run can hold an entire clause, so marking the full run
    // here would visually cover far more than the person actually selected.
    if (range) highlightRange(range);
    const base = { key, location: loc, fieldKey: "", label: "", originalText: info.text, anchorRect };
    showPill(anchorRect, [
      { label: "✎ Replace", onClick: () => openCard({ ...base, mode: "replace", currentValue: info.text, currentComment: "" }) },
      { label: "💬 Comment", onClick: () => openCard({ ...base, mode: "comment", currentValue: info.text, currentComment: "" }) },
      { label: "🗑 Delete", cls: "warn", onClick: () => commit({ ...base, mode: "delete", value: "", comment: "", format: "" }) },
    ]);
  }

  function attachRunHandlers() {
    preview.addEventListener("mouseup", onPreviewMouseUp);
    // Phones: long-press + dragging the selection handles never sends a
    // mouse-up, so also react once a selection inside the document has
    // stopped changing.
    document.addEventListener("selectionchange", onSelectionChange);
  }

  // Turns the current (non-empty) selection inside the document into the
  // Comment / Replace / Delete pill. Shared by the mouse and touch paths; a
  // selection that was already handled is cleared, so the second path sees
  // nothing.
  function processSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!preview.contains(range.commonAncestorContainer)) return false;
    const rect = range.getBoundingClientRect();
    const info = RU.selectionInfo(preview, range);
    const hl = range.cloneRange();
    sel.removeAllRanges();
    if (!info) return true;
    if (info.error === "cross-paragraph") {
      alert("Please select text within a single paragraph.");
      return true;
    }
    if (!info.text.trim()) return true;
    handleTextSelection(info, rect, hl);
    return true;
  }

  let selectionTimer = null;
  function onSelectionChange() {
    clearTimeout(selectionTimer);
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    if (!preview.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
    // Wait for the person to stop adjusting the handles.
    selectionTimer = setTimeout(processSelection, 450);
  }

  function onPreviewMouseUp(e) {
    clearTimeout(selectionTimer);
    const target = e.target;
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) { processSelection(); return; }
      const markEl = target.closest ? target.closest("[data-edit-key]") : null;
      if (markEl && preview.contains(markEl)) { handleMarkClick(markEl.getAttribute("data-edit-key"), markEl); return; }
      const runEl = target.closest ? target.closest(".run") : null;
      if (!runEl || !preview.contains(runEl)) { dismiss(); return; }
      handleRunClick(runEl, e);
    }, 0);
  }

  attachRunHandlers();
  repaint();

  const docCard = el("div", { class: "redline-doc-card" }, [preview]);

  const noteInput = el("textarea", { placeholder: "Anything else worth flagging that isn't captured above?" }, (data.draft && data.draft.note) || "");
  noteInput.addEventListener("input", () => {
    markDirty();
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
    const shownNew = (isOwnerEdit ? edit.counter_value : edit.proposed_value) || "";
    const isNewPara = !!edit.new_paragraph;
    const fwNote = window.RedlineUI.fmtWords(edit.format) ? ` (${window.RedlineUI.fmtWords(edit.format)})` : "";
    const rows = [
      !edit.original_value && shownNew
        ? el("div", { class: "rl-diff" }, [isNewPara ? "Add paragraph “" : "Add “", el("span", { class: "new" }, shownNew.trim()), `”${fwNote}`])
        : edit.original_value && !shownNew
        ? el("div", { class: "rl-diff" }, ["Remove “", el("span", { class: "old" }, edit.original_value), "”"])
        : edit.original_value && edit.original_value.trim() === shownNew.trim() && edit.comment
        ? el("div", { class: "rl-diff" }, ["Comment on “", el("span", {}, edit.original_value), "”"])
        : el("div", { class: "rl-diff" }, [
            el("span", { class: "old" }, edit.original_value || "(blank)"),
            " → ",
            el("span", { class: "new" }, shownNew || "(blank)"),
            fwNote,
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
  // Changes save themselves ~1.5s after the last edit, so there is no
  // "Save progress" button. The bar just says when it last saved.
  const saveNote = el("span", { class: "save-note" }, "");
  let saveTimer = null;
  let saving = false;
  let dirtyWhileSaving = false;
  async function saveProgress() {
    if (saving) { dirtyWhileSaving = true; return; }
    saving = true;
    saveNote.textContent = "Saving…";
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
      if (!dirtyWhileSaving) hasUnsavedChanges = false;
      saveNote.textContent = "✓ Saved " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + ". Come back anytime with your access code.";
    } catch (e) {
      saveNote.textContent = "Couldn't save yet (" + e.message + "). Your changes are still here.";
    } finally {
      saving = false;
      if (dirtyWhileSaving) { dirtyWhileSaving = false; saveProgress(); }
    }
  }
  autosaveHook = () => {
    saveNote.textContent = "Saving soon…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 1500);
  };

  const downloadBtn = el("button", { type: "button", class: "link-btn" }, "Download");
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
  const signBtn = data.signing && data.signing.state === "ready"
    ? el("a", { class: "btn", href: data.signing.sign_url, style: "display:none;" }, "Review and sign")
    : null;
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
      barUpdate();
    }
  });

  // The bar says where things stand and carries the one button that moves
  // them forward: Finalize and submit, or, once everything is agreed and it
  // is the client's turn to sign, Review and sign. Finalize is disabled with
  // the reason shown, instead of failing with an error after the click.
  const barTitle = el("div", { class: "bar-title" });
  const barSub = el("div", { class: "bar-sub" });
  barUpdate = () => {
    const pending = Object.values(edits).filter((e) => e.counterPending).length;
    const changes = Object.keys(edits).length;
    const readyToSign = !!signBtn && !changes && !pending;
    barSub.innerHTML = "";
    if (readyToSign) {
      barTitle.textContent = "Agreed. Nothing left to submit.";
      barSub.appendChild(document.createTextNode("Review the final document, then sign. "));
    } else if (pending) {
      barTitle.textContent = `${pending} counter${pending === 1 ? "" : "s"} left to decide`;
      barSub.appendChild(document.createTextNode("Accept, reject or suggest an edit on each one, then submit. "));
    } else {
      barTitle.textContent = changes ? `Ready to submit: ${changes} change${changes === 1 ? "" : "s"}` : "Ready to submit";
      barSub.appendChild(document.createTextNode("Nothing is sent until you press the button. "));
    }
    barSub.appendChild(saveNote);
    submitBtn.style.display = readyToSign ? "none" : "";
    if (signBtn) signBtn.style.display = readyToSign ? "" : "none";
    if (!submitBtn.textContent.endsWith("...")) submitBtn.disabled = pending > 0;
  };
  barUpdate();

  shell.appendChild(
    el("div", { class: "redline-bottom-bar" }, [
      el("div", { class: "bar-text" }, [barTitle, barSub]),
      el("div", { class: "bar-actions" }, [downloadBtn, signBtn, submitBtn]),
    ])
  );

  if (data.sender_email) {
    shell.appendChild(
      el("div", { class: "redline-contact" }, ["Questions? Contact the document sender: ", el("a", { href: `mailto:${data.sender_email}` }, data.sender_email)])
    );
  }

  return shell;
}

// One link for the whole deal: once the sender has agreed the final text and
// sent it for signature, the client's own signing step appears right here, so
// they don't have to find a second email. The signing page itself (consent,
// photo, turn order) is the same /sign page the emailed link opens.
function signingBanner(signing) {
  if (!signing) return null;
  let title = null, text = "", action = null;
  if (signing.state === "ready") {
    title = "Ready for your signature";
    text = "The sender has finished this document and is waiting for you to sign it.";
    action = el("a", { class: "btn", href: signing.sign_url }, "Review and sign");
  } else if (signing.state === "waiting_turn") {
    title = "You're up after " + ((signing.waiting_on || []).join(", ") || "another signer");
    text = "This document is signed in order. You'll get an email as soon as it's your turn, and the signing button will appear here too.";
  } else if (signing.state === "signed") {
    title = "You've signed";
    text = signing.waiting_on && signing.waiting_on.length
      ? "Still waiting on " + signing.waiting_on.join(", ") + "."
      : "Thank you.";
  } else if (signing.state === "all_signed") {
    title = "Everyone has signed";
    text = "This document is complete. No further action is needed.";
  } else {
    return null;
  }
  return el("div", { class: "sign-banner-wrap" }, [
    el("div", { class: "sign-banner" }, [
      el("div", { class: "sb-text" }, [el("div", { class: "sb-title" }, title), el("div", { class: "sb-sub" }, text)]),
      action,
    ]),
  ]);
}

function showDocument(data) {
  render(el("div", {}, [topbar(), signingBanner(data.signing), DocumentView(data), JoinCta()]));
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
          .filter((e) => e.decision === "countered" && e.location && ((e.location.segments && e.location.segments.length) || e.location.new_paragraph))
          .map((e) => ({
            field_key: e.field_key, label: e.label, proposed_value: e.counter_value, comment: "", location: e.location,
            original_value: e.original_value, is_counter: true, client_original_value: e.proposed_value,
            source_edit_id: e.id,
          }));
        const fresh = await api(`/api/share/${TOKEN}`);
        if (seeded.length) {
          fresh.draft = fresh.draft || { note: "", edits: [] };
          const existingKeys = new Set(
            fresh.draft.edits.filter((e) => e.location && e.location.segments && !e.location.new_paragraph).map((e) => locKey(e.location))
          );
          // A new paragraph is its own thing wherever it sits, so it never
          // collides with another edit at the same spot.
          seeded.forEach((s) => { if (s.location.new_paragraph || !existingKeys.has(locKey(s.location))) fresh.draft.edits.push(s); });
        }
        showDocument(fresh);
        // The seeded counters above exist only in this tab's memory until
        // a save sends them -- see the comment on hasUnsavedChanges.
        // markDirty() starts the autosave, so reloading right away can't
        // lose them.
        if (seeded.length) markDirty();
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
loadBrand();
