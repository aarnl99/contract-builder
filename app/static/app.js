const state = { user: null, plan: null, documentTypes: ["NDA", "Services Agreement", "Consulting Agreement", "Employment Agreement", "Lease Agreement", "Sales Contract", "Other"] };

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      msg = data.detail || msg;
    } catch (e) {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res;
}

const app = document.getElementById("app");

function render(view) {
  app.innerHTML = "";
  app.appendChild(view);
}

function initials(user) {
  const src = (user.name || user.email || "?").trim();
  const parts = src.split(/\s+/);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function currentTabFromHash() {
  const h = location.hash || "";
  if (h.startsWith("#/masters")) return "masters";
  if (h.startsWith("#/documents")) return "documents";
  if (h.startsWith("#/draft")) return "draft";
  return "draft";
}

function topbar() {
  const activeTab = currentTabFromHash();
  const bar = el("div", { class: "topbar" });

  const left = el("div", { class: "left" }, [
    el("div", { class: "brand", onclick: () => (location.hash = "#/draft") }, [
      el("div", { class: "mark" }, "D"),
      el("div", { class: "word" }, ["Draftly", el("span", { class: "dot" }, ".ai")]),
    ]),
  ]);

  if (state.user) {
    const tabs = el("div", { class: "nav-tabs" }, [
      el("button", { class: activeTab === "draft" ? "active" : "", onclick: () => (location.hash = "#/draft") }, "Draft"),
      el("button", { class: activeTab === "masters" ? "active" : "", onclick: () => (location.hash = "#/masters") }, "Master Documents"),
      el("button", { class: activeTab === "documents" ? "active" : "", onclick: () => (location.hash = "#/documents") }, "Documents"),
    ]);
    left.appendChild(tabs);
  }
  bar.appendChild(left);

  const right = el("div", { class: "right" });

  if (state.user && state.plan) {
    const p = state.plan;
    const pill = el("div", { class: "usage-pill" + (p.limit !== null && p.used >= p.limit ? " at-limit" : "") });
    if (p.limit === null) {
      pill.appendChild(document.createTextNode("Unlimited plan"));
    } else {
      const pct = Math.min(100, Math.round((p.used / Math.max(1, p.limit)) * 100));
      pill.appendChild(el("span", {}, `${p.used} of ${p.limit} drafted`));
      pill.appendChild(el("div", { class: "bar" }, [el("div", { class: "fill", style: `width:${pct}%` })]));
    }
    pill.addEventListener("click", () => toggleAvatarMenu());
    right.appendChild(pill);

    const avatarWrap = el("div", { class: "avatar-menu" });
    const avatar = el("div", { class: "avatar", onclick: () => toggleAvatarMenu() }, initials(state.user));
    avatarWrap.appendChild(avatar);
    right.appendChild(avatarWrap);

    window.__avatarWrap = avatarWrap;
  }
  bar.appendChild(right);
  return bar;
}

function toggleAvatarMenu() {
  const wrap = window.__avatarWrap;
  if (!wrap) return;
  const existing = wrap.querySelector(".avatar-dropdown");
  if (existing) { existing.remove(); return; }

  const dd = el("div", { class: "avatar-dropdown" });
  dd.appendChild(el("div", { class: "email-row" }, state.user.email));

  const planRow = el("div", { class: "plan-row" });
  planRow.appendChild(el("div", { class: "label" }, "Plan"));
  const plans = [
    { key: "starter", label: "Starter", detail: "5 drafts / month" },
    { key: "pro", label: "Pro", detail: "20 drafts / month + integrations" },
    { key: "unlimited", label: "Unlimited", detail: "Unlimited drafts + integrations" },
  ];
  plans.forEach((p) => {
    const opt = el(
      "div",
      { class: "plan-option" + (state.plan && state.plan.plan === p.key ? " current" : "") },
      [el("span", {}, p.label), el("span", { style: "color:var(--muted-soft);font-size:11.5px;" }, p.detail)]
    );
    opt.addEventListener("click", async () => {
      await api("/api/account/plan", { method: "POST", body: { plan: p.key } });
      const meRes = await api("/api/me");
      state.plan = meRes.plan;
      dd.remove();
      router();
    });
    planRow.appendChild(opt);
  });
  dd.appendChild(planRow);

  const logoutRow = el("div", { class: "logout-row" }, [el("button", { onclick: doLogout }, "Log out")]);
  dd.appendChild(logoutRow);

  window.__avatarWrap.appendChild(dd);
  setTimeout(() => {
    document.addEventListener("click", function onDocClick(e) {
      if (!dd.contains(e.target) && e.target !== window.__avatarWrap) {
        dd.remove();
        document.removeEventListener("click", onDocClick);
      }
    });
  }, 0);
}

async function doLogout() {
  await api("/api/logout", { method: "POST" });
  state.user = null;
  state.plan = null;
  location.hash = "#/login";
}

function shell(mainContent) {
  return el("div", {}, [topbar(), el("div", { class: "main" }, mainContent)]);
}

function refreshTopbarInPlace() {
  const oldBar = document.querySelector(".topbar");
  if (!oldBar) return;
  api("/api/me").then((me) => {
    state.plan = me.plan;
    const newBar = topbar();
    oldBar.replaceWith(newBar);
  });
}

// ---------------------------------------------------------------------------
// Auth view
// ---------------------------------------------------------------------------

function AuthView(mode) {
  let tab = mode || "login";
  const wrap = el("div", { class: "auth-shell" });
  const card = el("div", { class: "card" });
  wrap.appendChild(card);

  function draw() {
    card.innerHTML = "";
    card.appendChild(
      el("div", { class: "auth-logo" }, [el("div", { class: "mark" }, "D"), el("div", { class: "word" }, "Draftly.ai")])
    );
    const errorBox = el("div");
    const tabs = el("div", { class: "auth-tabs", style: "justify-content:center;" }, [
      el("button", { class: tab === "login" ? "active" : "", onclick: () => { tab = "login"; draw(); } }, "Log in"),
      el("button", { class: tab === "register" ? "active" : "", onclick: () => { tab = "register"; draw(); } }, "Create account"),
    ]);

    const emailInput = el("input", { type: "email", placeholder: "you@example.com" });
    const passInput = el("input", { type: "password", placeholder: "At least 8 characters" });
    const nameInput = el("input", { type: "text", placeholder: "Full name (optional)" });

    const fields = [el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Email"), emailInput])];
    if (tab === "register") {
      fields.push(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Name"), nameInput]));
    }
    fields.push(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Password"), passInput]));

    const submitBtn = el("button", { class: "btn block" }, tab === "login" ? "Log in" : "Create account");
    submitBtn.addEventListener("click", async () => {
      errorBox.innerHTML = "";
      try {
        const body = { email: emailInput.value, password: passInput.value };
        if (tab === "register") body.name = nameInput.value;
        const user = await api(tab === "login" ? "/api/login" : "/api/register", { method: "POST", body });
        state.user = user;
        const meRes = await api("/api/me");
        state.plan = meRes.plan;
        location.hash = "#/draft";
      } catch (e) {
        errorBox.appendChild(el("div", { class: "error-box" }, e.message));
      }
    });

    card.appendChild(el("h1", {}, tab === "login" ? "Welcome back" : "Create your account"));
    card.appendChild(el("p", { class: "subtitle" }, "Upload a contract, mark the parts that change, and draft finished copies in seconds."));
    card.appendChild(tabs);
    card.appendChild(errorBox);
    fields.forEach((f) => card.appendChild(f));
    card.appendChild(submitBtn);
  }
  draw();
  return wrap;
}

// ---------------------------------------------------------------------------
// Shared: document preview overlay
// ---------------------------------------------------------------------------

function showPreviewOverlay({ title, subtitle, html, generatedId, extraButtons }) {
  const overlay = el("div", { class: "modal-overlay" });
  const box = el("div", { class: "modal", style: "width:720px;" });

  const headerRow = el("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;" }, [
    el("div", {}, [el("h2", {}, title), subtitle ? el("p", { class: "subtitle", style: "margin:2px 0 0;" }, subtitle) : null]),
    el("button", { class: "btn ghost small", onclick: () => overlay.remove() }, "Close"),
  ]);
  box.appendChild(headerRow);

  const preview = el("div", { class: "contract-view compact", style: "max-height:52vh;overflow-y:auto;" });
  preview.innerHTML = html || "<p style='color:var(--muted);'>No preview available.</p>";
  box.appendChild(preview);

  const actions = el("div", { class: "panel-actions" });
  if (generatedId) {
    actions.appendChild(el("a", { class: "btn", href: `/api/generated/${generatedId}/download` }, "Download .docx"));
  }
  if (extraButtons) extraButtons.forEach((b) => actions.appendChild(b));
  actions.appendChild(el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Close"));
  box.appendChild(actions);

  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return overlay;
}

// ---------------------------------------------------------------------------
// Shared: fill-in-the-blanks modal used by the Draft flow
// ---------------------------------------------------------------------------

function openFillModal(tpl, prefill, onDone) {
  const overlay = el("div", { class: "modal-overlay" });
  const errBox = el("div");
  const inputs = {};

  const fieldRows = tpl.placeholders.map((p) => {
    let input;
    const prefillVal = (prefill && prefill[p.field_key]) || "";
    if (p.field_type === "multiline") input = el("textarea", {}, prefillVal);
    else if (p.field_type === "date") input = el("input", { type: "date", value: prefillVal });
    else if (p.field_type === "number") input = el("input", { type: "number", value: prefillVal });
    else input = el("input", { type: "text", value: prefillVal });
    inputs[p.field_key] = input;
    return el("div", { class: "form-row" }, [
      el("label", { class: "field-label" }, [p.label, p.required ? el("span", { class: "req" }, " *") : null]),
      input,
    ]);
  });

  const modal = el("div", { class: "modal" }, [
    el("h2", {}, tpl.name),
    el("p", { class: "subtitle", style: "margin:2px 0 16px;" }, `${tpl.document_type} · fill in the blanks below`),
    errBox,
    ...fieldRows,
    el("div", { class: "modal-actions" }, [
      el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"),
      el("button", { class: "btn", onclick: submit }, "Generate"),
    ]),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  async function submit() {
    errBox.innerHTML = "";
    const values = {};
    Object.entries(inputs).forEach(([k, i]) => (values[k] = i.value));
    try {
      const res = await api(`/api/templates/${tpl.id}/generate`, { method: "POST", body: { values } });
      state.plan = res.plan;
      overlay.remove();
      onDone(res, values);
    } catch (e) {
      errBox.appendChild(el("div", { class: "error-box" }, e.message));
    }
  }
}

// ---------------------------------------------------------------------------
// Draft view
// ---------------------------------------------------------------------------

function DraftView(preselectId) {
  const wrap = el("div", {});
  wrap.appendChild(el("h1", {}, "Draft a document"));
  wrap.appendChild(el("p", { class: "subtitle" }, "Pick a master document below, fill in the blanks, and get a finished .docx."));

  const body = el("div");
  wrap.appendChild(body);

  api("/api/templates").then((templates) => {
    const ready = templates.filter((t) => t.status === "ready");
    body.innerHTML = "";
    if (!ready.length) {
      body.appendChild(
        el("div", { class: "empty-state card" }, [
          el("div", { class: "big" }, "No master documents ready yet"),
          el("div", {}, "Upload a contract and mark its placeholders first."),
          el("div", { style: "margin-top:14px;" }, [
            el("button", { class: "btn", onclick: () => (location.hash = "#/masters") }, "Go to Master Documents"),
          ]),
        ])
      );
      return;
    }
    const grid = el("div", { class: "grid" });
    ready.forEach((t) => {
      const card = el("div", { class: "doc-card" }, [
        el("div", { class: "top-row" }, [el("div", { class: "icon" }, "☰"), el("div", { class: "type-tag" }, t.document_type)]),
        el("div", { class: "name" }, t.name),
        el("div", { class: "meta" }, `${t.placeholder_count} field${t.placeholder_count === 1 ? "" : "s"} · ${t.generated_count} drafted so far`),
        el("div", { class: "actions" }, [el("button", { class: "btn small block", onclick: () => startDraft(t.id) }, "Use this template")]),
      ]);
      grid.appendChild(card);
    });
    body.appendChild(grid);

    if (preselectId && ready.some((t) => t.id === preselectId)) {
      startDraft(preselectId);
    }
  });

  function startDraft(templateId) {
    api(`/api/templates/${templateId}`).then((tpl) => {
      openFillModal(tpl, null, (result) => {
        showResult(tpl, result, {});
      });
    });
  }

  function showResult(tpl, result, lastValues) {
    const editBtn = el("button", { class: "btn secondary" }, "Edit values");
    editBtn.addEventListener("click", () => {
      overlay.remove();
      api(`/api/templates/${tpl.id}`).then((freshTpl) => {
        openFillModal(freshTpl, lastValues, (res2, values2) => showResult(freshTpl, res2, values2));
      });
    });
    const libBtn = el("button", { class: "btn secondary", onclick: () => { overlay.remove(); location.hash = "#/documents"; } }, "View in Documents");
    var overlay = showPreviewOverlay({
      title: result.name,
      subtitle: `Generated from ${tpl.name} · saved to your Documents library`,
      html: result.html,
      generatedId: result.generated_id,
      extraButtons: [editBtn, libBtn],
    });
    refreshTopbarInPlace();
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Master Documents view
// ---------------------------------------------------------------------------

function MastersView() {
  const wrap = el("div", {});
  wrap.appendChild(el("h1", {}, "Master documents"));
  wrap.appendChild(el("p", { class: "subtitle" }, "Your reusable templates. Upload a contract once, mark what changes, and draft from it any time."));

  const uploadCard = el("div", { class: "card" });
  const nameInput = el("input", { type: "text", placeholder: "e.g. Freelance Services Agreement" });
  const typeSelect = el("select", {}, state.documentTypes.map((t) => el("option", { value: t }, t)));
  const customTypeInput = el("input", { type: "text", placeholder: "Type a custom document type", style: "display:none;margin-top:8px;" });
  typeSelect.appendChild(el("option", { value: "__custom__" }, "Custom..."));
  typeSelect.addEventListener("change", () => {
    customTypeInput.style.display = typeSelect.value === "__custom__" ? "block" : "none";
  });
  const fileInput = el("input", { type: "file", accept: ".docx" });
  const uploadErr = el("div");
  const uploadBtn = el("button", { class: "btn" }, "Upload master document");
  uploadBtn.addEventListener("click", async () => {
    uploadErr.innerHTML = "";
    if (!fileInput.files[0]) { uploadErr.appendChild(el("div", { class: "error-box" }, "Choose a .docx file first.")); return; }
    const docType = typeSelect.value === "__custom__" ? customTypeInput.value.trim() || "Other" : typeSelect.value;
    const fd = new FormData();
    fd.append("name", nameInput.value || fileInput.files[0].name);
    fd.append("document_type", docType);
    fd.append("file", fileInput.files[0]);
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading...";
    try {
      const res = await fetch("/api/templates", { method: "POST", body: fd, credentials: "same-origin" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Upload failed");
      }
      const tpl = await res.json();
      location.hash = `#/editor/${tpl.id}`;
    } catch (e) {
      uploadErr.appendChild(el("div", { class: "error-box" }, e.message));
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = "Upload master document";
    }
  });
  uploadCard.appendChild(el("h2", {}, "Upload a new master document"));
  uploadCard.appendChild(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Document name"), nameInput]));
  uploadCard.appendChild(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Document type"), typeSelect, customTypeInput]));
  uploadCard.appendChild(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Word document (.docx)"), fileInput]));
  uploadCard.appendChild(uploadErr);
  uploadCard.appendChild(el("div", { style: "margin-top:6px;" }, uploadBtn));
  wrap.appendChild(uploadCard);

  const listWrap = el("div", { class: "grid" });
  wrap.appendChild(el("h2", { style: "margin-top:26px;margin-bottom:12px;" }, "Your master documents"));
  wrap.appendChild(listWrap);

  function load() {
    api("/api/templates").then((templates) => {
      listWrap.innerHTML = "";
      if (!templates.length) {
        listWrap.appendChild(el("div", { class: "empty-state" }, "No master documents yet. Upload one above to get started."));
        return;
      }
      templates.forEach((t) => {
        const actions = [el("button", { class: "btn secondary small", onclick: () => (location.hash = `#/editor/${t.id}`) }, t.status === "ready" ? "Edit fields" : "Mark fields")];
        if (t.status === "ready") {
          actions.push(el("button", { class: "btn small", onclick: () => (location.hash = `#/draft/${t.id}`) }, "Draft"));
        }
        actions.push(el("button", { class: "btn danger small", onclick: () => deleteTemplate(t.id) }, "Delete"));

        listWrap.appendChild(
          el("div", { class: "doc-card" }, [
            el("div", { class: "top-row" }, [
              el("div", { class: "icon" }, "☰"),
              el("div", { class: "badge " + (t.status === "ready" ? "ready" : "draft") }, t.status === "ready" ? "Ready" : "Draft"),
            ]),
            el("div", { class: "type-tag" }, t.document_type),
            el("div", { class: "name" }, t.name),
            el("div", { class: "meta" }, `${t.placeholder_count} field${t.placeholder_count === 1 ? "" : "s"} · ${t.generated_count} drafted · uploaded ${new Date(t.created_at).toLocaleDateString()}`),
            el("div", { class: "actions" }, actions),
          ])
        );
      });
    });
  }
  load();

  async function deleteTemplate(id) {
    if (!confirm("Delete this master document? Fields and any editing progress will be lost. Documents already drafted from it are kept in your library.")) return;
    await api(`/api/templates/${id}`, { method: "DELETE" });
    load();
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Documents (generated library) view
// ---------------------------------------------------------------------------

function DocumentsView() {
  const wrap = el("div", {});
  wrap.appendChild(el("h1", {}, "Documents"));
  wrap.appendChild(el("p", { class: "subtitle" }, "Every contract you have drafted, grouped by document type and traceable back to its master document."));

  let showArchived = false;

  const toolbar = el("div", { class: "toolbar-row" });
  const tabsRow = el("div", { class: "tabs", style: "border-bottom:none;margin-bottom:0;" }, [
    el("button", { class: "active", "data-k": "active" }, "Active"),
    el("button", { "data-k": "archived" }, "Archived"),
  ]);
  Array.from(tabsRow.children).forEach((btn) => {
    btn.addEventListener("click", () => {
      showArchived = btn.dataset.k === "archived";
      Array.from(tabsRow.children).forEach((b) => b.classList.toggle("active", b === btn));
      load();
    });
  });
  toolbar.appendChild(tabsRow);
  wrap.appendChild(toolbar);

  const listWrap = el("div", {});
  wrap.appendChild(listWrap);

  function load() {
    api(`/api/generated?archived=${showArchived}`).then((docs) => {
      listWrap.innerHTML = "";
      if (!docs.length) {
        listWrap.appendChild(
          el("div", { class: "empty-state card" }, [
            el("div", { class: "big" }, showArchived ? "No archived documents" : "No documents drafted yet"),
            el("div", {}, showArchived ? "Documents you archive will show up here." : "Head to the Draft tab to generate your first one."),
          ])
        );
        return;
      }
      const groups = {};
      docs.forEach((d) => {
        (groups[d.document_type] = groups[d.document_type] || []).push(d);
      });
      Object.keys(groups).sort().forEach((type) => {
        const groupEl = el("div", { class: "type-group" });
        groupEl.appendChild(
          el("div", { class: "type-group-header" }, [
            el("div", { class: "t" }, `${type} (${groups[type].length})`),
            el("div", { class: "line" }),
          ])
        );
        const list = el("div", { class: "output-list" });
        groups[type].forEach((d) => {
          const row = el("div", { class: "output-row" + (d.archived ? " archived" : "") }, [
            el("div", { class: "left" }, [
              el("div", { class: "file-icon" }, "✓"),
              el("div", {}, [
                el("div", { class: "name" }, d.name),
                el("div", { class: "lineage" }, ["Originated from ", el("span", { class: "tag" }, d.template_name)]),
              ]),
            ]),
            el("div", { class: "right" }, [
              el("div", { class: "date" }, new Date(d.created_at).toLocaleDateString()),
              el("button", {
                class: "btn secondary small",
                onclick: (e) => { e.stopPropagation(); toggleArchive(d); },
              }, d.archived ? "Unarchive" : "Archive"),
              el("button", {
                class: "btn danger small",
                onclick: (e) => { e.stopPropagation(); deleteForever(d); },
              }, "Delete"),
            ]),
          ]);
          row.addEventListener("click", () => openDetail(d));
          list.appendChild(row);
        });
        groupEl.appendChild(list);
        listWrap.appendChild(groupEl);
      });
    });
  }
  load();

  async function toggleArchive(d) {
    await api(`/api/generated/${d.id}/archive`, { method: "POST", body: { archived: !d.archived } });
    load();
  }

  async function deleteForever(d) {
    if (!confirm(`Permanently delete "${d.name}"? This cannot be undone.`)) return;
    await api(`/api/generated/${d.id}`, { method: "DELETE" });
    load();
  }

  function openDetail(d) {
    api(`/api/generated/${d.id}`).then((full) => {
      const valuesHtml = full.values.map((v) => `<div class="field-row"><div class="k">${v.label}</div><div class="v">${v.value || "—"}</div></div>`).join("");
      const lineageLink = el("a", { onclick: () => { document.querySelectorAll(".panel-overlay").forEach((o) => o.remove()); location.hash = "#/masters"; } }, full.template_name);
      const panelOverlay = el("div", { class: "panel-overlay" });
      const panel = el("div", { class: "slide-panel" }, [
        el("button", { class: "close", onclick: () => panelOverlay.remove() }, "✕"),
        el("h2", {}, full.name),
        el("div", { class: "sub" }, `Drafted ${new Date(full.created_at).toLocaleString()}`),
        el("div", { class: "lineage-box" }, [
          el("div", { class: "icon" }, "📄"),
          el("div", { class: "txt" }, ["Originated from master document", el("br"), lineageLink]),
        ]),
        el("div", {}, valuesHtml ? el("div", { html: valuesHtml }) : el("div", { style: "color:var(--muted);font-size:13px;" }, "No field values recorded.")),
        el("div", { class: "panel-actions" }, [
          el("a", { class: "btn", href: `/api/generated/${d.id}/download` }, "Download .docx"),
          el("button", { class: "btn secondary", onclick: () => { panelOverlay.remove(); showPreviewOverlay({ title: full.name, subtitle: full.document_type, html: full.html, generatedId: full.id }); } }, "Preview document"),
        ]),
      ]);
      panelOverlay.appendChild(panel);
      panelOverlay.addEventListener("click", (e) => { if (e.target === panelOverlay) panelOverlay.remove(); });
      document.body.appendChild(panelOverlay);
    });
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Editor (click-to-mark placeholders) -- unchanged mechanics, restyled
// ---------------------------------------------------------------------------

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

function EditorView(templateId) {
  const wrap = el("div", {});
  const header = el("div", {}, [el("a", { class: "link", onclick: () => (location.hash = "#/masters") }, "← Back to Master Documents")]);
  wrap.appendChild(header);
  wrap.appendChild(el("h1", { style: "margin-top:12px;" }, "Mark placeholders"));
  wrap.appendChild(el("p", { class: "subtitle" }, "Select any text in the contract below, then click “Mark as placeholder” to turn it into a fillable field."));

  const layout = el("div", { class: "editor-layout" });
  const contractPanel = el("div", { class: "contract-panel" });
  const contractView = el("div", { class: "contract-view" });
  contractPanel.appendChild(contractView);
  const toolbar = el("div", { class: "mark-toolbar" }, [el("button", {}, "Mark as placeholder")]);
  document.body.appendChild(toolbar);

  const sidebar = el("div", { class: "sidebar" });
  const sidebarCard = el("div", { class: "card" });
  sidebarCard.appendChild(el("h2", {}, "Placeholders"));
  const phList = el("div", { class: "placeholder-list" });
  sidebarCard.appendChild(phList);
  sidebar.appendChild(sidebarCard);

  const actionsCard = el("div", { class: "card" });
  const resetBtn = el("button", { class: "btn secondary small" }, "Start over (remove all marks)");
  resetBtn.addEventListener("click", async () => {
    if (!confirm("This removes all placeholders and restores the original document text. Continue?")) return;
    const data = await api(`/api/templates/${templateId}/reset`, { method: "POST" });
    contractView.innerHTML = data.html;
    loadPlaceholders();
  });
  const genBtn = el("button", { class: "btn block", style: "margin-bottom:8px;" }, "Draft from this document →");
  genBtn.addEventListener("click", () => (location.hash = `#/draft/${templateId}`));
  actionsCard.appendChild(genBtn);
  actionsCard.appendChild(resetBtn);
  sidebar.appendChild(actionsCard);

  layout.appendChild(contractPanel);
  layout.appendChild(sidebar);
  wrap.appendChild(layout);

  let currentSelection = null;

  function hideToolbar() {
    toolbar.style.display = "none";
    currentSelection = null;
  }

  contractView.addEventListener("mouseup", () => {
    setTimeout(() => {
      const info = computeSelectionSegments(contractView);
      if (!info) { hideToolbar(); return; }
      if (info.error === "cross-paragraph") {
        hideToolbar();
        alert("Please select text within a single paragraph.");
        return;
      }
      currentSelection = info;
      const sel = window.getSelection();
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      toolbar.style.left = Math.max(8, rect.left) + "px";
      toolbar.style.top = Math.max(8, rect.top - 44) + "px";
      toolbar.style.display = "block";
    }, 0);
  });

  document.addEventListener("mousedown", (e) => {
    if (e.target === toolbar || toolbar.contains(e.target)) return;
    if (!contractView.contains(e.target)) hideToolbar();
  });

  toolbar.querySelector("button").addEventListener("click", () => {
    if (!currentSelection) return;
    openMarkModal(currentSelection);
  });

  function openMarkModal(selectionInfo) {
    const overlay = el("div", { class: "modal-overlay" });
    const labelInput = el("input", { type: "text", placeholder: 'e.g. "Client Name"' });
    const typeSelect = el("select", {}, [
      el("option", { value: "text" }, "Short text"),
      el("option", { value: "multiline" }, "Long text / paragraph"),
      el("option", { value: "date" }, "Date"),
      el("option", { value: "number" }, "Number"),
    ]);
    const requiredCheck = el("input", { type: "checkbox", checked: "checked" });
    const errBox = el("div");

    const modal = el("div", { class: "modal" }, [
      el("h2", {}, "New placeholder"),
      el("div", { class: "selected-preview" }, `"${selectionInfo.text}"`),
      errBox,
      el("label", { class: "field-label" }, "Field label (shown on the fill-in form)"),
      labelInput,
      el("label", { class: "field-label" }, "Field type"),
      typeSelect,
      el("label", { class: "field-label", style: "display:flex;align-items:center;gap:6px;" }, [requiredCheck, "Required"]),
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"),
        el("button", { class: "btn", onclick: submit }, "Create placeholder"),
      ]),
    ]);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    labelInput.focus();

    async function submit() {
      errBox.innerHTML = "";
      const label = labelInput.value.trim();
      if (!label) { errBox.appendChild(el("div", { class: "error-box" }, "Please enter a label.")); return; }
      try {
        const res = await api(`/api/templates/${templateId}/mark`, {
          method: "POST",
          body: {
            paragraph_index: selectionInfo.paragraph_index,
            table_path: selectionInfo.table_path || "",
            segments: selectionInfo.segments,
            label,
            field_type: typeSelect.value,
            required: requiredCheck.checked,
          },
        });
        contractView.innerHTML = res.html;
        overlay.remove();
        hideToolbar();
        loadPlaceholders();
      } catch (e) {
        errBox.appendChild(el("div", { class: "error-box" }, e.message));
      }
    }
  }

  function loadPlaceholders() {
    api(`/api/templates/${templateId}`).then((tpl) => {
      phList.innerHTML = "";
      genBtn.disabled = tpl.placeholders.length === 0;
      if (!tpl.placeholders.length) {
        phList.appendChild(el("div", { style: "color:var(--muted);font-size:13px;" }, "None yet. Select text in the contract to add one."));
        return;
      }
      tpl.placeholders.forEach((p) => {
        phList.appendChild(
          el("div", { class: "placeholder-chip" }, [
            el("div", {}, [el("div", { class: "k" }, p.label), el("div", { class: "t" }, `{{${p.field_key}}} · ${p.field_type}${p.required ? " · required" : ""}`)]),
            el("button", { onclick: () => deletePlaceholder(p.id) }, "Remove"),
          ])
        );
      });
    });
  }

  async function deletePlaceholder(id) {
    const data = await api(`/api/templates/${templateId}/placeholders/${id}`, { method: "DELETE" });
    contractView.innerHTML = data.html;
    loadPlaceholders();
  }

  api(`/api/templates/${templateId}/html`).then((data) => { contractView.innerHTML = data.html; });
  loadPlaceholders();

  return wrap;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

let _typesLoaded = false;
async function ensureDocumentTypes() {
  if (_typesLoaded) return;
  try {
    const res = await api("/api/document-types");
    state.documentTypes = res.types;
    _typesLoaded = true;
  } catch (e) {}
}

async function router() {
  document.querySelectorAll(".modal-overlay, .panel-overlay").forEach((o) => o.remove());
  const hash = location.hash || "#/draft";
  const [meRes] = await Promise.all([api("/api/me"), ensureDocumentTypes()]);
  state.user = meRes.user;
  state.plan = meRes.plan;

  if (!state.user && !hash.startsWith("#/login") && !hash.startsWith("#/register")) {
    render(shell(AuthView("login")));
    return;
  }
  if (state.user && (hash.startsWith("#/login") || hash.startsWith("#/register") || hash === "#/" || hash === "")) {
    location.hash = "#/draft";
    return;
  }

  if (hash.startsWith("#/login")) return render(shell(AuthView("login")));
  if (hash.startsWith("#/register")) return render(shell(AuthView("register")));
  if (hash.startsWith("#/masters")) return render(shell(MastersView()));
  if (hash.startsWith("#/documents")) return render(shell(DocumentsView()));

  const draftMatch = hash.match(/^#\/draft\/(\d+)/);
  if (draftMatch) return render(shell(DraftView(parseInt(draftMatch[1], 10))));
  if (hash.startsWith("#/draft")) return render(shell(DraftView()));

  const editorMatch = hash.match(/^#\/editor\/(\d+)/);
  if (editorMatch) return render(shell(EditorView(parseInt(editorMatch[1], 10))));

  location.hash = "#/draft";
}

window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", router);
