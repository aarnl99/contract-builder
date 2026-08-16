const state = { user: null, plan: null, isAdmin: false, documentTypes: ["NDA", "Services Agreement", "Consulting Agreement", "Employment Agreement", "Lease Agreement", "Sales Contract", "Other"] };

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
    let code = null;
    try {
      const data = await res.json();
      // detail is usually a plain string, but some endpoints (e.g. login
      // blocked on an unverified email) send a structured
      // {code, message} object so the caller can react to *which* error
      // this is, not just display text.
      if (data && typeof data.detail === "object" && data.detail !== null) {
        msg = data.detail.message || msg;
        code = data.detail.code || null;
      } else {
        msg = data.detail || msg;
      }
    } catch (e) {}
    const err = new Error(msg);
    if (code) err.code = code;
    throw err;
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
  if (h.startsWith("#/admin")) return "admin";
  if (h.startsWith("#/draft")) return "draft";
  return "draft";
}

function topbar() {
  const activeTab = currentTabFromHash();
  const bar = el("div", { class: "topbar" });

  const left = el("div", { class: "left" }, [
    el("div", { class: "brand", onclick: () => (location.hash = "#/draft") }, [
      el("div", { class: "word" }, ["Rotely", el("span", { class: "dot" }, ".ai")]),
    ]),
  ]);

  if (state.user) {
    const tabButtons = [
      el("button", { class: activeTab === "draft" ? "active" : "", onclick: () => (location.hash = "#/draft") }, "Draft"),
      el("button", { class: activeTab === "masters" ? "active" : "", onclick: () => (location.hash = "#/masters") }, "Master Documents"),
      el("button", { class: activeTab === "documents" ? "active" : "", onclick: () => (location.hash = "#/documents") }, "Documents"),
    ];
    if (state.isAdmin) {
      tabButtons.push(el("button", { class: activeTab === "admin" ? "active" : "", onclick: () => (location.hash = "#/admin") }, "Admin"));
    }
    const tabs = el("div", { class: "nav-tabs" }, tabButtons);
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

  const emailRow = el("div", { class: "plan-row" });
  emailRow.appendChild(el("div", { class: "label" }, "Drafting email"));
  const emailValueRow = el("div", { style: "display:block;" }, [
    el("span", { style: "font-size:11.5px;color:var(--muted);" }, "Loading..."),
  ]);
  emailRow.appendChild(emailValueRow);
  const emailHint = el("div", { style: "font-size:11px;color:var(--muted-soft);margin-top:6px;line-height:1.4;" }, "Forward or send a drafting request to this address to have it show up in your Documents library automatically.");
  emailRow.appendChild(emailHint);
  dd.appendChild(emailRow);

  function paintAliasRow(address) {
    emailValueRow.innerHTML = "";
    emailValueRow.appendChild(
      el("div", { style: "font-family:monospace;font-size:11px;word-break:break-all;line-height:1.5;" }, address)
    );
    const btnRow = el("div", { style: "display:flex;gap:6px;margin-top:6px;" });
    btnRow.appendChild(el("button", { class: "btn secondary small", onclick: () => navigator.clipboard.writeText(address) }, "Copy"));
    btnRow.appendChild(
      el("button", {
        class: "btn ghost small",
        onclick: async () => {
          if (!confirm("This invalidates the current address, anything sent to it afterward won't reach you. Continue?")) return;
          const res = await api("/api/account/email-alias/regenerate", { method: "POST" });
          paintAliasRow(res.address);
        },
      }, "Regenerate")
    );
    emailValueRow.appendChild(btnRow);
  }
  api("/api/account/email-alias").then((res) => paintAliasRow(res.address));

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
    state.isAdmin = !!me.is_admin;
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

  // If we just landed here from the verify-email link (a real, non-hash
  // redirect from main.py's /verify-email/{token}), surface a banner once
  // and strip the query off the hash so it doesn't linger through reloads.
  const hashQuery = new URLSearchParams(location.hash.split("?")[1] || "");
  const justVerified = hashQuery.get("verified") === "1";
  const verifyError = hashQuery.get("verify_error") === "1";
  if (justVerified || verifyError) {
    history.replaceState(null, "", location.pathname + "#/login");
  }

  let registeredEmail = null; // set right after a successful register -- swaps the card to "check your email"

  function draw() {
    card.innerHTML = "";
    card.appendChild(
      el("div", { class: "auth-logo" }, [el("div", { class: "word" }, "Rotely.ai")])
    );

    if (registeredEmail) {
      const resendNote = el("div", { style: "font-size:12.5px;color:var(--muted);margin-top:10px;" }, "");
      const resendBtn = el("button", { class: "btn secondary block", style: "margin-top:12px;" }, "Resend email");
      resendBtn.addEventListener("click", async () => {
        resendBtn.disabled = true;
        try {
          await api("/api/resend-verification", { method: "POST", body: { email: registeredEmail } });
          resendNote.textContent = "Sent — check your inbox (and spam folder).";
        } catch (e) {
          resendNote.textContent = e.message;
        } finally {
          resendBtn.disabled = false;
        }
      });
      const backBtn = el(
        "button",
        { class: "btn ghost block", style: "margin-top:8px;", onclick: () => { registeredEmail = null; tab = "login"; draw(); } },
        "Back to log in"
      );
      card.appendChild(el("h1", {}, "Check your email"));
      card.appendChild(
        el("p", { class: "subtitle" }, [
          "We sent a confirmation link to ",
          el("strong", {}, registeredEmail),
          ". Click it to activate your account, then log in below.",
        ])
      );
      card.appendChild(resendBtn);
      card.appendChild(resendNote);
      card.appendChild(backBtn);
      return;
    }

    const errorBox = el("div");
    if (tab === "login" && justVerified) {
      errorBox.appendChild(el("div", { class: "notice-box" }, "Email verified — you can log in now."));
    } else if (tab === "login" && verifyError) {
      errorBox.appendChild(el("div", { class: "error-box" }, "That verification link is invalid or expired. Request a new one below."));
    }

    const tabs = el("div", { class: "auth-tabs", style: "justify-content:center;" }, [
      el("button", { class: tab === "login" ? "active" : "", onclick: () => { tab = "login"; draw(); } }, "Log in"),
      el("button", { class: tab === "register" ? "active" : "", onclick: () => { tab = "register"; draw(); } }, "Create account"),
    ]);

    const emailInput = el("input", { type: "email", placeholder: "you@example.com" });
    const passInput = el("input", { type: "password", placeholder: tab === "register" ? "At least 8 characters" : "Password" });
    const nameInput = el("input", { type: "text", placeholder: "Full name" });
    const confirmInput = el("input", { type: "password", placeholder: "Re-enter your password" });

    const fields = [el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Email"), emailInput])];
    if (tab === "register") {
      fields.push(
        el("div", { class: "form-row" }, [el("label", { class: "field-label" }, ["Full name", el("span", { class: "req" }, " *")]), nameInput])
      );
    }
    fields.push(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Password"), passInput]));
    if (tab === "register") {
      fields.push(
        el("div", { style: "font-size:12px;color:var(--muted);margin:-8px 0 2px;" }, "At least 8 characters, with an uppercase letter, a lowercase letter, and a number.")
      );
      fields.push(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Confirm password"), confirmInput]));
    }

    const submitBtn = el("button", { class: "btn block" }, tab === "login" ? "Log in" : "Create account");
    submitBtn.addEventListener("click", async () => {
      errorBox.innerHTML = "";
      if (tab === "register") {
        if (!nameInput.value.trim()) {
          errorBox.appendChild(el("div", { class: "error-box" }, "Please enter your full name."));
          return;
        }
        if (passInput.value !== confirmInput.value) {
          errorBox.appendChild(el("div", { class: "error-box" }, "Passwords don't match."));
          return;
        }
      }
      try {
        if (tab === "register") {
          const res = await api("/api/register", { method: "POST", body: { email: emailInput.value, password: passInput.value, name: nameInput.value } });
          registeredEmail = res.email;
          draw();
          return;
        }
        const user = await api("/api/login", { method: "POST", body: { email: emailInput.value, password: passInput.value } });
        state.user = user;
        const meRes = await api("/api/me");
        state.plan = meRes.plan;
        state.isAdmin = !!meRes.is_admin;
        location.hash = "#/draft";
      } catch (e) {
        errorBox.innerHTML = "";
        errorBox.appendChild(el("div", { class: "error-box" }, e.message));
        if (e.code === "email_not_verified") {
          const resendBtn = el("button", { class: "btn secondary small", style: "margin-top:8px;" }, "Resend verification email");
          resendBtn.addEventListener("click", async () => {
            resendBtn.disabled = true;
            resendBtn.textContent = "Sending...";
            try {
              await api("/api/resend-verification", { method: "POST", body: { email: emailInput.value } });
              resendBtn.textContent = "Sent — check your inbox";
            } catch (e2) {
              resendBtn.disabled = false;
              resendBtn.textContent = "Resend verification email";
            }
          });
          errorBox.appendChild(resendBtn);
        }
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
// Shared: share-for-review and redline-review modals
// ---------------------------------------------------------------------------

async function openShareModal(generatedId) {
  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", {}, el("p", { class: "subtitle" }, "Loading..."));
  const modal = el("div", { class: "modal" }, [el("h2", {}, "Share for review"), body]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  try {
    const share = await api(`/api/generated/${generatedId}/share`, { method: "POST" });
    const linkUrl = `${location.origin}${share.url}`;
    body.innerHTML = "";
    body.appendChild(el("p", { class: "subtitle" }, "Send the link and the access code to your client separately, a text or a call works well, the same way you'd share anything sensitive."));
    body.appendChild(
      el("div", { class: "share-info-box" }, [
        el("div", { class: "row" }, [
          el("div", { style: "min-width:0;" }, [el("div", { class: "k" }, "Review link"), el("div", { class: "v" }, linkUrl)]),
          el("button", { class: "btn secondary small copy-btn", onclick: () => navigator.clipboard.writeText(linkUrl) }, "Copy"),
        ]),
        el("div", { class: "row" }, [
          el("div", {}, [el("div", { class: "k" }, "Access code"), el("div", { class: "v" }, share.access_code)]),
          el("button", { class: "btn secondary small copy-btn", onclick: () => navigator.clipboard.writeText(share.access_code) }, "Copy"),
        ]),
      ])
    );
    const emailInput = el("input", { type: "email", placeholder: "client@company.com", value: share.client_email || "" });
    const emailSavedNote = el("span", { style: "font-size:12px;color:var(--success);margin-left:8px;display:none;" }, "Saved");
    const senderInput = el("input", { type: "email", placeholder: "you@company.com (defaults to your login email)", value: share.sender_email || "" });
    const senderSavedNote = el("span", { style: "font-size:12px;color:var(--success);margin-left:8px;display:none;" }, "Saved");
    async function saveShareFields() {
      await api(`/api/generated/${generatedId}/share`, {
        method: "POST",
        body: { client_email: emailInput.value.trim(), sender_email: senderInput.value.trim() },
      });
    }
    emailInput.addEventListener("change", async () => {
      await saveShareFields();
      emailSavedNote.style.display = "inline";
      setTimeout(() => (emailSavedNote.style.display = "none"), 1500);
    });
    senderInput.addEventListener("change", async () => {
      await saveShareFields();
      senderSavedNote.style.display = "inline";
      setTimeout(() => (senderSavedNote.style.display = "none"), 1500);
    });
    body.appendChild(
      el("div", { class: "form-row", style: "margin-top:14px;" }, [
        el("label", { class: "field-label" }, ["Your email (shown to the client)", senderSavedNote]),
        senderInput,
        el("div", { style: "font-size:12px;color:var(--muted);margin-top:4px;" }, "Shown to them as the document sender's contact. Leave blank to use your account login email."),
      ])
    );
    body.appendChild(
      el("div", { class: "form-row", style: "margin-top:14px;" }, [
        el("label", { class: "field-label" }, ["Client email (optional)", emailSavedNote]),
        emailInput,
        el("div", { style: "font-size:12px;color:var(--muted);margin-top:4px;" }, "Shown to them on the review page as “Editing as”. Doesn't gate access — the access code still does that."),
      ])
    );
    body.appendChild(
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Close"),
      ])
    );
  } catch (e) {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "error-box" }, e.message));
  }
}

async function openRedlinesModal(generatedId) {
  const overlay = el("div", { class: "modal-overlay" });
  const box = el("div", { class: "modal", style: "width:680px;" }, [el("h2", {}, "Redlines"), el("p", { class: "subtitle" }, "Loading...")]);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // Owner's in-progress accept/reject/counter calls, staged locally and
  // sent together as one response -- keyed by submission id, then edit id.
  // { [subId]: { [editId]: { decision: "accepted"|"rejected"|"countered", counter_value: "" } } }
  const staged = {};

  async function load() {
    let data;
    try {
      data = await api(`/api/generated/${generatedId}/redlines`);
    } catch (e) {
      box.innerHTML = "";
      box.appendChild(el("h2", {}, "Redlines"));
      box.appendChild(el("div", { class: "error-box" }, e.message));
      return;
    }
    box.innerHTML = "";
    box.appendChild(el("h2", {}, "Redlines"));

    if (data.header) {
      const meta = [
        el("span", {}, data.header.document_type || "Document"),
        " · created ",
        el("span", {}, new Date(data.header.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })),
      ];
      if (data.header.client) meta.push(" · ", el("span", {}, ["client: ", data.header.client]));
      box.appendChild(
        el("div", { class: "redline-case-header" }, [
          el("div", { class: "rch-title" }, data.header.name),
          el("div", { class: "rch-meta" }, meta),
        ])
      );
    }

    if (!data.share) {
      box.appendChild(el("p", { class: "subtitle" }, "No review link has been created for this document yet. Use “Share for review” first."));
    } else if (!data.submissions.length) {
      box.appendChild(el("p", { class: "subtitle" }, "Shared, but nothing has been submitted for review yet."));
    } else {
      data.submissions.forEach((sub) => {
        const subBox = el("div", { class: "redline-submission" });
        const awaitingResponse = sub.status === "pending" && !sub.responded_at;
        const statusLabel = sub.responded_at ? "Response sent" : sub.status === "reviewed" ? "Applied" : "Pending review";
        subBox.appendChild(
          el("div", { class: "sub-header" }, [
            el("div", { style: "font-weight:700;font-size:13px;" }, statusLabel),
            el("div", { class: "when" }, new Date(sub.submitted_at).toLocaleString()),
          ])
        );
        if (sub.note) subBox.appendChild(el("div", { class: "note-box" }, sub.note));

        if (awaitingResponse && !staged[sub.id]) staged[sub.id] = {};
        const subStage = staged[sub.id] || {};

        sub.edits.forEach((edit) => {
          const already = edit.decision !== "pending"; // already decided server-side (from a prior response)
          const thresholdLines = [];
          if (edit.threshold_desc) {
            thresholdLines.push(el("div", { class: "threshold-line" }, ["Your threshold: ", edit.threshold_desc]));
          }
          if (edit.inside_threshold !== null && edit.inside_threshold !== undefined) {
            thresholdLines.push(
              el("div", { class: "threshold-line" }, `Currently ${edit.inside_threshold ? "inside" : "outside"} your threshold.`)
            );
          }

          let actions;
          if (already) {
            const summaryEl = edit.decision === "countered"
              ? el("div", { class: "decided-countered" }, ["Countered: ", el("strong", {}, edit.counter_value)])
              : el("div", { class: "decided " + edit.decision }, edit.decision);
            actions = el("div", { class: "decision-row" }, [summaryEl]);
          } else if (!awaitingResponse) {
            actions = el("div", { class: "decision-row" }, [el("div", { class: "decided pending" }, "No response yet")]);
          } else {
            const stage = subStage[edit.id] || { decision: "pending", counter_value: "" };
            subStage[edit.id] = stage;
            const counterInput = el("input", { type: "text", placeholder: "Your counter value...", value: stage.counter_value, style: stage.decision === "countered" ? "" : "display:none;" });
            counterInput.addEventListener("input", () => { stage.counter_value = counterInput.value; });
            const rejectBtn = el("button", { class: "btn secondary small" }, "Reject");
            const counterBtn = el("button", { class: "btn secondary small" }, "Counter");
            const acceptBtn = el("button", { class: "btn small" }, "Accept");
            function setStage(d) {
              stage.decision = stage.decision === d ? "pending" : d;
              counterInput.style.display = stage.decision === "countered" ? "" : "none";
              [rejectBtn, counterBtn, acceptBtn].forEach((b) => b.classList.remove("staged-active"));
              if (stage.decision === "rejected") rejectBtn.classList.add("staged-active");
              if (stage.decision === "countered") { counterBtn.classList.add("staged-active"); counterInput.focus(); }
              if (stage.decision === "accepted") acceptBtn.classList.add("staged-active");
            }
            rejectBtn.addEventListener("click", () => setStage("rejected"));
            counterBtn.addEventListener("click", () => setStage("countered"));
            acceptBtn.addEventListener("click", () => setStage("accepted"));
            actions = el("div", { class: "decision-row" }, [
              el("div", { class: "decision-btns" }, [rejectBtn, counterBtn, acceptBtn]),
              counterInput,
            ]);
          }

          subBox.appendChild(
            el("div", { class: "redline-edit-row" }, [
              el("div", { class: "info" }, [
                el("div", { class: "label" }, edit.label),
                el("div", { class: "change" }, [el("span", { class: "from" }, edit.original_value || "(blank)"), " → ", el("span", { class: "to" }, edit.proposed_value)]),
                edit.comment ? el("div", { class: "edit-comment" }, ["“", edit.comment, "”"]) : null,
                ...thresholdLines,
                el("div", { style: "margin-top:6px;" }, el("span", { class: "eval-badge " + edit.evaluation }, edit.evaluation === "auto_approved" ? "Auto-approved" : "Needs review")),
              ]),
              actions,
            ])
          );
        });

        const footerActions = el("div", { style: "display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;" });

        if (awaitingResponse) {
          const sendBtn = el("button", { class: "btn" }, "Send response");
          sendBtn.addEventListener("click", async () => {
            const decisions = Object.entries(subStage)
              .filter(([, v]) => v.decision !== "pending")
              .map(([editId, v]) => ({ edit_id: parseInt(editId, 10), decision: v.decision, counter_value: v.counter_value || "" }));
            if (!decisions.length) { alert("Accept, reject, or counter at least one redline first."); return; }
            sendBtn.disabled = true;
            sendBtn.textContent = "Sending...";
            try {
              await api(`/api/redline-submissions/${sub.id}/respond`, { method: "POST", body: { decisions } });
              delete staged[sub.id];
              load();
            } catch (e) {
              sendBtn.disabled = false;
              sendBtn.textContent = "Send response";
              alert(e.message);
            }
          });
          footerActions.appendChild(sendBtn);
        }

        const hasAcceptedSomewhere = sub.edits.some((e) => e.decision === "accepted" || (e.decision === "pending" && e.evaluation === "auto_approved"));
        if (sub.status === "pending" && hasAcceptedSomewhere) {
          const applyBtn = el("button", { class: "btn secondary" }, "Apply accepted changes → new draft");
          applyBtn.addEventListener("click", async () => {
            applyBtn.disabled = true;
            applyBtn.textContent = "Applying...";
            try {
              await api(`/api/redline-submissions/${sub.id}/apply`, { method: "POST" });
              overlay.remove();
              location.hash = "#/documents";
            } catch (e) {
              applyBtn.disabled = false;
              applyBtn.textContent = "Apply accepted changes → new draft";
              alert(e.message);
            }
          });
          footerActions.appendChild(applyBtn);
        }
        if (footerActions.children.length) subBox.appendChild(footerActions);

        if (sub.status === "reviewed") {
          subBox.appendChild(el("div", { class: "notice-box", style: "margin-top:12px;" }, "Applied, see the new version in your Documents library."));
        } else if (sub.responded_at) {
          subBox.appendChild(el("div", { class: "notice-box", style: "margin-top:12px;" }, "Response sent — the client will see it on their next visit."));
        }
        box.appendChild(subBox);
      });
    }
    box.appendChild(el("div", { class: "modal-actions" }, [el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Close")]));
  }

  load();
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
    if (p.field_type === "clause_preset") {
      const options = p.preset_options || [];
      input = el(
        "select",
        {},
        [el("option", { value: "" }, "Pick a variant...")].concat(
          options.map((o) => el("option", { value: o.text }, o.name))
        )
      );
      if (prefillVal) input.value = prefillVal;
    } else if (p.field_type === "multiline") input = el("textarea", {}, prefillVal);
    else if (p.field_type === "date") input = el("input", { type: "date", value: prefillVal });
    else if (p.field_type === "number") input = el("input", { type: "number", value: prefillVal });
    else input = el("input", { type: "text", value: prefillVal });
    inputs[p.field_key] = input;
    return el("div", { class: "form-row" }, [
      el("label", { class: "field-label" }, [p.label, p.required ? el("span", { class: "req" }, " *") : null]),
      input,
    ]);
  });

  const partyAInput = el("input", { type: "text", placeholder: "Your organization", value: (state.user && (state.user.name || state.user.email)) || "" });
  const partyBInput = el("input", { type: "text", placeholder: "The other party, e.g. Swift Enterprises" });

  const modal = el("div", { class: "modal" }, [
    el("h2", {}, tpl.name),
    el("p", { class: "subtitle", style: "margin:2px 0 16px;" }, `${tpl.document_type} · fill in the blanks below`),
    errBox,
    el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Party A"), partyAInput]),
    el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Party B"), partyBInput]),
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
    const parties = [partyAInput.value.trim(), partyBInput.value.trim()].filter(Boolean);
    try {
      const res = await api(`/api/templates/${tpl.id}/generate`, { method: "POST", body: { values, parties } });
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
    const shareBtn = el("button", { class: "btn secondary", onclick: () => openShareModal(result.generated_id) }, "Share for review");
    const redlinesBtn = el("button", { class: "btn secondary", onclick: () => openRedlinesModal(result.generated_id) }, "Redlines");
    var overlay = showPreviewOverlay({
      title: result.name,
      subtitle: `Generated from ${tpl.name} · saved to your Documents library`,
      html: result.html,
      generatedId: result.generated_id,
      extraButtons: [editBtn, libBtn, shareBtn, redlinesBtn],
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

  function plainRow(d) {
    const row = el("div", { class: "output-row" + (d.archived ? " archived" : "") }, [
      el("div", { class: "left" }, [
        el("div", { class: "file-icon" }, "✓"),
        el("div", {}, [
          el("div", { class: "name" }, d.name),
          el("div", { class: "lineage" }, ["Originated from ", el("span", { class: "tag" }, d.template_name)]),
        ]),
      ]),
      el("div", { class: "right" }, [
        el("div", { class: "date" }, new Date(d.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })),
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
    return row;
  }

  // One entry in a folder's expanded chain -- a document revision, a share,
  // a client view, or a redline submission, all merged into one timeline by
  // /api/generated/{id}/history and shown in the viewer's local time.
  function chainItemFor(ev, docsById, latestId) {
    let dotClass = "draft", dotLabel = "•", title = "", desc = "";
    const doc = ev.document_id ? docsById[ev.document_id] : null;
    if (ev.type === "drafted") {
      dotClass = "draft"; dotLabel = "•"; title = "Original draft"; desc = "First generated from the master template.";
    } else if (ev.type === "redline_applied") {
      dotClass = "final"; dotLabel = "✓"; title = "Redlines applied"; desc = "Accepted redlines were applied into this new revision.";
    } else if (ev.type === "shared") {
      dotClass = "pending"; dotLabel = "→"; title = "Shared for review"; desc = "Sent to the client for review.";
    } else if (ev.type === "viewed") {
      dotClass = "draft"; dotLabel = "○"; title = "Client viewed"; desc = "The share link was opened.";
    } else if (ev.type === "redline_submitted") {
      dotClass = "pending"; dotLabel = "✎"; title = "Redline submitted"; desc = "The client sent proposed changes for review.";
    }
    const actions = [];
    if (doc && (ev.type === "drafted" || ev.type === "redline_applied")) {
      actions.push(el("a", { onclick: () => openDetail(doc) }, "View"));
      actions.push(el("a", { href: `/api/generated/${doc.id}/download` }, "Download .docx"));
    } else if (doc && ev.type === "redline_submitted") {
      actions.push(el("a", { onclick: () => openRedlinesModal(doc.id) }, "View redlines"));
    }
    const isCurrent = !!(doc && ev.type === "redline_applied" && doc.id === latestId);
    return el("div", { class: "chain-item" }, [
      el("div", { class: "chain-dot " + dotClass }, dotLabel),
      el("div", { class: "chain-body" }, [
        el("div", { class: "chain-title-row" }, [
          el("span", { class: "chain-title" }, title),
          isCurrent ? el("span", { class: "chain-current" }, "Current version") : null,
        ]),
        el("div", { class: "chain-desc" }, desc),
        el("div", { class: "chain-meta" }, [new Date(ev.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })]),
        actions.length ? el("div", { class: "chain-actions" }, actions) : null,
      ]),
    ]);
  }

  // A folder groups every revision connected through an actual redline
  // round (share -> client edits -> owner applies) -- never just documents
  // that happen to share a template. Collapsed by default; the full
  // activity chain (views + submissions included, not just revisions) is
  // fetched lazily on first expand.
  function folderRow(familyDocs, docsById) {
    const latest = familyDocs[0]; // docs arrive sorted desc by created_at
    let open = false;
    let historyLoaded = false;

    const folder = el("div", { class: "doc-folder" });
    const chevron = el("span", { class: "chevron" }, "›");
    const statusTag = latest.is_redline_result
      ? el("span", { class: "status-tag final" }, "Redlines applied")
      : null;
    const chainWrap = el("div", { class: "chain" });
    const head = el("div", { class: "folder-head" }, [
      el("div", { class: "left" }, [
        el("div", { class: "folder-icon" }, "▸"),
        el("div", {}, [
          el("div", { class: "folder-name-row" }, [
            el("span", { class: "folder-name" }, latest.name),
            el("span", { class: "version-count" }, `${familyDocs.length} versions`),
            statusTag,
          ]),
          el("div", { class: "folder-sub" }, ["Originated from ", el("span", { class: "tag" }, latest.template_name)]),
        ]),
      ]),
      el("div", { class: "right" }, [
        el("div", { class: "date" }, "Updated " + new Date(latest.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })),
        chevron,
      ]),
    ]);
    head.addEventListener("click", () => {
      open = !open;
      folder.classList.toggle("open", open);
      if (open && !historyLoaded) {
        historyLoaded = true;
        chainWrap.innerHTML = "";
        chainWrap.appendChild(el("div", { style: "padding:14px 4px;color:var(--muted);font-size:12.5px;" }, "Loading history..."));
        api(`/api/generated/${latest.id}/history`).then((hist) => {
          chainWrap.innerHTML = "";
          hist.timeline.forEach((ev) => chainWrap.appendChild(chainItemFor(ev, docsById, latest.id)));
        });
      }
    });
    folder.appendChild(head);
    folder.appendChild(chainWrap);
    return folder;
  }

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
      const docsById = {};
      docs.forEach((d) => { docsById[d.id] = d; });

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

        // Group this type's docs by lineage, preserving first-seen order --
        // since docs arrive sorted desc by created_at, that's also
        // most-recent-activity-first for the folders themselves.
        const lineageOrder = [];
        const lineageDocs = {};
        groups[type].forEach((d) => {
          const key = d.lineage_root_id;
          if (!lineageDocs[key]) { lineageDocs[key] = []; lineageOrder.push(key); }
          lineageDocs[key].push(d);
        });

        lineageOrder.forEach((key) => {
          const familyDocs = lineageDocs[key];
          list.appendChild(familyDocs.length === 1 ? plainRow(familyDocs[0]) : folderRow(familyDocs, docsById));
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
          el("div", { class: "txt" }, ["Originated from master document", el("br"), lineageLink]),
        ]),
        el("div", {}, valuesHtml ? el("div", { html: valuesHtml }) : el("div", { style: "color:var(--muted);font-size:13px;" }, "No field values recorded.")),
        el("div", { class: "panel-actions" }, [
          el("a", { class: "btn", href: `/api/generated/${d.id}/download` }, "Download .docx"),
          el("button", { class: "btn secondary", onclick: () => openShareModal(d.id) }, "Share for review"),
          el("button", { class: "btn secondary", onclick: () => openRedlinesModal(d.id) }, "Redlines"),
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
  let currentPlaceholders = [];

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
      el("option", { value: "clause_preset" }, "Clause preset (swap the whole paragraph)"),
    ]);
    const requiredCheck = el("input", { type: "checkbox", checked: "checked" });
    const errBox = el("div");

    // Only shown/used when typeSelect.value === "clause_preset": named
    // whole-paragraph variants (e.g. "Delaware" / "California" versions of
    // a governing-law clause). Drafting picks one from a dropdown instead
    // of typing a value, and the entire clause text gets swapped in.
    const presetRows = []; // { nameInput, textInput, row }
    const presetList = el("div", { class: "preset-list" });
    function addPresetRow(name, text) {
      const nameInput = el("input", { type: "text", placeholder: "Variant name, e.g. Delaware", value: name || "" });
      const textInput = el("textarea", { placeholder: "Full clause text for this variant..." }, text || "");
      const removeBtn = el("button", { class: "btn secondary small", type: "button" }, "Remove");
      const row = el("div", { class: "preset-row" }, [
        el("div", { class: "preset-row-head" }, [nameInput, removeBtn]),
        textInput,
      ]);
      removeBtn.addEventListener("click", () => {
        const i = presetRows.findIndex((r) => r.row === row);
        if (i >= 0) presetRows.splice(i, 1);
        row.remove();
      });
      presetRows.push({ nameInput, textInput, row });
      presetList.appendChild(row);
    }
    addPresetRow("", selectionInfo.text || "");
    const addPresetBtn = el("button", { class: "btn secondary small", type: "button", style: "margin-top:8px;" }, "+ Add another variant");
    addPresetBtn.addEventListener("click", () => addPresetRow("", ""));
    const presetEditor = el("div", { style: "display:none;margin-top:4px;" }, [
      el("label", { class: "field-label" }, "Named variants"),
      el("div", { style: "font-size:12px;color:var(--muted);margin:-4px 0 10px;" }, "Each variant's full text will replace the whole selection when someone picks it while drafting."),
      presetList,
      addPresetBtn,
    ]);
    typeSelect.addEventListener("change", () => {
      presetEditor.style.display = typeSelect.value === "clause_preset" ? "" : "none";
    });

    const newFieldFields = [
      el("label", { class: "field-label" }, "Field label (shown on the fill-in form)"),
      labelInput,
      el("label", { class: "field-label" }, "Field type"),
      typeSelect,
      presetEditor,
      el("label", { class: "field-label", style: "display:flex;align-items:center;gap:6px;" }, [requiredCheck, "Required"]),
    ];

    const modalChildren = [
      el("h2", {}, "New placeholder"),
      el("div", { class: "selected-preview" }, `"${selectionInfo.text}"`),
      errBox,
    ];

    let fieldSelect = null;
    if (currentPlaceholders.length > 0) {
      fieldSelect = el(
        "select",
        {},
        [el("option", { value: "" }, "+ Create a new field")].concat(
          currentPlaceholders.map((p) => el("option", { value: p.field_key }, `Same field as "${p.label}"`))
        )
      );
      const newFieldBlock = el("div", {}, newFieldFields);
      fieldSelect.addEventListener("change", () => {
        newFieldBlock.style.display = fieldSelect.value ? "none" : "";
      });
      modalChildren.push(
        el("label", { class: "field-label" }, "This text is..."),
        fieldSelect,
        el("div", { style: "font-size:12px;color:var(--muted);margin:-6px 0 12px;" }, "Pick an existing field if this is another spot for something you already marked (e.g. a name that appears twice) — filling it once fills every spot."),
        newFieldBlock
      );
    } else {
      modalChildren.push(...newFieldFields);
    }

    modalChildren.push(
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"),
        el("button", { class: "btn", onclick: submit }, "Save"),
      ])
    );

    const modal = el("div", { class: "modal" }, modalChildren);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    labelInput.focus();

    async function submit() {
      errBox.innerHTML = "";
      const existingFieldKey = fieldSelect ? fieldSelect.value : "";
      const label = labelInput.value.trim();
      if (!existingFieldKey && !label) {
        errBox.appendChild(el("div", { class: "error-box" }, "Please enter a label."));
        return;
      }
      let presetOptions = [];
      if (typeSelect.value === "clause_preset" && !existingFieldKey) {
        presetOptions = presetRows
          .map((r) => ({ name: r.nameInput.value.trim(), text: r.textInput.value.trim() }))
          .filter((p) => p.name && p.text);
        if (!presetOptions.length) {
          errBox.appendChild(el("div", { class: "error-box" }, "Add at least one named variant with its full text."));
          return;
        }
      }
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
            existing_field_key: existingFieldKey,
            preset_options: presetOptions,
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
      currentPlaceholders = tpl.placeholders;
      phList.innerHTML = "";
      genBtn.disabled = tpl.placeholders.length === 0;
      if (!tpl.placeholders.length) {
        phList.appendChild(el("div", { style: "color:var(--muted);font-size:13px;" }, "None yet. Select text in the contract to add one."));
        return;
      }
      const fieldTypeLabels = { text: "text", multiline: "long text", date: "date", number: "number", clause_preset: "clause preset" };
      tpl.placeholders.forEach((p) => {
        const tagLabels = {
          none: "No redline rule set",
          numeric_range: `Auto-approve ${p.threshold_config.min ?? "any"}–${p.threshold_config.max ?? "any"}`,
          approved_list: `Auto-approve: ${(p.threshold_config.allowed || []).join(", ")}`,
          locked: "Always needs review",
        };
        const typeLabel = fieldTypeLabels[p.field_type] || p.field_type;
        const presetNote = p.field_type === "clause_preset" ? ` · ${(p.preset_options || []).length} variant${(p.preset_options || []).length === 1 ? "" : "s"}` : "";
        phList.appendChild(
          el("div", { class: "placeholder-chip" }, [
            el("div", { class: "row-top" }, [
              el("div", {}, [el("div", { class: "k" }, p.label), el("div", { class: "t" }, `{{${p.field_key}}} · ${typeLabel}${presetNote}${p.required ? " · required" : ""}`)]),
              el("button", { onclick: () => deletePlaceholder(p.id) }, "Remove"),
            ]),
            el("div", { class: "threshold-tag " + p.threshold_type }, tagLabels[p.threshold_type] || tagLabels.none),
            el("button", { class: "threshold-edit-link", onclick: () => openThresholdModal(p) }, "Set redline rule →"),
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

  function openThresholdModal(p) {
    const overlay = el("div", { class: "modal-overlay" });
    const errBox = el("div");

    const typeSelect = el("select", {}, [
      el("option", { value: "none" }, "No rule — always needs review"),
      el("option", { value: "numeric_range" }, "Numeric range (days, dollars, etc.)"),
      el("option", { value: "approved_list" }, "Approved list of exact values"),
      el("option", { value: "locked" }, "Always flag — never auto-approve"),
    ]);
    typeSelect.value = p.threshold_type;

    const minInput = el("input", { type: "number", value: p.threshold_config.min ?? "", placeholder: "No minimum" });
    const maxInput = el("input", { type: "number", value: p.threshold_config.max ?? "", placeholder: "No maximum" });
    const rangeBlock = el("div", { class: "range-row" }, [
      el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Minimum"), minInput]),
      el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Maximum"), maxInput]),
    ]);

    const allowedValues = (p.threshold_config.allowed && p.threshold_config.allowed.length ? p.threshold_config.allowed.slice() : [""]);
    const allowedRows = el("div", { class: "allowed-list-rows" });
    function paintAllowedRows() {
      allowedRows.innerHTML = "";
      allowedValues.forEach((val, i) => {
        const input = el("input", { type: "text", value: val, placeholder: "e.g. Delaware" });
        input.addEventListener("input", () => (allowedValues[i] = input.value));
        const removeBtn = el("button", {
          onclick: () => { allowedValues.splice(i, 1); if (!allowedValues.length) allowedValues.push(""); paintAllowedRows(); },
        }, "✕");
        allowedRows.appendChild(el("div", { class: "allowed-list-row" }, [input, removeBtn]));
      });
    }
    paintAllowedRows();
    const addAllowedBtn = el("button", { class: "btn secondary small", onclick: () => { allowedValues.push(""); paintAllowedRows(); } }, "+ Add another value");
    const allowedBlock = el("div", {}, [allowedRows, addAllowedBtn]);

    function syncVisibility() {
      rangeBlock.style.display = typeSelect.value === "numeric_range" ? "" : "none";
      allowedBlock.style.display = typeSelect.value === "approved_list" ? "" : "none";
    }
    typeSelect.addEventListener("change", syncVisibility);
    syncVisibility();

    const modal = el("div", { class: "modal" }, [
      el("h2", {}, "Redline rule"),
      el(
        "p",
        { class: "subtitle" },
        `For "${p.label}" — what counts as an acceptable client edit when this document is redlined. Never shown to the client, only used to sort their proposed changes.`
      ),
      errBox,
      el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Rule type"), typeSelect]),
      rangeBlock,
      allowedBlock,
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"),
        el("button", { class: "btn", onclick: submit }, "Save rule"),
      ]),
    ]);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    async function submit() {
      errBox.innerHTML = "";
      let threshold_config = {};
      if (typeSelect.value === "numeric_range") {
        if (minInput.value !== "") threshold_config.min = parseFloat(minInput.value);
        if (maxInput.value !== "") threshold_config.max = parseFloat(maxInput.value);
      } else if (typeSelect.value === "approved_list") {
        threshold_config = { allowed: allowedValues.map((v) => v.trim()).filter(Boolean) };
      }
      try {
        await api(`/api/templates/${templateId}/placeholders/${p.id}/threshold`, {
          method: "PATCH",
          body: { threshold_type: typeSelect.value, threshold_config },
        });
        overlay.remove();
        loadPlaceholders();
      } catch (e) {
        errBox.appendChild(el("div", { class: "error-box" }, e.message));
      }
    }
  }

  api(`/api/templates/${templateId}/html`).then((data) => { contractView.innerHTML = data.html; });
  loadPlaceholders();

  return wrap;
}

// ---------------------------------------------------------------------------
// Admin dashboard (owner-only -- see ADMIN_EMAIL in main.py)
// ---------------------------------------------------------------------------

function fmtCompactNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtBytes(n) {
  if (!n) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function fmtShortDate(iso) {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function statTile(label, value, hint) {
  return el("div", { class: "stat-tile" }, [
    el("div", { class: "stat-label" }, label),
    el("div", { class: "stat-value" }, value),
    hint ? el("div", { class: "stat-hint" }, hint) : null,
  ]);
}

// Single-series bar chart -- one hue (no legend box needed, see
// dataviz guidance: a single series names itself via the title). Bars are
// capped at 24px thick with a 4px rounded top edge and a 2px surface gap
// between them; a hairline baseline carries the axis. Hover shows an exact
// date + count in a small tooltip anchored to the bar.
function buildBarChart(title, series, colorClass) {
  const card = el("div", { class: "chart-card" });
  card.appendChild(el("div", { class: "chart-title" }, title));

  const max = Math.max(1, ...series.map((d) => d.count));
  const plot = el("div", { class: "bar-chart" });
  const tooltip = el("div", { class: "chart-tooltip" });
  tooltip.style.display = "none";
  card.appendChild(tooltip);

  series.forEach((d) => {
    const h = Math.round((d.count / max) * 100);
    const barWrap = el("div", { class: "bar-col" });
    const bar = el("div", {
      class: "bar " + colorClass,
      style: `height:${Math.max(d.count > 0 ? 3 : 0, h)}%`,
    });
    barWrap.appendChild(bar);
    barWrap.addEventListener("mouseenter", () => {
      tooltip.textContent = `${fmtShortDate(d.date)} — ${d.count}`;
      tooltip.style.display = "block";
      const wrapRect = barWrap.getBoundingClientRect();
      const plotRect = plot.getBoundingClientRect();
      tooltip.style.left = `${wrapRect.left - plotRect.left + wrapRect.width / 2}px`;
    });
    barWrap.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
    plot.appendChild(barWrap);
  });
  card.appendChild(plot);
  card.appendChild(el("div", { class: "chart-baseline" }));

  const totalCount = series.reduce((s, d) => s + d.count, 0);
  card.appendChild(el("div", { class: "chart-footnote" }, `${totalCount} total over the last ${series.length} days`));
  return card;
}

function statusRow(label, ok, okText, badText) {
  return el("div", { class: "status-row" }, [
    el("span", { class: "status-dot " + (ok ? "good" : "bad") }),
    el("span", { class: "status-label" }, label),
    el("span", { class: "status-value" }, ok ? okText : badText),
  ]);
}

function AdminView() {
  const wrap = el("div", { class: "admin-view" });
  wrap.appendChild(el("h1", {}, "Admin"));
  wrap.appendChild(el("p", { class: "subtitle" }, "Owner-only view of how Rotely itself is doing — not visible to any other account."));

  const body = el("div", {}, [el("div", { class: "empty-state card" }, "Loading...")]);
  wrap.appendChild(body);

  api("/api/admin/overview").then((data) => {
    body.innerHTML = "";
    const t = data.totals;
    const sys = data.system;

    // Stat tiles
    const statsRow = el("div", { class: "stats-row" }, [
      statTile("Total users", fmtCompactNumber(t.users), `${t.verified_users} verified`),
      statTile("New signups", fmtCompactNumber(t.users_last_7d), "last 7 days"),
      statTile("Contracts generated", fmtCompactNumber(t.generated_contracts), `${t.generated_last_7d} this week`),
      statTile("Open share links", fmtCompactNumber(t.share_links_open), `${t.redline_pending} redlines pending`),
    ]);
    body.appendChild(statsRow);

    // Charts
    const chartsRow = el("div", { class: "charts-row" }, [
      buildBarChart("Signups per day", data.signups_series, "accent"),
      buildBarChart("Contracts generated per day", data.contracts_series, "success"),
    ]);
    body.appendChild(chartsRow);

    const lowerRow = el("div", { class: "admin-lower-row" });

    // System health card
    const sysCard = el("div", { class: "card" });
    sysCard.appendChild(el("div", { class: "chart-title" }, "System"));
    sysCard.appendChild(statusRow("Email sending (SendGrid)", sys.sendgrid_configured, "Configured", "Not configured"));
    sysCard.appendChild(statusRow("AI drafting (Anthropic)", sys.anthropic_configured, "Configured", "Not configured"));

    const meterRow = el("div", { class: "status-row" });
    meterRow.appendChild(el("span", { class: "status-label" }, "Disk usage"));
    meterRow.appendChild(el("span", { class: "status-value" }, `${fmtBytes(sys.disk_used_bytes)} / ${fmtBytes(sys.disk_total_bytes)}`));
    sysCard.appendChild(meterRow);
    sysCard.appendChild(el("div", { class: "meter" }, [el("div", { class: "meter-fill", style: `width:${Math.min(100, sys.disk_pct)}%` })]));

    const buildRow = el("div", { class: "status-row", style: "margin-top:10px;" });
    buildRow.appendChild(el("span", { class: "status-label" }, "Deployed commit"));
    buildRow.appendChild(el("span", { class: "status-value mono" }, sys.git_commit));
    sysCard.appendChild(buildRow);
    lowerRow.appendChild(sysCard);

    // Plan breakdown card
    const planCard = el("div", { class: "card" });
    planCard.appendChild(el("div", { class: "chart-title" }, "Users by plan"));
    const planLabels = { starter: "Starter", pro: "Pro", unlimited: "Unlimited" };
    const planTotal = Object.values(data.users_by_plan).reduce((s, n) => s + n, 0) || 1;
    Object.keys(planLabels).forEach((key) => {
      const n = data.users_by_plan[key] || 0;
      const pct = Math.round((n / planTotal) * 100);
      const row = el("div", { class: "plan-bar-row" });
      row.appendChild(el("div", { class: "plan-bar-label" }, [planLabels[key], el("span", {}, `${n}`)]));
      row.appendChild(el("div", { class: "plan-bar-track" }, [el("div", { class: "plan-bar-fill", style: `width:${pct}%` })]));
      planCard.appendChild(row);
    });
    lowerRow.appendChild(planCard);

    body.appendChild(lowerRow);

    // Recent users table
    const usersCard = el("div", { class: "card" });
    usersCard.appendChild(el("div", { class: "chart-title" }, "Recent signups"));
    const table = el("div", { class: "admin-table" });
    table.appendChild(
      el("div", { class: "admin-table-row header" }, [
        el("div", {}, "User"),
        el("div", {}, "Plan"),
        el("div", {}, "Verified"),
        el("div", {}, "Templates"),
        el("div", {}, "Contracts"),
        el("div", {}, "Joined"),
      ])
    );
    data.recent_users.forEach((u) => {
      table.appendChild(
        el("div", { class: "admin-table-row" }, [
          el("div", {}, [el("div", { style: "font-weight:600;" }, u.name || u.email), el("div", { style: "color:var(--muted-soft);font-size:12px;" }, u.email)]),
          el("div", {}, planLabels[u.plan] || u.plan),
          el("div", {}, u.email_verified ? el("span", { class: "status-dot good", style: "display:inline-block;" }) : el("span", { class: "status-dot bad", style: "display:inline-block;" })),
          el("div", {}, String(u.template_count)),
          el("div", {}, String(u.contract_count)),
          el("div", {}, fmtShortDate(u.created_at)),
        ])
      );
    });
    usersCard.appendChild(table);
    body.appendChild(usersCard);
  }).catch((e) => {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "error-box" }, e.message || "Failed to load admin data."));
  });

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
  state.isAdmin = !!meRes.is_admin;

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
  if (hash.startsWith("#/admin")) {
    if (!state.isAdmin) { location.hash = "#/draft"; return; }
    return render(shell(AdminView()));
  }

  const draftMatch = hash.match(/^#\/draft\/(\d+)/);
  if (draftMatch) return render(shell(DraftView(parseInt(draftMatch[1], 10))));
  if (hash.startsWith("#/draft")) return render(shell(DraftView()));

  const editorMatch = hash.match(/^#\/editor\/(\d+)/);
  if (editorMatch) return render(shell(EditorView(parseInt(editorMatch[1], 10))));

  location.hash = "#/draft";
}

window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", router);
