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

// Every modal/panel is only ever closeable through whatever explicit Close
// button its own code happens to add -- most also close on a backdrop click,
// but that's opt-in per call site, and NONE of them close on Escape. If a
// given modal's Close button is ever unreachable (cut off, a render glitch,
// content taller than expected) there's no way out short of reloading the
// page. These two listeners are a blanket safety net so every current and
// future .modal-overlay/.panel-overlay always has two escape hatches, without
// each call site needing to remember to wire them up itself.
document.addEventListener("click", (e) => {
  if (e.target.classList && (e.target.classList.contains("modal-overlay") || e.target.classList.contains("panel-overlay"))) {
    e.target.remove();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // .panel-overlay (z-index 60) always renders above .modal-overlay
  // (z-index 50) -- e.g. opening Redlines from inside a document's detail
  // panel stacks a modal on top of it, but the panel is still the higher
  // layer. Closing by that same precedence (not raw DOM order) is what
  // keeps Escape and the backdrop-click handler above agreeing on which
  // layer is actually on top.
  const panels = document.querySelectorAll(".panel-overlay");
  if (panels.length) { panels[panels.length - 1].remove(); return; }
  const modals = document.querySelectorAll(".modal-overlay");
  if (modals.length) modals[modals.length - 1].remove();
});

// Copies text to the clipboard and flashes the clicked button green with
// "Copied!" for a moment, so clicking Copy actually feels like it did
// something instead of silently succeeding.
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text);
  if (!btn) return;
  if (btn._copyTimeout) clearTimeout(btn._copyTimeout);
  const original = btn._copyOriginalLabel || btn.textContent;
  btn._copyOriginalLabel = original;
  btn.textContent = "Copied!";
  btn.classList.add("copied");
  btn._copyTimeout = setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("copied");
  }, 1400);
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

    const notifWrap = el("div", { class: "notif-bell-wrap" });
    const bell = el("div", { class: "notif-bell", onclick: () => toggleNotifDropdown() }, [
      el("span", { html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>' }),
    ]);
    notifWrap.appendChild(bell);
    right.appendChild(notifWrap);
    window.__notifWrap = notifWrap;
    window.__notifBell = bell;
    ensureNotificationPolling();
    ensureVersionPolling();
    refreshNotifBadge();

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
      [el("span", { class: "plan-option-label" }, p.label), el("span", { class: "plan-option-detail" }, p.detail)]
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
    btnRow.appendChild(el("button", { class: "btn secondary small copy-btn", onclick: (e) => copyToClipboard(address, e.currentTarget) }, "Copy"));
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

  // ---- notification settings: per-type opt-out for both the bell and the
  // matching email a client's action can trigger. Each toggle saves
  // immediately on change (same pattern as the plan row above), no
  // separate save step. ----
  const notifRow = el("div", { class: "plan-row" });
  notifRow.appendChild(el("div", { class: "label" }, "Notifications"));
  const NOTIF_TOGGLES = [
    { key: "redline_submitted", label: "Someone sends redlines" },
    { key: "redline_comment", label: "Client comments on a declined redline" },
  ];
  const notifList = el("div", { style: "display:flex;flex-direction:column;gap:8px;margin-top:2px;" }, [
    el("span", { style: "font-size:11.5px;color:var(--muted);" }, "Loading..."),
  ]);
  notifRow.appendChild(notifList);
  dd.appendChild(notifRow);

  function paintNotifToggles(settings) {
    notifList.innerHTML = "";
    NOTIF_TOGGLES.forEach((t) => {
      const check = el("input", { type: "checkbox", checked: settings[t.key] ? "checked" : undefined });
      check.checked = !!settings[t.key];
      check.addEventListener("change", async () => {
        check.disabled = true;
        try {
          const res = await api("/api/account/notification-settings", { method: "PATCH", body: { [t.key]: check.checked } });
          paintNotifToggles(res);
        } catch (e) {
          check.checked = !check.checked; // revert on failure
          alert(e.message);
        } finally {
          check.disabled = false;
        }
      });
      notifList.appendChild(
        el("label", { style: "display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ink-soft);cursor:pointer;" }, [check, t.label])
      );
    });
  }
  api("/api/account/notification-settings").then((res) => paintNotifToggles(res));

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

// ---------------------------------------------------------------------------
// Notification bell -- fires on exactly two events (see main.py's _notify
// call sites): a client submits redlines for review, and a client comments
// on a redline the owner declined. Nothing else lights up the bell.
// "response_acknowledged" is kept in the label map only so any older,
// already-delivered notifications of that (now-retired) type still render
// with a readable title instead of raw text.
// ---------------------------------------------------------------------------

const NOTIF_TYPE_LABELS = { redline_submitted: "Redlines submitted", response_acknowledged: "Response seen", redline_comment: "Redline comment" };

function refreshNotifBadge() {
  if (!state.user) return;
  api("/api/notifications")
    .then((data) => {
      const bell = window.__notifBell;
      if (!bell) return;
      const existing = bell.querySelector(".notif-badge");
      if (existing) existing.remove();
      if (data.unread_count > 0) {
        bell.appendChild(el("span", { class: "notif-badge" }, data.unread_count > 9 ? "9+" : String(data.unread_count)));
      }
    })
    .catch(() => {});
}

function ensureNotificationPolling() {
  if (window.__notifPollStarted) return;
  window.__notifPollStarted = true;
  setInterval(() => refreshNotifBadge(), 30000);
}

// ---------------------------------------------------------------------------
// Stale-tab detection -- see APP_BOOT_ID in main.py. A tab left open across a
// deploy keeps running the JS it loaded at page-open forever; this is what
// tells the person instead of leaving them staring at old behavior.
// ---------------------------------------------------------------------------

function ensureVersionPolling() {
  if (window.__versionPollStarted) return;
  window.__versionPollStarted = true;
  api("/api/version").then((d) => { window.__bootId = d.boot_id; }).catch(() => {});
  setInterval(() => {
    if (window.__versionBannerShown) return;
    api("/api/version").then((d) => {
      if (window.__bootId && d.boot_id !== window.__bootId) {
        window.__versionBannerShown = true;
        showUpdateBanner();
      }
    }).catch(() => {});
  }, 3 * 60 * 1000);
}

function showUpdateBanner() {
  document.body.appendChild(
    el("div", { class: "version-banner" }, [
      el("span", {}, "A new version is available."),
      el("button", { class: "btn small", onclick: () => location.reload() }, "Refresh"),
    ])
  );
}

function toggleNotifDropdown() {
  const wrap = window.__notifWrap;
  if (!wrap) return;
  const existing = wrap.querySelector(".notif-dropdown");
  if (existing) { existing.remove(); return; }

  const dd = el("div", { class: "notif-dropdown" });
  const head = el("div", { class: "notif-dropdown-head" }, [el("span", { class: "title" }, "Notifications")]);
  const markAllBtn = el("button", {}, "Mark all read");
  head.appendChild(markAllBtn);
  dd.appendChild(head);

  const list = el("div", {}, [el("div", { class: "notif-empty" }, "Loading...")]);
  dd.appendChild(list);

  function paint(notifications) {
    list.innerHTML = "";
    if (!notifications.length) {
      list.appendChild(el("div", { class: "notif-empty" }, "No notifications yet."));
      return;
    }
    notifications.forEach((n) => {
      const item = el("button", { class: "notif-item" + (n.read ? "" : " unread") }, [
        el("div", { class: "notif-title" }, n.title),
        n.body ? el("div", { class: "notif-body" }, n.body) : null,
        el("div", { class: "notif-time" }, fmtRelativeTime(n.created_at)),
      ]);
      item.addEventListener("click", async () => {
        if (!n.read) {
          try { await api(`/api/notifications/${n.id}/read`, { method: "POST" }); } catch (e) {}
          refreshNotifBadge();
        }
        dd.remove();
        // Land on the documents page and jump straight into the specific
        // document's redlines, instead of just dropping them on the list --
        // the whole point of clicking a notification is to see what it's
        // telling you about. Uses replaceState (not location.hash=...) so
        // this doesn't fire a second hashchange -> router() cycle, which
        // would otherwise immediately close the modal we're about to open --
        // router() clears any open .modal-overlay as routine nav cleanup.
        history.replaceState(null, "", "#/documents");
        render(shell(DocumentsView()));
        if (n.generated_contract_id) openRedlinesModal(n.generated_contract_id);
      });
      list.appendChild(item);
    });
  }

  markAllBtn.addEventListener("click", async () => {
    try {
      await api("/api/notifications/read-all", { method: "POST" });
      const res = await api("/api/notifications");
      paint(res.notifications);
      refreshNotifBadge();
    } catch (e) {}
  });

  api("/api/notifications")
    .then((res) => paint(res.notifications))
    .catch((e) => {
      list.innerHTML = "";
      list.appendChild(el("div", { class: "notif-empty" }, e.message || "Failed to load notifications."));
    });

  window.__notifWrap.appendChild(dd);
  setTimeout(() => {
    document.addEventListener("click", function onDocClick(e) {
      if (!dd.contains(e.target) && e.target !== window.__notifWrap && !window.__notifWrap.contains(e.target)) {
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

  // If we just landed here from a real (non-hash) redirect -- the
  // verify-email link, the Google OAuth callback erroring out, or a
  // reset-password link that had already expired -- surface a banner once
  // and strip the query off the hash so it doesn't linger through reloads.
  const hashQuery = new URLSearchParams(location.hash.split("?")[1] || "");
  const justVerified = hashQuery.get("verified") === "1";
  const verifyError = hashQuery.get("verify_error") === "1";
  const googleError = hashQuery.get("google_error") === "1";
  const resetError = hashQuery.get("reset_error") === "1";
  if (justVerified || verifyError || googleError || resetError) {
    history.replaceState(null, "", location.pathname + "#/login");
  }

  let registeredEmail = null; // set right after a successful register -- swaps the card to "check your email"
  let forgotMode = false; // true while showing the "reset your password" mini-form instead of login/register
  let forgotSent = false;

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

    if (forgotMode) {
      const fEmail = el("input", { type: "email", placeholder: "you@example.com" });
      const fError = el("div");
      const fBack = el("button", { class: "btn ghost block", style: "margin-top:8px;", onclick: () => { forgotMode = false; forgotSent = false; draw(); } }, "Back to log in");

      card.appendChild(el("h1", {}, "Reset your password"));
      if (forgotSent) {
        card.appendChild(
          el("p", { class: "subtitle" }, [
            "If an account exists for ",
            el("strong", {}, fEmail.value || "that address"),
            ", we sent a link to reset the password. It works for the next hour.",
          ])
        );
        card.appendChild(fBack);
        return;
      }
      card.appendChild(el("p", { class: "subtitle" }, "Enter your account email and we'll send you a link to set a new password."));
      card.appendChild(fError);
      card.appendChild(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Email"), fEmail]));
      const fSubmit = el("button", { class: "btn block" }, "Send reset link");
      fSubmit.addEventListener("click", async () => {
        fError.innerHTML = "";
        if (!fEmail.value.trim()) {
          fError.appendChild(el("div", { class: "error-box" }, "Please enter your email."));
          return;
        }
        fSubmit.disabled = true;
        try {
          await api("/api/forgot-password", { method: "POST", body: { email: fEmail.value.trim() } });
          forgotSent = true;
          draw();
        } catch (e) {
          fError.appendChild(el("div", { class: "error-box" }, e.message || "Something went wrong. Try again."));
          fSubmit.disabled = false;
        }
      });
      card.appendChild(fSubmit);
      card.appendChild(fBack);
      return;
    }

    const errorBox = el("div");
    if (tab === "login" && justVerified) {
      errorBox.appendChild(el("div", { class: "notice-box" }, "Email verified — you can log in now."));
    } else if (tab === "login" && verifyError) {
      errorBox.appendChild(el("div", { class: "error-box" }, "That verification link is invalid or expired. Request a new one below."));
    } else if (tab === "login" && googleError) {
      errorBox.appendChild(el("div", { class: "error-box" }, "Couldn't sign in with Google. Try again, or log in with your email and password."));
    } else if (tab === "login" && resetError) {
      errorBox.appendChild(el("div", { class: "error-box" }, "That reset link is invalid or expired. Request a new one below."));
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
    const passwordLabelRow = tab === "login"
      ? el("div", { style: "display:flex;justify-content:space-between;align-items:baseline;" }, [
          el("label", { class: "field-label", style: "margin:0;" }, "Password"),
          el("a", { href: "#", class: "forgot-link", onclick: (e) => { e.preventDefault(); forgotMode = true; draw(); } }, "Forgot password?"),
        ])
      : el("label", { class: "field-label" }, "Password");
    fields.push(el("div", { class: "form-row" }, [passwordLabelRow, passInput]));
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

    card.appendChild(el("div", { class: "auth-divider" }, [el("span", {}, "or")]));
    card.appendChild(
      el("a", { href: "/api/auth/google/start", class: "btn secondary block google-btn" }, [
        el("span", { html: '<svg width="16" height="16" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.9 32.6 29.4 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34.1 5.1 29.3 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.2-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.5 19 12 24 12c3.1 0 5.8 1.1 8 3l6-6C34.1 5.1 29.3 3 24 3 16.3 3 9.6 7.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 45c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 36.4 26.7 37 24 37c-5.3 0-9.8-3.4-11.4-8.1l-6.5 5C9.5 40.6 16.2 45 24 45z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3-3.4 5.4-6.3 6.7l6.2 5.2C38.9 37.4 42 31.2 42 24c0-1.2-.1-2.4-.4-3.5z"/></svg>' }),
        el("span", {}, "Continue with Google"),
      ])
    );
  }
  draw();
  return wrap;
}

function ResetPasswordView() {
  const wrap = el("div", { class: "auth-shell" });
  const card = el("div", { class: "card" });
  wrap.appendChild(card);

  const hashQuery = new URLSearchParams(location.hash.split("?")[1] || "");
  const token = hashQuery.get("token") || "";

  card.appendChild(el("div", { class: "auth-logo" }, [el("div", { class: "word" }, "Rotely.ai")]));

  if (!token) {
    card.appendChild(el("h1", {}, "Invalid link"));
    card.appendChild(el("p", { class: "subtitle" }, "That reset link is missing its token. Request a new one from the login page."));
    card.appendChild(el("a", { href: "#/login", class: "btn block" }, "Back to log in"));
    return wrap;
  }

  const errorBox = el("div");
  const passInput = el("input", { type: "password", placeholder: "At least 8 characters" });
  const confirmInput = el("input", { type: "password", placeholder: "Re-enter your new password" });

  const submitBtn = el("button", { class: "btn block" }, "Set new password");
  submitBtn.addEventListener("click", async () => {
    errorBox.innerHTML = "";
    if (passInput.value !== confirmInput.value) {
      errorBox.appendChild(el("div", { class: "error-box" }, "Passwords don't match."));
      return;
    }
    submitBtn.disabled = true;
    try {
      const res = await api("/api/reset-password", { method: "POST", body: { token, password: passInput.value } });
      if (res.logged_in) {
        const meRes = await api("/api/me");
        state.user = meRes.user;
        state.plan = meRes.plan;
        state.isAdmin = !!meRes.is_admin;
        location.hash = "#/draft";
      } else {
        history.replaceState(null, "", location.pathname + "#/login");
        location.hash = "#/login";
      }
    } catch (e) {
      errorBox.appendChild(el("div", { class: "error-box" }, e.message || "Something went wrong. Try again."));
      submitBtn.disabled = false;
    }
  });

  card.appendChild(el("h1", {}, "Set a new password"));
  card.appendChild(el("p", { class: "subtitle" }, "Choose a new password for your account."));
  card.appendChild(errorBox);
  card.appendChild(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "New password"), passInput]));
  card.appendChild(
    el("div", { style: "font-size:12px;color:var(--muted);margin:-8px 0 2px;" }, "At least 8 characters, with an uppercase letter, a lowercase letter, and a number.")
  );
  card.appendChild(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Confirm new password"), confirmInput]));
  card.appendChild(submitBtn);

  return wrap;
}

// ---------------------------------------------------------------------------
// Shared: document preview overlay
// ---------------------------------------------------------------------------

function showPreviewOverlay({ title, subtitle, html, generatedId, extraButtons, editable, onEdited }) {
  const overlay = el("div", { class: "modal-overlay" });
  const box = el("div", { class: "modal", style: "width:720px;" });

  const headerRow = el("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;" }, [
    el("div", {}, [el("h2", {}, title), subtitle ? el("p", { class: "subtitle", style: "margin:2px 0 0;" }, subtitle) : null]),
    el("button", { class: "btn ghost small", onclick: () => overlay.remove() }, "Close"),
  ]);
  box.appendChild(headerRow);

  if (editable && generatedId) {
    box.appendChild(el("p", { style: "font-size:12.5px;color:var(--muted);margin:-8px 0 10px;" }, "Select any text below to edit it directly -- saved instantly as a new revision, no approval needed."));
  }

  const preview = el("div", { class: "contract-view compact", style: "max-height:52vh;overflow-y:auto;" });
  preview.innerHTML = html || "<p style='color:var(--muted);'>No preview available.</p>";
  box.appendChild(preview);

  if (editable && generatedId) {
    let activePopover = null;
    const closePop = () => { if (activePopover) { activePopover.remove(); activePopover = null; } };
    preview.addEventListener("mouseup", () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        if (!preview.contains(range.commonAncestorContainer)) return;
        const rect = range.getBoundingClientRect();
        const info = computeSelectionSegments(preview);
        sel.removeAllRanges();
        if (!info) return;
        if (info.error === "cross-paragraph") { alert("Please select text within a single paragraph."); return; }
        closePop();
        const input = el("textarea", { rows: "2" }, info.text);
        const errBox = el("div");
        const saveBtn = el("button", { class: "btn" }, "Save as new revision");
        saveBtn.addEventListener("click", async () => {
          errBox.innerHTML = "";
          saveBtn.disabled = true;
          try {
            const editRes = await api(`/api/generated/${generatedId}/edit`, {
              method: "POST",
              body: {
                table_path: info.table_path,
                paragraph_index: info.paragraph_index,
                segments: info.segments,
                new_text: input.value,
              },
            });
            closePop();
            overlay.remove();
            if (typeof onEdited === "function") onEdited(editRes);
          } catch (e) {
            errBox.appendChild(el("div", { class: "error-box" }, e.message));
            saveBtn.disabled = false;
          }
        });
        const pop = el("div", { class: "redline-popover" }, [
          el("div", { class: "rp-label" }, "Edit text"),
          input,
          errBox,
          el("div", { class: "rp-actions" }, [
            el("button", { class: "btn secondary", onclick: closePop }, "Cancel"),
            saveBtn,
          ]),
        ]);
        document.body.appendChild(pop);
        pop.style.top = Math.min(window.innerHeight - 220, rect.bottom + 8) + "px";
        pop.style.left = Math.min(window.innerWidth - 300, Math.max(8, rect.left)) + "px";
        activePopover = pop;
        input.focus();
      }, 0);
    });
  }

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
  // .panel-overlay outranks .modal-overlay in z-index, so a leftover detail
  // panel (from openDetail, or from a notification-bell click landing here
  // while a panel is still open) would render on top of this modal and
  // physically block its Close button. Belt-and-suspenders on top of
  // openDetail's own callers already closing it -- this covers every path
  // that can reach here, not just the ones that remember to.
  document.querySelectorAll(".panel-overlay").forEach((o) => o.remove());
  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", {}, el("p", { class: "subtitle" }, "Loading..."));
  const modal = el("div", { class: "modal" }, [el("h2", {}, "Share for review"), body]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // A share link is now only ever created with a real client attached --
  // first name, last name, and a valid email are required (see
  // main.create_share_link's docstring: comments need an attributed
  // person, and so will e-signature down the line). An EXISTING link
  // (created before this requirement, or just already set up) never gets
  // blocked by this -- only the moment of creating a brand-new one does.
  // So: try the plain lookup first; if the server says there's no link yet
  // and it needs the client's info, show that intake form instead of a
  // raw error.
  const NEEDS_INTAKE = "Enter the client's first name, last name, and email";

  function renderShareInfo(share) {
    const linkUrl = `${location.origin}${share.url}`;
    body.innerHTML = "";
    body.appendChild(el("p", { class: "subtitle" }, "Send the link and the access code to your client separately, a text or a call works well, the same way you'd share anything sensitive."));
    body.appendChild(
      el("div", { class: "share-info-box" }, [
        el("div", { class: "row" }, [
          el("div", { style: "min-width:0;" }, [el("div", { class: "k" }, "Review link"), el("div", { class: "v" }, linkUrl)]),
          el("button", { class: "btn secondary small copy-btn", onclick: (e) => copyToClipboard(linkUrl, e.currentTarget) }, "Copy"),
        ]),
        el("div", { class: "row" }, [
          el("div", {}, [el("div", { class: "k" }, "Access code"), el("div", { class: "v" }, share.access_code)]),
          el("button", { class: "btn secondary small copy-btn", onclick: (e) => copyToClipboard(share.access_code, e.currentTarget) }, "Copy"),
        ]),
      ])
    );
    const firstNameInput = el("input", { type: "text", placeholder: "Jamie", value: share.client_first_name || "" });
    const lastNameInput = el("input", { type: "text", placeholder: "Rivera", value: share.client_last_name || "" });
    const emailInput = el("input", { type: "email", placeholder: "client@company.com", value: share.client_email || "" });
    const clientSavedNote = el("span", { style: "font-size:12px;color:var(--success);margin-left:8px;display:none;" }, "Saved");
    const senderInput = el("input", { type: "email", placeholder: "you@company.com (defaults to your login email)", value: share.sender_email || "" });
    const senderSavedNote = el("span", { style: "font-size:12px;color:var(--success);margin-left:8px;display:none;" }, "Saved");
    async function saveShareFields(noteEl) {
      await api(`/api/generated/${generatedId}/share`, {
        method: "POST",
        body: {
          client_first_name: firstNameInput.value.trim(), client_last_name: lastNameInput.value.trim(),
          client_email: emailInput.value.trim(), sender_email: senderInput.value.trim(),
        },
      });
      noteEl.style.display = "inline";
      setTimeout(() => (noteEl.style.display = "none"), 1500);
    }
    [firstNameInput, lastNameInput, emailInput].forEach((inp) => inp.addEventListener("change", () => saveShareFields(clientSavedNote)));
    senderInput.addEventListener("change", () => saveShareFields(senderSavedNote));
    body.appendChild(
      el("div", { class: "form-row", style: "margin-top:14px;" }, [
        el("label", { class: "field-label" }, ["Your email (shown to the client)", senderSavedNote]),
        senderInput,
        el("div", { style: "font-size:12px;color:var(--muted);margin-top:4px;" }, "Shown to them as the document sender's contact. Leave blank to use your account login email."),
      ])
    );
    body.appendChild(
      el("div", { class: "form-row", style: "margin-top:14px;" }, [
        el("label", { class: "field-label" }, ["Client name and email", clientSavedNote]),
        el("div", { style: "display:flex;gap:8px;" }, [firstNameInput, lastNameInput]),
        emailInput,
        el("div", { style: "font-size:12px;color:var(--muted);margin-top:4px;" }, "Who you're sharing this with -- shown on the review page, and used to send them the link and to attribute their comments."),
      ])
    );
    body.appendChild(
      el("div", { class: "modal-actions" }, [
        el(
          "button",
          {
            class: "btn danger",
            onclick: async (e) => {
              if (!confirm("Close this review link? The client won't be able to open it or submit further redlines. You can share a fresh link afterward if needed.")) return;
              const btn = e.currentTarget;
              btn.disabled = true;
              try {
                await api(`/api/generated/${generatedId}/share/close`, { method: "POST" });
                overlay.remove();
              } catch (err) {
                btn.disabled = false;
                alert(err.message);
              }
            },
          },
          "Close review link"
        ),
        el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Close"),
      ])
    );
  }

  function renderIntakeForm(errMsg) {
    body.innerHTML = "";
    body.appendChild(el("p", { class: "subtitle" }, "Who are you sharing this document with? We'll use this to send them the link and to attribute their comments when they redline it."));
    const errBox = el("div", {});
    if (errMsg) errBox.appendChild(el("div", { class: "error-box" }, errMsg));
    const firstNameInput = el("input", { type: "text", placeholder: "Jamie" });
    const lastNameInput = el("input", { type: "text", placeholder: "Rivera" });
    const emailInput = el("input", { type: "email", placeholder: "client@company.com" });
    body.appendChild(
      el("div", { class: "form-row" }, [
        el("label", { class: "field-label" }, "Client's name"),
        el("div", { style: "display:flex;gap:8px;" }, [firstNameInput, lastNameInput]),
      ])
    );
    body.appendChild(
      el("div", { class: "form-row", style: "margin-top:14px;" }, [
        el("label", { class: "field-label" }, "Client's email"),
        emailInput,
        el("div", { style: "font-size:12px;color:var(--muted);margin-top:4px;" }, "We'll email them the review link and access code."),
      ])
    );
    body.appendChild(errBox);
    const createBtn = el("button", { class: "btn", style: "margin-top:14px;" }, "Create share link");
    createBtn.addEventListener("click", async () => {
      errBox.innerHTML = "";
      const first = firstNameInput.value.trim(), last = lastNameInput.value.trim(), email = emailInput.value.trim();
      if (!first || !last || !email) {
        errBox.appendChild(el("div", { class: "error-box" }, "First name, last name, and email are all required."));
        return;
      }
      createBtn.disabled = true;
      createBtn.textContent = "Creating...";
      try {
        const share = await api(`/api/generated/${generatedId}/share`, {
          method: "POST",
          body: { client_first_name: first, client_last_name: last, client_email: email },
        });
        renderShareInfo(share);
      } catch (err) {
        errBox.appendChild(el("div", { class: "error-box" }, err.message));
        createBtn.disabled = false;
        createBtn.textContent = "Create share link";
      }
    });
    body.appendChild(
      el("div", { class: "modal-actions" }, [el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"), createBtn])
    );
  }

  try {
    const share = await api(`/api/generated/${generatedId}/share`, { method: "POST" });
    renderShareInfo(share);
  } catch (e) {
    if ((e.message || "").includes(NEEDS_INTAKE)) {
      renderIntakeForm();
    } else {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "error-box" }, e.message));
    }
  }
}

async function openRedlinesModal(generatedId) {
  // See the matching comment in openShareModal -- a leftover detail panel
  // would otherwise render on top of this modal (panel-overlay's z-index
  // beats modal-overlay's) and swallow clicks meant for its Close button.
  document.querySelectorAll(".panel-overlay").forEach((o) => o.remove());
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
        // Gated on whether any edit in this round is still undecided, NOT
        // just on whether a response was already sent -- responding is
        // allowed to cover only some of a round's edits (see the "Send
        // response" handler below), and previously, once responded_at was
        // set, the leftover pending edits permanently lost their decision
        // buttons with no other way in the product to ever decide them.
        // Recomputing this from the actual remaining work means a second,
        // later response for the rest of the round is always possible.
        const undecidedCount = sub.edits.filter((e) => e.decision === "pending").length;
        const awaitingResponse = sub.status === "pending" && undecidedCount > 0;
        const statusLabel = sub.status === "reviewed"
          ? "Applied"
          : !sub.responded_at
          ? "Pending review"
          : undecidedCount > 0
          ? `Response sent · ${undecidedCount} more still need${undecidedCount === 1 ? "s" : ""} a decision`
          : "Response sent";
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
            const actionChildren = [summaryEl];
            // The client can leave a comment on any redline the owner
            // declined (see share.js's renderReplyArea) -- surface it here
            // so the owner sees the pushback without having to go dig for
            // it, styled the same way it appears on the client's side.
            if (edit.decision === "rejected" && edit.client_reply) {
              actionChildren.push(
                el("div", { class: "client-reply-box" }, [
                  el("div", { class: "client-reply-label" }, "Client's comment:"),
                  el("div", { class: "client-reply-text" }, edit.client_reply),
                ])
              );
            }
            actions = el("div", { class: "decision-row" }, actionChildren);
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
              [rejectBtn, counterBtn, acceptBtn].forEach((b) => b.classList.remove("staged-active", "stage-accepted", "stage-rejected", "stage-countered"));
              if (stage.decision === "rejected") rejectBtn.classList.add("staged-active", "stage-rejected");
              if (stage.decision === "countered") { counterBtn.classList.add("staged-active", "stage-countered"); counterInput.focus(); }
              if (stage.decision === "accepted") acceptBtn.classList.add("staged-active", "stage-accepted");
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
            // Warn BEFORE applying if a newer round exists on this same link
            // that hasn't been applied yet -- otherwise it's easy to apply an
            // older round, not realize a newer one is sitting right above it,
            // and end up thinking you're looking at the latest version when
            // you're not.
            const newerUnapplied = data.submissions.some(
              (s) => s.id !== sub.id && s.status !== "reviewed" && new Date(s.submitted_at) > new Date(sub.submitted_at)
            );
            if (newerUnapplied) {
              const proceed = confirm(
                "There's a newer round of redlines on this document that hasn't been applied yet. " +
                "Are you sure you want to apply this older round now?"
              );
              if (!proceed) return;
            }
            applyBtn.disabled = true;
            applyBtn.textContent = "Applying...";
            try {
              const result = await api(`/api/redline-submissions/${sub.id}/apply`, { method: "POST" });
              overlay.remove();
              if (result.chained_from) {
                // This document already had a newer state (an earlier applied
                // redline round, or a direct edit) than the one this round was
                // originally drafted against, so this apply built on top of
                // that instead of the pristine original -- otherwise whatever
                // changed since would have been silently dropped. Tell the
                // owner so it's never a silent merge.
                alert(
                  `Applied on top of "${result.chained_from.name}", the most recent version of this document. ` +
                  `The new version includes those changes plus this round's.`
                );
              }
              if (result.folded_in_submissions && result.folded_in_submissions.length) {
                // Any other round on this link that had already been decided
                // but never applied got folded into this same apply -- see
                // apply_redline_submission's docstring. Tell the owner so
                // it's clear why those other rounds now show as applied too.
                const n = result.folded_in_submissions.length;
                alert(
                  `This also included ${n} other already-decided round${n === 1 ? "" : "s"} on this document that ` +
                  `hadn't been applied yet -- nothing decided so far was left behind.`
                );
              }
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
  const prefillValues = (prefill && prefill.values) || {};

  const fieldRows = tpl.placeholders.map((p) => {
    let input;
    const prefillVal = prefillValues[p.field_key] || "";
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

  const partyAInput = el("input", {
    type: "text", placeholder: "Your organization",
    value: (prefill && prefill.party_a) || (state.user && (state.user.name || state.user.email)) || "",
  });
  const partyBInput = el("input", {
    type: "text", placeholder: "The other party, e.g. Swift Enterprises",
    value: (prefill && prefill.party_b) || "",
  });

  const generateBtn = el("button", { class: "btn", onclick: submit }, "Generate");
  const modal = el("div", { class: "modal" }, [
    el("h2", {}, tpl.name),
    el("p", { class: "subtitle", style: "margin:2px 0 16px;" }, `${tpl.document_type} · fill in the blanks below`),
    errBox,
    el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Party A"), partyAInput]),
    el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Party B"), partyBInput]),
    ...fieldRows,
    el("div", { class: "modal-actions" }, [
      el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"),
      generateBtn,
    ]),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  async function submit() {
    // Guard against double-submit (double-click, or a slow request plus a
    // second click before it resolves) -- without this, each click fires an
    // independent POST /generate and the server had no dedup, so a single
    // "draft from template" action could silently create two documents.
    if (generateBtn.disabled) return;
    errBox.innerHTML = "";
    const values = {};
    Object.entries(inputs).forEach(([k, i]) => (values[k] = i.value));
    const partyA = partyAInput.value.trim();
    const partyB = partyBInput.value.trim();
    const parties = [partyA, partyB].filter(Boolean);
    generateBtn.disabled = true;
    generateBtn.textContent = "Generating...";
    try {
      const res = await api(`/api/templates/${tpl.id}/generate`, { method: "POST", body: { values, parties } });
      state.plan = res.plan;
      overlay.remove();
      // Handed straight back to openFillModal as `prefill` if the caller
      // reopens this same form (e.g. "Edit values") -- keeping the shape
      // identical here is what makes round-tripping through it lossless
      // instead of silently dropping whatever was just typed in.
      onDone(res, { values, party_a: partyA, party_b: partyB });
    } catch (e) {
      errBox.appendChild(el("div", { class: "error-box" }, e.message));
      generateBtn.disabled = false;
      generateBtn.textContent = "Generate";
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
      openFillModal(tpl, null, (result, prefill) => {
        showResult(tpl, result, prefill);
      });
    });
  }

  function showResult(tpl, result, lastPrefill) {
    const editBtn = el("button", { class: "btn secondary" }, "Edit values");
    editBtn.addEventListener("click", () => {
      overlay.remove();
      api(`/api/templates/${tpl.id}`).then((freshTpl) => {
        openFillModal(freshTpl, lastPrefill, (res2, prefill2) => showResult(freshTpl, res2, prefill2));
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
      editable: true,
      onEdited: (editRes) => {
        // A direct edit creates a new revision rather than modifying this one
        // in place -- re-fetch it and re-render so the buttons above (Share,
        // Redlines, further edits) all point at the document you're actually
        // looking at now, not the superseded one.
        api(`/api/generated/${editRes.id}`).then((fresh) => {
          showResult(tpl, { generated_id: fresh.id, name: fresh.name, html: fresh.html }, lastPrefill);
        });
      },
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
        const deleteBtn = el("button", { class: "btn danger small" }, "Delete");
        deleteBtn.addEventListener("click", () => deleteTemplate(t.id, deleteBtn));
        actions.push(deleteBtn);

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

  async function deleteTemplate(id, btn) {
    if (!confirm("Delete this master document? Fields and any editing progress will be lost. Documents already drafted from it are kept in your library.")) return;
    btn.disabled = true;
    btn.textContent = "Deleting...";
    try {
      await api(`/api/templates/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      alert(e.message);
      btn.disabled = false;
      btn.textContent = "Delete";
    }
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

  // Small colored pill for a document's current step (drafted, shared,
  // redlines submitted, response sent, applied) -- reuses the same
  // .status-tag tones the folder view's "Redlines applied" badge already
  // used, so draft/pending/final read consistently everywhere.
  function statusTagEl(status) {
    if (!status) return null;
    return el("span", { class: "status-tag " + (status.tone || "draft") }, status.label);
  }

  function partiesLineEl(parties) {
    if (!parties || !parties.length) return null;
    return el("div", { class: "lineage" }, [el("span", { style: "font-weight:600;" }, "Parties: "), parties.join("  ·  ")]);
  }

  function plainRow(d) {
    const row = el("div", { class: "output-row" + (d.archived ? " archived" : "") }, [
      el("div", { class: "left" }, [
        el("div", { class: "file-icon" }, "✓"),
        el("div", {}, [
          el("div", { class: "folder-name-row" }, [el("div", { class: "name" }, d.name), statusTagEl(d.status)]),
          el("div", { class: "lineage" }, ["Originated from ", el("span", { class: "tag" }, d.template_name)]),
          partiesLineEl(d.parties),
        ]),
      ]),
      el("div", { class: "right" }, [
        el("div", { class: "date" }, "Updated " + new Date(d.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })),
        el("button", {
          class: "btn secondary small",
          onclick: (e) => { e.stopPropagation(); toggleArchive(d); },
        }, d.archived ? "Unarchive" : "Archive"),
        el("button", {
          class: "btn danger small",
          onclick: (e) => { e.stopPropagation(); deleteForever(d); },
        }, "Delete"),
        // Invisible placeholder matching folderRow's trailing chevron so the
        // Archive/Delete buttons land at the same x-position whether or not
        // this particular row happens to be expandable -- a single-version
        // row has nothing to expand, but it should still look aligned with
        // its multi-version neighbors in the same list.
        el("span", { class: "chevron", style: "visibility:hidden;" }, "›"),
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
    const chainWrap = el("div", { class: "chain" });
    const head = el("div", { class: "folder-head" }, [
      el("div", { class: "left" }, [
        el("div", { class: "folder-icon" }, "▸"),
        el("div", {}, [
          el("div", { class: "folder-name-row" }, [
            el("span", { class: "folder-name" }, latest.name),
            el("span", { class: "version-count" }, `${familyDocs.length} versions`),
            statusTagEl(latest.status),
          ]),
          el("div", { class: "folder-sub" }, ["Originated from ", el("span", { class: "tag" }, latest.template_name)]),
          partiesLineEl(latest.parties),
        ]),
      ]),
      el("div", { class: "right" }, [
        el("div", { class: "date" }, "Updated " + new Date(latest.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })),
        el("button", {
          class: "btn secondary small",
          onclick: (e) => { e.stopPropagation(); toggleArchiveFamily(familyDocs); },
        }, latest.archived ? "Unarchive" : "Archive"),
        el("button", {
          class: "btn danger small",
          onclick: (e) => { e.stopPropagation(); deleteFamilyForever(familyDocs); },
        }, "Delete"),
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

  // A folder is every revision of one document -- archiving or deleting
  // only the latest revision would leave the older ones stranded on
  // whichever tab (Active/Archived) they happened to already be on, since
  // that filter is applied per-document before grouping into folders. So
  // both actions here always apply to every version in the family at once,
  // keeping the whole folder together on one tab.
  async function toggleArchiveFamily(familyDocs) {
    const nextArchived = !familyDocs[0].archived;
    await Promise.all(familyDocs.map((d) => api(`/api/generated/${d.id}/archive`, { method: "POST", body: { archived: nextArchived } })));
    load();
  }

  async function deleteFamilyForever(familyDocs) {
    const label = familyDocs.length > 1 ? `all ${familyDocs.length} versions of "${familyDocs[0].name}"` : `"${familyDocs[0].name}"`;
    if (!confirm(`Permanently delete ${label}? This cannot be undone.`)) return;
    await Promise.all(familyDocs.map((d) => api(`/api/generated/${d.id}`, { method: "DELETE" })));
    load();
  }

  function openDetail(d) {
    api(`/api/generated/${d.id}`).then((full) => {
      const valuesHtml = full.values.map((v) => `<div class="field-row"><div class="k">${v.label}</div><div class="v">${v.value || "—"}</div></div>`).join("");
      const lineageLink = el("a", { onclick: () => { document.querySelectorAll(".panel-overlay").forEach((o) => o.remove()); location.hash = "#/masters"; } }, full.template_name);
      const panelOverlay = el("div", { class: "panel-overlay" });
      const panel = el("div", { class: "slide-panel" }, [
        el("button", { class: "close", onclick: () => panelOverlay.remove() }, "✕"),
        el("div", { class: "folder-name-row" }, [el("h2", { style: "margin:0;" }, full.name), statusTagEl(full.status)]),
        el("div", { class: "sub" }, `Drafted ${new Date(full.created_at).toLocaleString()}`),
        partiesLineEl(full.parties),
        el("div", { class: "lineage-box" }, [
          el("div", { class: "txt" }, ["Originated from master document", el("br"), lineageLink]),
        ]),
        el("div", {}, valuesHtml ? el("div", { html: valuesHtml }) : el("div", { style: "color:var(--muted);font-size:13px;" }, "No field values recorded.")),
        el("div", { class: "panel-actions" }, [
          el("a", { class: "btn", href: `/api/generated/${d.id}/download` }, "Download .docx"),
          // Close the panel before opening either modal -- .panel-overlay is
          // deliberately a higher z-index than .modal-overlay (so a detail
          // panel always sits above a modal opened from elsewhere), which
          // means leaving it open here would stack it ON TOP of Redlines/
          // Share's own modal and physically cover their Close button --
          // clicking it would hit the panel's slide-out underneath, not the
          // button, with no visible sign why. This is what "Preview
          // document" below already does correctly.
          el("button", { class: "btn secondary", onclick: () => { panelOverlay.remove(); openShareModal(d.id); } }, "Share for review"),
          el("button", { class: "btn secondary", onclick: () => { panelOverlay.remove(); openRedlinesModal(d.id); } }, "Redlines"),
          el("button", {
            class: "btn secondary",
            onclick: () => {
              panelOverlay.remove();
              showPreviewOverlay({
                title: full.name, subtitle: full.document_type, html: full.html, generatedId: full.id,
                editable: true, onEdited: () => load(),
              });
            },
          }, "Preview document"),
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
    resetBtn.disabled = true;
    resetBtn.textContent = "Resetting...";
    try {
      const data = await api(`/api/templates/${templateId}/reset`, { method: "POST" });
      contractView.innerHTML = data.html;
      loadPlaceholders();
    } catch (e) {
      alert(e.message);
    } finally {
      resetBtn.disabled = false;
      resetBtn.textContent = "Start over (remove all marks)";
    }
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
        el("label", { class: "field-label", style: "margin-bottom:10px;" }, "This text is..."),
        fieldSelect,
        el("div", { style: "font-size:12px;color:var(--muted);margin:8px 0 14px;" }, "Pick an existing field if this is another spot for something you already marked (e.g. a name that appears twice) — filling it once fills every spot."),
        newFieldBlock
      );
    } else {
      modalChildren.push(...newFieldFields);
    }

    const saveBtn = el("button", { class: "btn", onclick: submit }, "Save");
    modalChildren.push(
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"),
        saveBtn,
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
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
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
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
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

function fmtRelativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return fmtShortDate(iso);
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

// Running list from the full-flow audit (Aug 17, 2026). Kept in sync by
// hand as items get fixed or new ones surface -- not derived from live
// data, just a convenient place for the account owner to see engineering
// status without leaving the product. Mirrors the same list kept in the
// attached Claude project.
const BUG_TRACKER = {
  fixed: [
    { id: "F1", title: "“response_acknowledged” notification fired on every client visit, too much email volume", fix: "Removed the notification (bell + email); underlying “seen” tracking kept" },
    { id: "F2", title: "Applying redlines silently dropped accepted-but-unapplied edits from an earlier submission on the same link", fix: "Apply now sweeps in and folds in any other decided-but-unapplied sibling submission" },
    { id: "F3", title: "Client accepting a sender’s counter forced the owner to re-review it as a brand-new redline", fix: "New submissions can reference the countered edit they’re accepting; validated and auto-marked decided" },
    { id: "F4", title: "Double-clicking “Generate” created two separate documents from one action", fix: "Button disables while in flight; server also dedupes identical requests within 15s" },
    { id: "#2", title: "Deleting a master template destroyed every contract ever generated from it", fix: "The generated/ folder is preserved and file paths repointed before the template is deleted" },
    { id: "#3", title: "Archiving a document didn’t close its live share link, letting a client revive it with a new active revision", fix: "Archiving now closes the family’s share link; new revisions inherit the source’s archived state" },
    { id: "#4", title: "An older revision’s status badge wrongly reverted to “Draft” once a later revision was shared/applied", fix: "Status lookup now matches the whole lineage family, not just the exact document a link points at" },
    { id: "#5", title: "Responding to only some edits in a redline round permanently stranded the rest", fix: "Decision controls stay available for any edit still pending, regardless of prior partial responses" },
    { id: "#6", title: "Deleting a generated contract quietly freed up monthly plan quota", fix: "Usage is now computed from an immutable generation log, not currently-existing documents" },
    { id: "#1", title: "Counter-acceptance tracking was lost on Save-progress → resume → Submit", fix: "Added a column that remembers which countered edit an acceptance resolves, so it survives a save/resume round-trip; verified end-to-end" },
    { id: "F5", title: "Critical: table cells could silently vanish from rendering, marking, redlining, AND value substitution at generation time", fix: "Table-cell dedup keyed on a transient object's id(), which CPython could reuse for a different cell -- reproduced on a plain 2x2 table, a real contract could have shipped with an unreplaced {{token}}. Now keyed on the element itself" },
    { id: "#13", title: "Redline location format disagreed between what's stored and what a resubmit expects, only on table-cell fields", fix: "Reproduced: accepting a counter on a table field corrupted the document's opening sentence instead of the table cell. Server now converts the location correctly before handing it to the client" },
    { id: "#7", title: "Plan-limit check ran before the duplicate-request check in Generate", fix: "Dedup now runs first, before any file is generated, so a legitimate retry at your monthly cap succeeds instead of erroring (also stopped orphaning a file on every dedup hit)" },
    { id: "#8", title: "Redlines on a closed-then-reissued share link became invisible to the owner", fix: "Owner's redlines view now spans every link the document's lineage has ever had, not just the most recent" },
    { id: "#9", title: "No UI way for an owner to close/revoke a share link", fix: "Added a “Close review link” button to the Share modal" },
    { id: "#10", title: "Un-marking a placeholder field baked the field's label text into the document", fix: "The actual original text is now captured at mark-time and restored on un-mark" },
    { id: "#11", title: "A couple of share-page panels had no error handling and could spin forever", fix: "Both panels now show an error message with a Retry button instead of hanging on “Loading...”" },
    { id: "#12", title: "No autosave or refresh warning on the client share page", fix: "Added a beforeunload warning whenever a suggestion, comment, note, or accepted counter is sitting unsaved" },
    { id: "#15", title: "No file-size cap on template uploads", fix: "Uploads over 20MB are now rejected -- checked via Content-Length up front and again while streaming to disk, with cleanup on a rejected upload" },
    { id: "#16", title: "A few lower-risk buttons had no double-click guard or error handling", fix: "Mark-placeholder Save, delete template, and reset template now disable with an in-progress label during the request, and restore themselves with an error message on failure" },
    { id: "F6", title: "Critical: applying an accepted-but-not-yet-applied redline could silently overwrite the wrong text", fix: "Only in-bounds offsets were checked, not that the text there still matched -- an intervening direct edit or applied round on the same paragraph could leave stale offsets in range but pointing at different text. Reproduced live (produced garbled “Gamma HoldingsLC” with zero error). Apply now re-checks the current text matches what was recorded before splicing, and blocks with a clear error if it doesn't" },
    { id: "#18", title: "Countered-redline highlight underlined the whole sentence, not just the changed word", fix: "The indicator was applied to the whole .run element, but a run can span an entire clause with no formatting break -- now scoped to just the changed word's del/ins spans" },
    { id: "Phase 1", title: "Redline overhaul, phase 1 of 4: share links didn't require a real client identity", fix: "A share link now requires the client's first name, last name, and email before it can be created (existing links untouched). Client gets emailed the link + access code when a NEW link is created; review page now shows “Editing as: {Full Name} (email)”. Foundation for phases 2-4 below." },
  ],
  open: [
    { id: "#14", priority: "P3", title: "No rate limit on share-link access-code attempts", detail: "Reviewed and intentionally left open -- not considered important enough to prioritize right now." },
    { id: "#19", priority: "BUILDING", title: "A rejection is a dead end for the owner once the client pushes back with a comment", detail: "Decided: Phase 3 (reconsider flow) -- resend just the reconsidered edit(s) as a new round, everything else in that round stands as already-approved, client notified by email. Blocked on Phase 1 (shipped)." },
    { id: "#20", priority: "BUILDING", title: "Resubmitting after rejecting a counter loses the negotiation context", detail: "Decided: Phase 3 -- a visible chain linking the resubmission back to the original counter, for transparency and tracking." },
    { id: "#21", priority: "BUILDING", title: "Doing nothing about a counter is silently treated as accepting it", detail: "Decided: Phase 4 -- Finalize and submit becomes a hard block until every counter has an explicit decision (Save progress stays unblocked), plus an “N unresolved” badge on the document dashboard/list view." },
    { id: "#22", priority: "BUILDING", title: "A declined redline with a client's pushback comment has no reply path at all", detail: "Decided: Phase 2 -- an open comment thread on any redline, Google-Docs-suggest-edit-style, with real names (needs Phase 1, shipped), independent resolve state, auto- and manual-reopen, no per-reply email." },
  ],
};

function buildBugTrackerCard() {
  const card = el("div", { class: "card bug-tracker-card" });
  card.appendChild(el("div", { class: "chart-title" }, "Bug tracker"));
  card.appendChild(
    el(
      "p",
      { class: "subtitle", style: "margin:-6px 0 14px;" },
      `From the full-flow audit — ${BUG_TRACKER.fixed.length} fixed & shipped, ${BUG_TRACKER.open.length} open. Kept in sync by hand, not derived from live data.`
    )
  );

  const priorityOrder = ["P0", "P1", "P2", "P3", "DECISION", "BUILDING"];
  const priorityLabels = {
    P0: "P0 — fix next", P1: "P1", P2: "P2 — real bugs, lower stakes", P3: "P3 — minor / hardening",
    DECISION: "Needs a product decision, not a bug fix",
    BUILDING: "Decided — building now (4-phase plan, phase 1 shipped)",
  };
  const toneByPriority = { P0: "critical", P1: "pending", P2: "pending", P3: "draft", DECISION: "draft", BUILDING: "pending" };

  const bugRow = (idTone, idLabel, title, detail) =>
    el("div", { class: "bug-row" }, [
      el("span", { class: "status-tag " + idTone }, idLabel),
      el("div", { class: "bug-row-body" }, [
        el("div", { class: "bug-row-title" }, title),
        detail ? el("div", { class: "bug-row-detail" }, detail) : null,
      ]),
    ]);

  priorityOrder.forEach((p) => {
    const items = BUG_TRACKER.open.filter((it) => it.priority === p);
    if (!items.length) return;
    card.appendChild(el("div", { class: "bug-group-label" }, priorityLabels[p]));
    items.forEach((it) => card.appendChild(bugRow(toneByPriority[p], it.id, it.title, it.detail)));
  });

  card.appendChild(el("div", { class: "bug-group-label" }, "Fixed & shipped"));
  BUG_TRACKER.fixed.forEach((it) => card.appendChild(bugRow("final", it.id, it.title, it.fix)));

  return card;
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
    body.appendChild(buildManageUsersCard());
    body.appendChild(buildBugTrackerCard());
  }).catch((e) => {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "error-box" }, e.message || "Failed to load admin data."));
  });

  return wrap;
}

function showTempPasswordModal(user, password, emailed) {
  const overlay = el("div", { class: "modal-overlay" });
  const modalBody = el("div", {}, [
    el(
      "p",
      { class: "subtitle" },
      emailed
        ? `A new password was emailed to ${user.email}. It's also shown below in case that doesn't arrive.`
        : `Email sending isn't configured on this deploy, so relay this password to ${user.email} yourself.`
    ),
    el("div", { class: "share-info-box" }, [
      el("div", { class: "row" }, [
        el("div", { style: "min-width:0;" }, [el("div", { class: "k" }, "Temporary password"), el("div", { class: "v mono" }, password)]),
        el("button", { class: "btn secondary small copy-btn", onclick: (e) => copyToClipboard(password, e.currentTarget) }, "Copy"),
      ]),
    ]),
    el("div", { style: "font-size:12px;color:var(--muted);margin-top:10px;" }, "This won't be shown again — copy it now if you need it."),
  ]);
  const modal = el("div", { class: "modal" }, [
    el("h2", {}, "Password reset"),
    modalBody,
    el("div", { class: "modal-actions" }, [el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Close")]),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function buildManageUsersCard() {
  const card = el("div", { class: "card" });
  card.appendChild(el("div", { class: "chart-title" }, "Manage users"));
  const tableWrap = el("div", { class: "admin-table" }, [el("div", { class: "empty-state" }, "Loading...")]);
  card.appendChild(tableWrap);

  const planLabels = { starter: "Starter", pro: "Pro", unlimited: "Unlimited" };

  function refresh() {
    api("/api/admin/users")
      .then((data) => {
        tableWrap.innerHTML = "";
        tableWrap.appendChild(
          el("div", { class: "admin-table-row manage header" }, [
            el("div", {}, "User"),
            el("div", {}, "Plan"),
            el("div", {}, "Verified"),
            el("div", {}, "Status"),
            el("div", {}, "Actions"),
          ])
        );
        data.users.forEach((u) => {
          const isSelf = !!(state.user && u.email === state.user.email);

          const planSelect = el(
            "select",
            { class: "filter-select" },
            Object.keys(planLabels).map((k) => el("option", { value: k }, planLabels[k]))
          );
          planSelect.value = u.plan;
          planSelect.addEventListener("change", async () => {
            const prev = u.plan;
            planSelect.disabled = true;
            try {
              await api(`/api/admin/users/${u.id}/plan`, { method: "POST", body: { plan: planSelect.value } });
              u.plan = planSelect.value;
            } catch (e) {
              alert(e.message);
              planSelect.value = prev;
            }
            planSelect.disabled = false;
          });

          const verifiedCell = el("div", {}, [
            el("span", { class: `status-dot ${u.email_verified ? "good" : "bad"}`, style: "display:inline-block;margin-right:6px;" }),
            el("span", {}, u.email_verified ? "Verified" : "Unverified"),
          ]);
          if (!u.email_verified) {
            const resendBtn = el("button", { class: "btn ghost small", style: "margin-left:6px;" }, "Resend");
            resendBtn.addEventListener("click", async () => {
              resendBtn.disabled = true;
              resendBtn.textContent = "Sending...";
              try {
                const r = await api(`/api/admin/users/${u.id}/resend-verification`, { method: "POST" });
                resendBtn.textContent = r.sent ? "Sent" : "Already verified";
              } catch (e) {
                alert(e.message);
                resendBtn.disabled = false;
                resendBtn.textContent = "Resend";
              }
            });
            verifiedCell.appendChild(resendBtn);
          }

          const statusCell = el("div", {}, [
            el("span", { class: `status-dot ${u.is_suspended ? "bad" : "good"}`, style: "display:inline-block;margin-right:6px;" }),
            el("span", {}, u.is_suspended ? "Suspended" : "Active"),
          ]);
          if (!isSelf) {
            const toggleBtn = el("button", { class: "btn ghost small", style: "margin-left:6px;" }, u.is_suspended ? "Reactivate" : "Suspend");
            toggleBtn.addEventListener("click", async () => {
              const next = !u.is_suspended;
              if (next && !confirm(`Suspend ${u.email}? They'll be logged out immediately and can't log back in until reactivated.`)) return;
              toggleBtn.disabled = true;
              try {
                await api(`/api/admin/users/${u.id}/suspend`, { method: "POST", body: { suspended: next } });
                refresh();
              } catch (e) {
                alert(e.message);
                toggleBtn.disabled = false;
              }
            });
            statusCell.appendChild(toggleBtn);
          }

          const actionsCell = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap;" });
          const resetBtn = el("button", { class: "btn secondary small" }, "Reset password");
          resetBtn.addEventListener("click", async () => {
            if (!confirm(`Set a new temporary password for ${u.email}? Their current password stops working immediately.`)) return;
            resetBtn.disabled = true;
            try {
              const r = await api(`/api/admin/users/${u.id}/reset-password`, { method: "POST" });
              showTempPasswordModal(u, r.temporary_password, r.emailed);
            } catch (e) {
              alert(e.message);
            }
            resetBtn.disabled = false;
          });
          actionsCell.appendChild(resetBtn);
          if (!isSelf) {
            const deleteBtn = el("button", { class: "btn danger small" }, "Delete");
            deleteBtn.addEventListener("click", async () => {
              if (!confirm(`Permanently delete ${u.email}? This deletes their master documents, generated contracts, and share links, and can't be undone.`)) return;
              deleteBtn.disabled = true;
              try {
                await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
                refresh();
              } catch (e) {
                alert(e.message);
                deleteBtn.disabled = false;
              }
            });
            actionsCell.appendChild(deleteBtn);
          }

          tableWrap.appendChild(
            el("div", { class: "admin-table-row manage" }, [
              el("div", {}, [
                el("div", { style: "font-weight:600;" }, u.name || u.email),
                el("div", { style: "color:var(--muted-soft);font-size:12px;" }, u.email),
              ]),
              el("div", {}, [planSelect]),
              verifiedCell,
              statusCell,
              actionsCell,
            ])
          );
        });
      })
      .catch((e) => {
        tableWrap.innerHTML = "";
        tableWrap.appendChild(el("div", { class: "error-box" }, e.message || "Failed to load users."));
      });
  }

  refresh();
  return card;
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

  if (!state.user && !hash.startsWith("#/login") && !hash.startsWith("#/register") && !hash.startsWith("#/reset-password")) {
    render(shell(AuthView("login")));
    return;
  }
  if (state.user && (hash.startsWith("#/login") || hash.startsWith("#/register") || hash === "#/" || hash === "")) {
    location.hash = "#/draft";
    return;
  }

  if (hash.startsWith("#/reset-password")) return render(shell(ResetPasswordView()));
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
