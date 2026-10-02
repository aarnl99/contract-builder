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

// Bug tracker #36: the one place every view swap in this app funnels
// through (hashchange -> router() -> render(), but also a couple of direct
// router() calls elsewhere, e.g. after a plan change -- see router()'s own
// callers), so it's also the one correct place to tear down anything a view
// attached OUTSIDE its own root element (document-level listeners, nodes
// appended straight to document.body) that app.innerHTML = "" below won't
// reach on its own. Optional and additive: a view that doesn't need this
// just omits the second argument, exactly as every existing render(view)
// call site already does.
let _currentViewTeardown = null;

function render(view, teardown) {
  if (_currentViewTeardown) {
    try { _currentViewTeardown(); } catch (e) { /* best-effort cleanup */ }
  }
  _currentViewTeardown = teardown || null;
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
      try {
        await api("/api/account/plan", { method: "POST", body: { plan: p.key } });
        const meRes = await api("/api/me");
        state.plan = meRes.plan;
        dd.remove();
        router();
      } catch (e) {
        alert(e.message || "Couldn't change your plan. Please try again.");
      }
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
          try {
            const res = await api("/api/account/email-alias/regenerate", { method: "POST" });
            paintAliasRow(res.address);
          } catch (e) {
            alert(e.message || "Couldn't regenerate your drafting email address. Please try again.");
          }
        },
      }, "Regenerate")
    );
    emailValueRow.appendChild(btnRow);
  }
  function loadEmailAlias() {
    emailValueRow.innerHTML = "";
    emailValueRow.appendChild(el("span", { style: "font-size:11.5px;color:var(--muted);" }, "Loading..."));
    api("/api/account/email-alias")
      .then((res) => paintAliasRow(res.address))
      .catch((e) => {
        // Same reasoning as share.js's loadRedlineHistory/loadHistory --
        // without this, a failed request left "Loading..." here forever
        // with no error and no way to try again.
        emailValueRow.innerHTML = "";
        emailValueRow.appendChild(el("div", { class: "error-box" }, e.message || "Couldn't load your drafting email address."));
        const retryBtn = el("button", { class: "btn secondary small", style: "margin-top:6px;" }, "Retry");
        retryBtn.addEventListener("click", loadEmailAlias);
        emailValueRow.appendChild(retryBtn);
      });
  }
  loadEmailAlias();

  // ---- notification settings: per-type opt-out. redline_submitted still
  // gates both the bell and a matching email; redline_comment now only
  // gates the in-app bell -- comment-thread replies (Phase 2 of the
  // redline-negotiation overhaul) never send email, on any redline, not
  // just a declined one. Each toggle saves immediately on change (same
  // pattern as the plan row above), no separate save step. ----
  const notifRow = el("div", { class: "plan-row" });
  notifRow.appendChild(el("div", { class: "label" }, "Notifications"));
  const NOTIF_TOGGLES = [
    { key: "redline_submitted", label: "Someone sends redlines" },
    { key: "redline_comment", label: "Client comments on a redline" },
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
  function loadNotifSettings() {
    notifList.innerHTML = "";
    notifList.appendChild(el("span", { style: "font-size:11.5px;color:var(--muted);" }, "Loading..."));
    api("/api/account/notification-settings")
      .then((res) => paintNotifToggles(res))
      .catch((e) => {
        notifList.innerHTML = "";
        notifList.appendChild(el("div", { class: "error-box" }, e.message || "Couldn't load notification settings."));
        const retryBtn = el("button", { class: "btn secondary small", style: "margin-top:6px;" }, "Retry");
        retryBtn.addEventListener("click", loadNotifSettings);
        notifList.appendChild(retryBtn);
      });
  }
  loadNotifSettings();

  const logoutRow = el("div", { class: "logout-row" }, [el("button", { onclick: doLogout }, "Log out")]);
  dd.appendChild(logoutRow);

  window.__avatarWrap.appendChild(dd);
  setTimeout(() => {
    // mousedown, not click -- a click on something inside dd that removes
    // ITSELF synchronously (e.g. the email-alias/notification-settings
    // Retry buttons above, which clear their row's innerHTML before
    // re-fetching) leaves e.target already detached from the document by
    // the time a "click" listener here would run in the bubble phase, so
    // dd.contains(e.target) on a detached node always reads false --
    // misreading a click INSIDE the dropdown as outside it and closing the
    // whole thing out from under the person mid-retry. mousedown fires
    // before any of that same-click DOM mutation happens, so it still sees
    // the real ancestry.
    document.addEventListener("mousedown", function onDocMousedown(e) {
      if (!dd.contains(e.target) && e.target !== window.__avatarWrap) {
        dd.remove();
        document.removeEventListener("mousedown", onDocMousedown);
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
    // mousedown, not click -- see the matching comment in toggleAvatarMenu's
    // own outside-dismissal listener for why.
    document.addEventListener("mousedown", function onDocMousedown(e) {
      if (!dd.contains(e.target) && e.target !== window.__notifWrap && !window.__notifWrap.contains(e.target)) {
        dd.remove();
        document.removeEventListener("mousedown", onDocMousedown);
      }
    });
  }, 0);
}

async function doLogout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch (e) {
    // Still log out locally even if invalidating the server-side session
    // failed (e.g. a network blip) -- the alternative before this was
    // clicking "Log out" and silently staying logged in with no error and
    // no visible sign anything happened at all.
  }
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
  api("/api/me")
    .then((me) => {
      state.plan = me.plan;
      state.isAdmin = !!me.is_admin;
      const newBar = topbar();
      oldBar.replaceWith(newBar);
    })
    // Opportunistic in-place refresh (e.g. after a plan change elsewhere) --
    // on failure the existing topbar just stays as it was, same as before
    // this ever ran. Nothing here shows a "Loading..." state that could get
    // stuck, so a silent catch (rather than an error UI) is the right
    // amount of handling -- this only stops an unhandled-rejection warning.
    .catch(() => {});
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

function _findParaEl(container, tablePath, pIndex) {
  const paras = container.querySelectorAll(".para");
  for (const p of paras) {
    if (parseInt(p.dataset.p, 10) === pIndex && (p.dataset.path || "") === (tablePath || "")) return p;
  }
  return null;
}

// Short human-readable summary of one staged direct edit, for the pending-
// changes list below the preview -- an insert reads as "Insert: ...", a
// replace as "original" → "new".
function _describeStagedEdit(e) {
  const shorten = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
  if (e.segments.every((s) => s.start === s.end)) {
    return "Insert: " + shorten(e.new_text.trim(), 60);
  }
  return `"${shorten((e.originalText || "").trim(), 30)}" → "${shorten(e.new_text.trim(), 30)}"`;
}

function showPreviewOverlay({ title, subtitle, html, generatedId, extraButtons, editable, onEdited }) {
  const overlay = el("div", { class: "modal-overlay" });
  const box = el("div", { class: "modal", style: "width:720px;" });

  // Multiple direct edits are staged locally here and only sent to the
  // server as one batch, via the "Save changes" button below -- see
  // DirectEditsBody in main.py. Before this (ad hoc user report: "you
  // should be able to see everything live first, in case you want to do
  // more than one, and THEN get the opportunity to submit it"), every
  // click posted its own edit immediately, one at a time.
  const staged = [];
  let stagedSeq = 0;
  const pristineHtml = html || "<p style='color:var(--muted);'>No preview available.</p>";

  const closeOverlay = () => {
    if (staged.length && !confirm(`You have ${staged.length} unsaved change${staged.length === 1 ? "" : "s"} that will be lost. Close anyway?`)) return;
    overlay.remove();
  };

  const headerRow = el("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;" }, [
    el("div", {}, [el("h2", {}, title), subtitle ? el("p", { class: "subtitle", style: "margin:2px 0 0;" }, subtitle) : null]),
    el("button", { class: "btn ghost small", onclick: () => closeOverlay() }, "Close"),
  ]);
  box.appendChild(headerRow);

  if (editable && generatedId) {
    // Phase 5 (#23): once a document is shared, a direct edit is no longer
    // instant -- it's queued as a redline the client has to approve, same
    // as the copy in showResult/openDetail's confirmation below. Click-to-
    // insert (no selection needed) added right after Phase 5 shipped, once
    // it was clear "select something to edit it" left no way to just add
    // new text -- see computeCursorPosition.
    box.appendChild(el("p", { style: "font-size:12.5px;color:var(--muted);margin:-8px 0 10px;" }, "Select text to edit it, or click anywhere to insert something new. Stage as many changes as you like, then save them all at once -- applied instantly as one new revision if this document hasn't been shared yet, or sent to the client for approval if it has."));
  }

  const preview = el("div", { class: "contract-view compact", style: "max-height:52vh;overflow-y:auto;" });
  preview.innerHTML = pristineHtml;
  box.appendChild(preview);

  const stagedBar = el("div", { style: "display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);" });
  box.appendChild(stagedBar);

  if (editable && generatedId) {
    // Rebuilds the preview from the pristine (server-rendered) HTML, then
    // splices every staged edit's fv-del/fv-ins decoration back in -- the
    // exact same pattern share.js's repaint() uses to show a client their
    // pending redlines in place, in the actual document text, rather than
    // only in a separate list. Reusing .fv-del/.fv-ins here (not a new
    // class) is deliberate: it's already styled, and an in-progress owner
    // edit reads the same way an already-applied one does elsewhere.
    function repaintStaged() {
      preview.innerHTML = pristineHtml;
      const byPara = {};
      staged.forEach((e) => {
        const pk = `${e.table_path || ""} ${e.paragraph_index}`;
        (byPara[pk] = byPara[pk] || []).push(e);
      });
      Object.entries(byPara).forEach(([pk, list]) => {
        const sp = pk.lastIndexOf(" ");
        const tablePath = pk.slice(0, sp);
        const pIdx = parseInt(pk.slice(sp + 1), 10);
        const paraEl = _findParaEl(preview, tablePath, pIdx);
        if (!paraEl) return;
        const runEls = Array.from(paraEl.querySelectorAll(".run"));
        const byRun = {};
        list.forEach((e) => {
          e.segments.forEach((seg) => {
            (byRun[seg.r] = byRun[seg.r] || []).push({ seg, e });
          });
        });
        const seen = new Set();
        Object.entries(byRun).forEach(([rIdxStr, segEdits]) => {
          const runEl = runEls[parseInt(rIdxStr, 10)];
          if (!runEl) return;
          segEdits.sort((a, b) => a.seg.start - b.seg.start);
          const text = runEl.textContent;
          const frag = document.createDocumentFragment();
          let cursor = 0;
          segEdits.forEach(({ seg, e }) => {
            if (seg.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, seg.start)));
            if (seg.start < seg.end) {
              frag.appendChild(el("span", { class: "fv-del", "data-staged-id": String(e.localId) }, text.slice(seg.start, seg.end)));
            }
            // A multi-run edit (a drag-selection spanning several runs)
            // shares one new_text across all its segments -- only show it
            // once, at the first run it touches, not once per run.
            if (!seen.has(e)) {
              frag.appendChild(el("span", { class: "fv-ins", "data-staged-id": String(e.localId) }, e.new_text || "(blank)"));
              seen.add(e);
            }
            cursor = Math.max(cursor, seg.end);
          });
          if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
          runEl.innerHTML = "";
          runEl.appendChild(frag);
        });
      });
      renderStagedBar();
    }

    function renderStagedBar() {
      stagedBar.innerHTML = "";
      if (!staged.length) { stagedBar.style.display = "none"; return; }
      stagedBar.style.display = "";
      const list = el("div", { style: "display:flex;flex-direction:column;gap:6px;margin-bottom:10px;" });
      staged.forEach((e) => {
        const removeBtn = el("span", { class: "staged-edit-remove" }, "Remove");
        removeBtn.addEventListener("click", () => {
          const idx = staged.indexOf(e);
          if (idx !== -1) staged.splice(idx, 1);
          repaintStaged();
        });
        list.appendChild(
          el("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12.5px;background:var(--panel-2, var(--panel));border:1px solid var(--border);border-radius:6px;padding:6px 10px;" }, [
            el("div", { style: "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" }, _describeStagedEdit(e)),
            removeBtn,
          ])
        );
      });
      stagedBar.appendChild(list);
      const errBox = el("div");
      const saveBtn = el("button", { class: "btn" }, `Save ${staged.length} change${staged.length === 1 ? "" : "s"}`);
      saveBtn.addEventListener("click", async () => {
        errBox.innerHTML = "";
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";
        try {
          const editRes = await api(`/api/generated/${generatedId}/edit`, {
            method: "POST",
            body: {
              edits: staged.map((e) => ({
                table_path: e.table_path,
                paragraph_index: e.paragraph_index,
                segments: e.segments,
                new_text: e.new_text,
              })),
            },
          });
          overlay.remove();
          if (editRes.queued_for_approval) {
            // Document is shared -- see edit_generated_document. Nothing
            // changed yet; the client has to approve it first.
            const n = staged.length;
            alert(`Sent ${n} change${n === 1 ? "" : "s"} to the client for approval -- ${n === 1 ? "it'll" : "they'll"} apply once accepted.`);
          }
          if (typeof onEdited === "function") onEdited(editRes);
        } catch (e2) {
          errBox.appendChild(el("div", { class: "error-box" }, e2.message));
          saveBtn.disabled = false;
          saveBtn.textContent = `Save ${staged.length} change${staged.length === 1 ? "" : "s"}`;
        }
      });
      stagedBar.appendChild(errBox);
      stagedBar.appendChild(el("div", { style: "display:flex;justify-content:flex-end;" }, saveBtn));
    }

    let activePopover = null;
    // Reported bug: clicking to insert opened a popover with no visible
    // anchor in the document itself -- you typed into a floating box with
    // no way to see where, exactly, the new text would land relative to
    // the surrounding words. activeMarker is a live ghost-text span
    // spliced into the document AT the click point (see range.insertNode
    // below); the textarea's input mirrors into it as you type, so the
    // insertion is visible in place, in context, the whole time. It's
    // distinct from a staged edit's own fv-ins decoration (see
    // repaintStaged) -- this one only exists while THIS popover is open,
    // and is discarded (not staged) on Cancel.
    let activeMarker = null;
    const closePop = () => {
      if (activePopover) { activePopover.remove(); activePopover = null; }
      if (activeMarker) { activeMarker.remove(); activeMarker = null; }
    };
    preview.addEventListener("mouseup", () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (!preview.contains(range.commonAncestorContainer)) return;
        // A drag (real selection) edits/replaces that text; a plain click
        // (collapsed selection) inserts new text at that point instead --
        // see computeCursorPosition. Both post to the same endpoint; the
        // only difference is a zero-width vs. a real segment.
        const isInsert = sel.isCollapsed;
        const rect = range.getBoundingClientRect();
        const info = isInsert ? computeCursorPosition(preview) : computeSelectionSegments(preview);
        sel.removeAllRanges();
        if (!info) return;
        if (info.error === "cross-paragraph") { alert("Please select text within a single paragraph."); return; }
        if (info.error === "inside-pending-edit") { alert("That's part of a change you've already staged below -- remove it first if you want to change that spot again."); return; }
        closePop();
        // Splice the ghost marker in at the exact click point BEFORE the
        // popover is built -- range is still a live, valid Range (clearing
        // the Selection above doesn't invalidate Ranges obtained from it),
        // and it's still collapsed to the click position since nothing has
        // mutated the DOM yet.
        let marker = null;
        if (isInsert) {
          marker = document.createElement("span");
          marker.className = "insert-ghost-marker";
          try { range.insertNode(marker); } catch (e) { marker = null; }
          activeMarker = marker;
        }
        const input = el("textarea", { rows: "2", placeholder: isInsert ? "Type text to insert here..." : "" }, info.text);
        if (marker) {
          input.addEventListener("input", () => { marker.textContent = input.value; });
        }
        const errBox = el("div");
        const saveBtn = el("button", { class: "btn" }, isInsert ? "Insert" : "Stage edit");
        saveBtn.addEventListener("click", () => {
          errBox.innerHTML = "";
          if (isInsert && !input.value.trim()) {
            errBox.appendChild(el("div", { class: "error-box" }, "Type something to insert."));
            return;
          }
          if (!isInsert && input.value.trim() === (info.text || "").trim()) {
            errBox.appendChild(el("div", { class: "error-box" }, "That's already the current text."));
            return;
          }
          staged.push({
            localId: ++stagedSeq,
            table_path: info.table_path,
            paragraph_index: info.paragraph_index,
            segments: info.segments,
            new_text: input.value,
            originalText: info.text || "",
          });
          closePop();
          // repaintStaged() rebuilds the preview from pristineHtml and
          // reapplies every staged edit's decoration -- including the one
          // just pushed above, so the ghost marker's job is done the
          // moment this fires; it's already been removed by closePop().
          repaintStaged();
        });
        const pop = el("div", { class: "redline-popover" }, [
          el("div", { class: "rp-label" }, isInsert ? "Insert text" : "Edit text"),
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
  actions.appendChild(el("button", { class: "btn secondary", onclick: () => closeOverlay() }, "Close"));
  box.appendChild(actions);

  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(); });
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
      try {
        await api(`/api/generated/${generatedId}/share`, {
          method: "POST",
          body: {
            client_first_name: firstNameInput.value.trim(), client_last_name: lastNameInput.value.trim(),
            client_email: emailInput.value.trim(), sender_email: senderInput.value.trim(),
          },
        });
        noteEl.style.display = "inline";
        setTimeout(() => (noteEl.style.display = "none"), 1500);
      } catch (e) {
        // Without this, an edit here (e.g. correcting the client's email)
        // that failed to save left "Saved" simply never appearing, with no
        // error to explain why -- easy to miss and go on to share the link
        // still pointed at the old, unsaved value.
        alert(e.message || "Couldn't save that change. Please try again.");
      }
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

// ---------------------------------------------------------------------------
// E-signature: send a finished document out through DocuSeal for signing.
// Mirrors openShareModal's shape (intake form -> created-state view) but for
// /api/generated/{id}/signature-request instead of /share. See the
// e-signature design notes for why this is scoped to exactly two roles
// ("Client", always, and "Sender", the account owner's own business,
// optional) rather than an arbitrary signer list.
// ---------------------------------------------------------------------------

async function openSignatureModal(generatedId) {
  document.querySelectorAll(".panel-overlay").forEach((o) => o.remove());
  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", {}, el("p", { class: "subtitle" }, "Loading..."));
  const modal = el("div", { class: "modal" }, [el("h2", {}, "Send for signature"), body]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function statusLabel(s) {
    return { awaiting_consent: "Awaiting consent", ready_to_sign: "Ready to sign", completed: "Signed", declined: "Declined" }[s] || s;
  }

  function renderStatusView(sr) {
    body.innerHTML = "";
    body.appendChild(el("p", { class: "subtitle" }, "Sent through DocuSeal. Each signer first agrees to a quick photo step on Rotely's own page before reaching the actual signing form."));
    const list = el("div", { class: "share-info-box" });
    sr.signers.forEach((s) => {
      const linkUrl = `${location.origin}${s.sign_url}`;
      list.appendChild(
        el("div", { class: "row" }, [
          el("div", { style: "min-width:0;" }, [
            el("div", { class: "k" }, `${s.name} (${s.role})`),
            el("div", { class: "v" }, `${statusLabel(s.status)}${s.status === "awaiting_consent" || s.status === "ready_to_sign" ? " -- " + linkUrl : ""}`),
          ]),
          s.status !== "completed" ? el("button", { class: "btn secondary small copy-btn", onclick: (e) => copyToClipboard(linkUrl, e.currentTarget) }, "Copy link") : null,
        ])
      );
    });
    body.appendChild(list);

    const actions = [];
    if (sr.status === "pending") {
      actions.push(
        el(
          "button",
          {
            class: "btn danger",
            onclick: async (e) => {
              if (!confirm("Cancel this signature request? Signers will no longer be able to sign it.")) return;
              const btn = e.currentTarget;
              btn.disabled = true;
              try {
                await api(`/api/generated/${generatedId}/signature-request/cancel`, { method: "POST" });
                overlay.remove();
              } catch (err) {
                btn.disabled = false;
                alert(err.message);
              }
            },
          },
          "Cancel request"
        )
      );
    }
    if (sr.signed_document_available) {
      actions.push(
        el("a", { class: "btn", href: `/api/generated/${generatedId}/signature-request/download` }, "Download signed document")
      );
    }
    actions.push(el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Close"));
    body.appendChild(el("div", { class: "modal-actions" }, actions));
  }

  function renderIntakeForm() {
    body.innerHTML = "";
    const errBox = el("div", {});
    const nameInput = el("input", { type: "text", placeholder: "Jamie Rivera" });
    const emailInput = el("input", { type: "email", placeholder: "client@company.com" });
    const includeSender = el("input", { type: "checkbox" });
    const senderNameInput = el("input", { type: "text", placeholder: "Your name or business", style: "display:none;margin-top:8px;" });
    const senderEmailInput = el("input", { type: "email", placeholder: "you@company.com", style: "display:none;margin-top:8px;" });
    includeSender.addEventListener("change", () => {
      senderNameInput.style.display = includeSender.checked ? "block" : "none";
      senderEmailInput.style.display = includeSender.checked ? "block" : "none";
    });

    body.appendChild(
      el("div", { class: "form-row" }, [
        el("label", { class: "field-label" }, "Client's name and email"),
        nameInput,
        emailInput,
      ])
    );
    body.appendChild(
      el("div", { class: "form-row", style: "margin-top:14px;" }, [
        el("label", { style: "display:flex;gap:8px;align-items:center;cursor:pointer;" }, [includeSender, "Also require a signature from your side"]),
        senderNameInput,
        senderEmailInput,
      ])
    );
    body.appendChild(errBox);
    const sendBtn = el("button", { class: "btn", style: "margin-top:14px;" }, "Send for signature");
    sendBtn.addEventListener("click", async () => {
      errBox.innerHTML = "";
      const name = nameInput.value.trim(), email = emailInput.value.trim();
      if (!name || !email) {
        errBox.appendChild(el("div", { class: "error-box" }, "Enter the client's name and email."));
        return;
      }
      const reqBody = { client_name: name, client_email: email, include_sender: includeSender.checked };
      if (includeSender.checked) {
        reqBody.sender_name = senderNameInput.value.trim();
        reqBody.sender_email = senderEmailInput.value.trim();
      }
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending...";
      try {
        const sr = await api(`/api/generated/${generatedId}/signature-request`, { method: "POST", body: reqBody });
        renderStatusView(sr);
      } catch (err) {
        errBox.appendChild(el("div", { class: "error-box" }, err.message));
        sendBtn.disabled = false;
        sendBtn.textContent = "Send for signature";
      }
    });
    body.appendChild(
      el("div", { class: "modal-actions" }, [el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"), sendBtn])
    );
  }

  try {
    const existing = await api(`/api/generated/${generatedId}/signature-request`);
    if (existing.exists) {
      renderStatusView(existing);
    } else {
      renderIntakeForm();
    }
  } catch (e) {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "error-box" }, e.message));
  }
}

// ---------------------------------------------------------------------------
// Shared: open comment thread on a redline (owner side). Lightweight,
// Google-Docs-suggest-edit-style back-and-forth on ANY redline regardless of
// its accept/reject/counter decision -- see RedlineComment and the
// redline-negotiation overhaul notes. "Resolved" is independent of the
// decision: a thread can be resolved on a pending, accepted, rejected, or
// countered edit, and posting into a resolved thread auto-reopens it (the
// server does this; we just mirror the flag locally after each call).
// share.js has a near-identical copy for the client side -- kept in sync by
// hand, not shared code, since the two files have no module system between
// them and different api()/auth patterns.
// ---------------------------------------------------------------------------

function buildCommentThread(edit, { editPath, myAuthorType }) {
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
          el("div", { class: "comment-bubble " + (c.author_type === myAuthorType ? "mine" : "theirs") }, [
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

// "N unresolved" badge -- bug tracker #21 / phase 4. A countered redline
// the client hasn't explicitly accepted, rejected, or re-suggested yet
// (see main.py's _unresolved_counts); independent of Phase 2's separate
// comment-resolve state. Top-level (not nested in DocumentsView) since
// both the dashboard/list view and this Redlines modal use it.
function unresolvedBadgeEl(count) {
  if (!count) return null;
  return el("span", { class: "unresolved-badge" }, `${count} unresolved`);
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
          el("div", { class: "rch-title-row" }, [
            el("div", { class: "rch-title" }, data.header.name),
            unresolvedBadgeEl(data.unresolved_count),
          ]),
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
        // See RedlineSubmission.origin -- an owner_reconsideration round is
        // your own updated decision, already fully resolved the moment you
        // sent it, not a client submission awaiting review. An owner_edit
        // round (phase 5) is the opposite: you proposed something and it's
        // the CLIENT's decision to make, not yours -- its one edit arrives
        // already "countered" (see edit_generated_document), so it would
        // otherwise fall through to "Response sent" below, which is wrong.
        const statusLabel = sub.origin === "owner_reconsideration"
          ? "You reconsidered a decision"
          : sub.origin === "owner_edit"
          ? "Waiting on the client's decision"
          : sub.status === "reviewed"
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

          // See RedlineSubmission.origin -- an owner_edit row is the
          // owner's own proposal, arriving already "countered" (the owner
          // IS the counter, there's no client ask preceding it). Ad hoc
          // user report: "why would you need to reconsider your own text
          // that you just added -- you should just have the opportunity to
          // remove it instead." Unlike an ordinary decided edit, there's no
          // accept/reject/counter *decision* here to revisit -- only a
          // still-pending proposal to withdraw, while the client hasn't
          // yet responded to it (edit.superseded means they have, via the
          // same source_edit_id chaining reconsideration uses -- see #26).
          const isRemovableOwnerEdit = sub.origin === "owner_edit" && !edit.superseded;

          let actions;
          let reconsiderBox = null;
          if (isRemovableOwnerEdit) {
            const summaryEl = el("div", { class: "decided pending" }, "Proposed — awaiting the client's decision");
            const removeBtn = el("button", { class: "btn secondary small" }, "Remove");
            removeBtn.addEventListener("click", async () => {
              if (!confirm("Remove this change? The client will no longer see it.")) return;
              removeBtn.disabled = true;
              removeBtn.textContent = "Removing...";
              try {
                await api(`/api/redline-edits/${edit.id}/withdraw`, { method: "DELETE" });
                load();
              } catch (e) {
                removeBtn.disabled = false;
                removeBtn.textContent = "Remove";
                alert(e.message);
              }
            });
            actions = el("div", { class: "decision-row" }, [summaryEl, removeBtn]);
          } else if (already) {
            const summaryEl = edit.decision === "countered"
              ? el("div", { class: "decided-countered" }, ["Countered: ", el("strong", {}, edit.counter_value)])
              : el("div", { class: "decided " + edit.decision }, edit.decision);
            // See RedlineEdit.source_edit_id / apply_redline_submission's
            // superseded_edit_ids -- this edit's `decision` column is stale:
            // something newer (a reconsideration, or the client's own
            // response to a counter) has since chained back to it, and
            // that's what actually governs what Apply does now. Flagging it
            // here keeps this row from reading as "accepted and ready to
            // apply" when it no longer is.
            const supersededNote = edit.superseded
              ? el("div", { class: "decided pending", style: "font-size:11px;" }, "Superseded by a later decision below")
              : null;
            // #26: a superseded edit already has a newer reconsideration
            // chained to it (see the server-side guard in
            // reconsider_redline_edit) -- reconsidering it again would just
            // 400. Don't offer the button at all on a row that's already
            // been superseded; only the still-live row (the newest one in
            // the chain) gets a working Reconsider control.
            const reconsiderBtn = edit.superseded
              ? null
              : el("button", { class: "btn secondary small" }, "Reconsider");
            actions = el("div", { class: "decision-row" }, [summaryEl, supersededNote, reconsiderBtn]);

            // Reconsider: reopens accept/reject/counter controls for an
            // already-decided edit and sends the new decision as its own
            // scoped round -- see /api/redline-edits/{id}/reconsider and
            // #19 in the bug tracker. Before this, a decision (especially
            // a rejection) was permanent with no way back, even after the
            // client pushed back in the comment thread below.
            if (reconsiderBtn) {
            reconsiderBox = el("div", { style: "display:none;margin-top:8px;" });
            let reconsiderOpen = false;
            let reconsiderBuilt = false;
            reconsiderBtn.addEventListener("click", () => {
              reconsiderOpen = !reconsiderOpen;
              reconsiderBox.style.display = reconsiderOpen ? "" : "none";
              reconsiderBtn.textContent = reconsiderOpen ? "Cancel" : "Reconsider";
              if (reconsiderOpen && !reconsiderBuilt) { reconsiderBuilt = true; buildReconsiderForm(); }
            });

            function buildReconsiderForm() {
              const rstage = { decision: "pending", counter_value: "" };
              const counterInput = el("input", { type: "text", placeholder: "Your counter value...", style: "display:none;margin-top:8px;" });
              counterInput.addEventListener("input", () => { rstage.counter_value = counterInput.value; });
              const rejectBtn = el("button", { class: "btn secondary small" }, "Reject");
              const counterBtn = el("button", { class: "btn secondary small" }, "Counter");
              const acceptBtn = el("button", { class: "btn small" }, "Accept");
              function setRStage(d) {
                rstage.decision = rstage.decision === d ? "pending" : d;
                counterInput.style.display = rstage.decision === "countered" ? "" : "none";
                [rejectBtn, counterBtn, acceptBtn].forEach((b) => b.classList.remove("staged-active", "stage-accepted", "stage-rejected", "stage-countered"));
                if (rstage.decision === "rejected") rejectBtn.classList.add("staged-active", "stage-rejected");
                if (rstage.decision === "countered") { counterBtn.classList.add("staged-active", "stage-countered"); counterInput.focus(); }
                if (rstage.decision === "accepted") acceptBtn.classList.add("staged-active", "stage-accepted");
              }
              rejectBtn.addEventListener("click", () => setRStage("rejected"));
              counterBtn.addEventListener("click", () => setRStage("countered"));
              acceptBtn.addEventListener("click", () => setRStage("accepted"));
              const sendBtn = el("button", { class: "btn small" }, "Send new decision");
              sendBtn.addEventListener("click", async () => {
                if (rstage.decision === "pending") { alert("Pick accept, reject, or counter first."); return; }
                if (rstage.decision === "countered" && !rstage.counter_value.trim()) { alert("Enter a counter value."); return; }
                sendBtn.disabled = true;
                sendBtn.textContent = "Sending...";
                try {
                  await api(`/api/redline-edits/${edit.id}/reconsider`, {
                    method: "POST",
                    body: { decision: rstage.decision, counter_value: rstage.counter_value || "" },
                  });
                  load();
                } catch (e) {
                  sendBtn.disabled = false;
                  sendBtn.textContent = "Send new decision";
                  alert(e.message);
                }
              });
              reconsiderBox.appendChild(
                el("div", {}, [
                  el("div", { style: "font-size:12px;color:var(--muted);margin-bottom:6px;" }, "Change your decision -- sent to the client as its own update, by email, right away."),
                  el("div", { class: "decision-btns" }, [rejectBtn, counterBtn, acceptBtn]),
                  counterInput,
                  el("div", { style: "margin-top:8px;" }, [sendBtn]),
                ])
              );
            }
            }
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
                // See RedlineEdit.source_edit_id -- two different chain
                // producers share this field (sub.origin tells them apart):
                // the client responding to one of your counters (#20), or
                // this very row being your own reconsideration of an
                // earlier decision (#19, sub.origin === "owner_reconsideration").
                // Either way, surface the link instead of leaving it
                // invisible.
                edit.responding_to
                  ? el("div", { class: "rl-chain-note" }, [
                      sub.origin === "owner_reconsideration" ? "↩ Updates your earlier decision on: " : "↩ Responds to your counter: ",
                      el("strong", {}, edit.responding_to.counter_value || edit.responding_to.proposed_value || edit.responding_to.label),
                    ])
                  : null,
                // For an owner_edit-origin edit (phase 5, #23), proposed_value
                // deliberately mirrors original_value (see
                // edit_generated_document) -- the actual change is in
                // counter_value, or this would read "30 days → 30 days".
                el("div", { class: "change" }, [
                  el("span", { class: "from" }, edit.original_value || "(blank)"),
                  " → ",
                  el("span", { class: "to" }, sub.origin === "owner_edit" ? edit.counter_value : edit.proposed_value),
                ]),
                edit.comment ? el("div", { class: "edit-comment" }, ["“", edit.comment, "”"]) : null,
                ...thresholdLines,
                el("div", { style: "margin-top:6px;" }, el("span", { class: "eval-badge " + edit.evaluation }, edit.evaluation === "auto_approved" ? "Auto-approved" : "Needs review")),
              ]),
              actions,
            ])
          );
          if (reconsiderBox) subBox.appendChild(reconsiderBox);
          // Open comment thread, on ANY redline regardless of its decision
          // -- independent of the accept/reject/counter flow above, see
          // buildCommentThread and the redline-negotiation overhaul notes.
          subBox.appendChild(buildCommentThread(edit, { editPath: `/api/redline-edits/${edit.id}/comments`, myAuthorType: "owner" }));
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

        // Excludes superseded edits (see apply_redline_submission's
        // superseded_edit_ids) -- an edit whose "accepted" decision has
        // since been overridden by a reconsideration must not make this
        // button appear, since Apply itself will now skip it; showing Apply
        // here for a fully-superseded round with nothing else live would be
        // a dead end that fails with "No accepted edits to apply yet."
        const hasAcceptedSomewhere = sub.edits.some((e) => !e.superseded && (e.decision === "accepted" || (e.decision === "pending" && e.evaluation === "auto_approved")));
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

  function loadTemplates() {
    body.innerHTML = "";
    body.appendChild(el("div", { style: "color:var(--muted);font-size:13px;" }, "Loading..."));
    api("/api/templates")
      .then((templates) => {
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
      })
      .catch((e) => {
        // Without this, a failed request here left the whole Draft tab
        // silently blank forever -- no "No master documents" empty state
        // (that only ever painted on success), no error, nothing to click.
        body.innerHTML = "";
        body.appendChild(el("div", { class: "error-box" }, e.message || "Couldn't load your master documents."));
        const retryBtn = el("button", { class: "btn secondary small", style: "margin-top:8px;" }, "Retry");
        retryBtn.addEventListener("click", loadTemplates);
        body.appendChild(retryBtn);
      });
  }
  loadTemplates();

  function startDraft(templateId) {
    api(`/api/templates/${templateId}`)
      .then((tpl) => {
        openFillModal(tpl, null, (result, prefill) => {
          showResult(tpl, result, prefill);
        });
      })
      .catch((e) => alert(e.message || "Couldn't open that template. Please try again."));
  }

  function showResult(tpl, result, lastPrefill) {
    const editBtn = el("button", { class: "btn secondary" }, "Edit values");
    editBtn.addEventListener("click", () => {
      overlay.remove();
      api(`/api/templates/${tpl.id}`)
        .then((freshTpl) => {
          openFillModal(freshTpl, lastPrefill, (res2, prefill2) => showResult(freshTpl, res2, prefill2));
        })
        // The overlay above is already gone by the time this could fail --
        // without this, a failed request here silently dropped the person
        // back at the bare Draft tab with no fill form and no explanation.
        .catch((e) => alert(e.message || "Couldn't reopen this document for editing. Please try again."));
    });
    const libBtn = el("button", { class: "btn secondary", onclick: () => { overlay.remove(); location.hash = "#/documents"; } }, "View in Documents");
    const shareBtn = el("button", { class: "btn secondary", onclick: () => openShareModal(result.generated_id) }, "Share for review");
    const signBtn = el("button", { class: "btn secondary", onclick: () => openSignatureModal(result.generated_id) }, "Send for signature");
    const redlinesBtn = el("button", { class: "btn secondary", onclick: () => openRedlinesModal(result.generated_id) }, "Redlines");
    var overlay = showPreviewOverlay({
      title: result.name,
      subtitle: `Generated from ${tpl.name} · saved to your Documents library`,
      html: result.html,
      generatedId: result.generated_id,
      extraButtons: [editBtn, libBtn, shareBtn, signBtn, redlinesBtn],
      editable: true,
      onEdited: (editRes) => {
        // Edge case: this dialog only shows right after a fresh generation,
        // but the doc could already be shared (e.g. reopened via "Edit
        // values" on one that was). A queued edit (phase 5) has no new
        // revision -- and no editRes.id -- to re-fetch, so there's nothing
        // to re-render; the alert in showPreviewOverlay already covered it.
        if (editRes.queued_for_approval) return;
        // A direct edit creates a new revision rather than modifying this one
        // in place -- re-fetch it and re-render so the buttons above (Share,
        // Redlines, further edits) all point at the document you're actually
        // looking at now, not the superseded one.
        api(`/api/generated/${editRes.id}`)
          .then((fresh) => {
            showResult(tpl, { generated_id: fresh.id, name: fresh.name, html: fresh.html }, lastPrefill);
          })
          // The edit itself already succeeded server-side by this point --
          // only the re-fetch-and-redisplay failed, so say that plainly
          // instead of leaving the person staring at a dialog that just
          // silently vanished with no new one in its place.
          .catch((e) => alert((e.message || "Couldn't refresh the preview.") + " Your edit was saved -- check Documents to see it."));
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
    listWrap.innerHTML = "";
    listWrap.appendChild(el("div", { style: "color:var(--muted);font-size:13px;" }, "Loading..."));
    api("/api/templates")
      .then((templates) => {
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
      })
      .catch((e) => {
        listWrap.innerHTML = "";
        listWrap.appendChild(el("div", { class: "error-box" }, e.message || "Couldn't load your master documents."));
        const retryBtn = el("button", { class: "btn secondary small", style: "margin-top:8px;" }, "Retry");
        retryBtn.addEventListener("click", load);
        listWrap.appendChild(retryBtn);
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
          el("div", { class: "folder-name-row" }, [el("div", { class: "name" }, d.name), statusTagEl(d.status), unresolvedBadgeEl(d.unresolved_count)]),
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
    } else if (ev.type === "owner_reconsidered") {
      // See RedlineSubmission.origin and #19 in the bug tracker -- you
      // changed your mind on an already-decided redline; distinct from
      // redline_submitted since the client sent nothing here, you did.
      dotClass = "pending"; dotLabel = "↻"; title = "You reconsidered a decision"; desc = "Sent as its own round -- the client was emailed just this update.";
    } else if (ev.type === "owner_edit_proposed") {
      // See RedlineSubmission.origin and #23/phase 5 -- you edited the
      // shared document directly, and since a client may already be
      // reviewing it, the change is queued for their approval instead of
      // applying instantly (contrast with "owner_edited" below, from before
      // a document is shared).
      dotClass = "pending"; dotLabel = "✎"; title = "You proposed a direct edit"; desc = "Queued for the client's approval -- they were emailed just this update.";
    } else if (ev.type === "owner_edited") {
      // #23 in the bug tracker -- a direct edit made on this document BEFORE
      // it was ever shared, still just your own private draft, so it applied
      // instantly with no approval step (contrast with owner_edit_proposed
      // above). This is a real revision, same as drafted/redline_applied, so
      // it gets the same "View"/"Download" treatment and can be the current
      // version below -- it's just internal, so it's deliberately filtered
      // out of the client's own activity history (_client_lineage_timeline
      // in main.py) rather than labeled for them the way owner_edit_proposed
      // is; the client never negotiated this, there's nothing for them to see.
      dotClass = "final"; dotLabel = "✎"; title = "Direct edit"; desc = "You edited the document directly, before it was shared.";
    }
    const actions = [];
    if (doc && (ev.type === "drafted" || ev.type === "redline_applied" || ev.type === "owner_edited")) {
      actions.push(el("a", { onclick: () => openDetail(doc) }, "View"));
      actions.push(el("a", { href: `/api/generated/${doc.id}/download` }, "Download .docx"));
    } else if (doc && (ev.type === "redline_submitted" || ev.type === "owner_reconsidered" || ev.type === "owner_edit_proposed")) {
      actions.push(el("a", { onclick: () => openRedlinesModal(doc.id) }, "View redlines"));
    }
    const isCurrent = !!(doc && (ev.type === "redline_applied" || ev.type === "owner_edited") && doc.id === latestId);
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
            unresolvedBadgeEl(latest.unresolved_count),
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
    function loadFolderHistory() {
      chainWrap.innerHTML = "";
      chainWrap.appendChild(el("div", { style: "padding:14px 4px;color:var(--muted);font-size:12.5px;" }, "Loading history..."));
      api(`/api/generated/${latest.id}/history`)
        .then((hist) => {
          chainWrap.innerHTML = "";
          hist.timeline.forEach((ev) => chainWrap.appendChild(chainItemFor(ev, docsById, latest.id)));
        })
        .catch((e) => {
          // Without this, expanding a folder on a failed request left
          // "Loading history..." on screen forever, with no error and no
          // way to retry short of collapsing and re-expanding -- which
          // wouldn't even help, since historyLoaded was already set true.
          historyLoaded = false;
          chainWrap.innerHTML = "";
          chainWrap.appendChild(el("div", { class: "error-box", style: "margin:8px 4px;" }, e.message || "Couldn't load this document's history."));
          const retryBtn = el("button", { class: "btn secondary small", style: "margin:4px;" }, "Retry");
          retryBtn.addEventListener("click", loadFolderHistory);
          chainWrap.appendChild(retryBtn);
        });
    }
    head.addEventListener("click", () => {
      open = !open;
      folder.classList.toggle("open", open);
      if (open && !historyLoaded) {
        historyLoaded = true;
        loadFolderHistory();
      }
    });
    folder.appendChild(head);
    folder.appendChild(chainWrap);
    return folder;
  }

  // #34: load() re-fires on every tab click (Active/Archived) and after
  // every archive/delete action, and each call races an in-flight fetch
  // from whichever tab the user was just on. Two clicks in quick
  // succession -- Active then Archived -- send two overlapping requests,
  // and network timing (not click order) decides which response lands
  // last; if the slower Active response resolves after the faster
  // Archived one, its .then callback overwrites the list with the wrong
  // tab's documents while the tab buttons themselves still correctly show
  // "Archived" selected -- the UI silently disagrees with itself, no error,
  // nothing to retry. loadSeq is a monotonic "which call is this" counter:
  // every load() bumps it and captures its own value, and both the success
  // and error handlers bail out without touching the DOM if a newer call
  // has since started. Whichever request is actually still the latest one
  // requested is the only one ever allowed to render.
  let loadSeq = 0;
  function load() {
    const mySeq = ++loadSeq;
    listWrap.innerHTML = "";
    listWrap.appendChild(el("div", { style: "color:var(--muted);font-size:13px;" }, "Loading..."));
    api(`/api/generated?archived=${showArchived}`)
      .then((docs) => {
        if (mySeq !== loadSeq) return; // a newer load() has since superseded this one
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
      })
      .catch((e) => {
        if (mySeq !== loadSeq) return; // a newer load() has since superseded this one -- see #34 above
        // This is the whole Documents library -- without this, a failed
        // request left it silently blank forever, indistinguishable from
        // "you have no documents."
        listWrap.innerHTML = "";
        listWrap.appendChild(el("div", { class: "error-box" }, e.message || "Couldn't load your documents."));
        const retryBtn = el("button", { class: "btn secondary small", style: "margin-top:8px;" }, "Retry");
        retryBtn.addEventListener("click", load);
        listWrap.appendChild(retryBtn);
      });
  }
  load();

  async function toggleArchive(d) {
    try {
      await api(`/api/generated/${d.id}/archive`, { method: "POST", body: { archived: !d.archived } });
      load();
    } catch (e) {
      alert(e.message || "Couldn't update that document. Please try again.");
    }
  }

  async function deleteForever(d) {
    if (!confirm(`Permanently delete "${d.name}"? This cannot be undone.`)) return;
    try {
      await api(`/api/generated/${d.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      alert(e.message || "Couldn't delete that document. Please try again.");
    }
  }

  // A folder is every revision of one document -- archiving or deleting
  // only the latest revision would leave the older ones stranded on
  // whichever tab (Active/Archived) they happened to already be on, since
  // that filter is applied per-document before grouping into folders. So
  // both actions here always apply to every version in the family at once,
  // keeping the whole folder together on one tab.
  async function toggleArchiveFamily(familyDocs) {
    const nextArchived = !familyDocs[0].archived;
    try {
      await Promise.all(familyDocs.map((d) => api(`/api/generated/${d.id}/archive`, { method: "POST", body: { archived: nextArchived } })));
      load();
    } catch (e) {
      // Some of the family's requests may have already gone through --
      // reload so the list reflects whatever actually landed, rather than
      // leaving it showing the pre-click state next to a silent failure.
      alert(e.message || "Couldn't update every version of that document. Please try again.");
      load();
    }
  }

  async function deleteFamilyForever(familyDocs) {
    const label = familyDocs.length > 1 ? `all ${familyDocs.length} versions of "${familyDocs[0].name}"` : `"${familyDocs[0].name}"`;
    if (!confirm(`Permanently delete ${label}? This cannot be undone.`)) return;
    try {
      await Promise.all(familyDocs.map((d) => api(`/api/generated/${d.id}`, { method: "DELETE" })));
      load();
    } catch (e) {
      alert(e.message || "Couldn't delete every version of that document. Please try again.");
      load();
    }
  }

  function openDetail(d) {
    api(`/api/generated/${d.id}`).then((full) => {
      const valuesHtml = full.values.map((v) => `<div class="field-row"><div class="k">${v.label}</div><div class="v">${v.value || "—"}</div></div>`).join("");
      const lineageLink = el("a", { onclick: () => { document.querySelectorAll(".panel-overlay").forEach((o) => o.remove()); location.hash = "#/masters"; } }, full.template_name);
      const panelOverlay = el("div", { class: "panel-overlay" });
      const panel = el("div", { class: "slide-panel" }, [
        el("button", { class: "close", onclick: () => panelOverlay.remove() }, "✕"),
        el("div", { class: "folder-name-row" }, [el("h2", { style: "margin:0;" }, full.name), statusTagEl(full.status), unresolvedBadgeEl(full.unresolved_count)]),
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
          el("button", { class: "btn secondary", onclick: () => { panelOverlay.remove(); openSignatureModal(d.id); } }, "Send for signature"),
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
    }).catch((e) => alert(e.message || "Couldn't load that document. Please try again."));
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Editor (click-to-mark placeholders) -- unchanged mechanics, restyled
// ---------------------------------------------------------------------------

// Shared by computeSelectionSegments (a real, non-empty selection -- template
// field-marking and client redlining) and computeCursorPosition (a plain
// click with no drag -- the owner direct-edit "click to insert" flow, see
// showPreviewOverlay). Hoisted out of both so the tricky text-node-walking
// logic exists in exactly one place.
function _toTextNode(node, offset) {
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

function _findAncestorWithClass(node, cls) {
  let e = node.nodeType === 3 ? node.parentElement : node;
  while (e && !(e.classList && e.classList.contains(cls))) e = e.parentElement;
  return e;
}

// A run that has one or more staged direct edits gets decoration spliced
// into it by showPreviewOverlay's repaint() -- .fv-ins (a staged edit's new
// text, not part of the actual document yet) and .insert-ghost-marker (the
// live typing preview for the popover that's currently open). Both are
// zero-width as far as the ORIGINAL document text is concerned, so offset
// math below has to skip them rather than counting their characters --
// otherwise a second click in an already-decorated run would compute a
// position that's off by however many characters the decoration added.
function _isDecorationEl(node) {
  return !!(node && node.nodeType === 1 && node.classList && (node.classList.contains("fv-ins") || node.classList.contains("insert-ghost-marker")));
}

// True if `node` sits inside a decoration element (up to, but not
// including, `stopEl`) -- used to reject a click/selection that lands on
// already-staged new text, where there's no meaningful "original document
// position" to report. The caller should ask the person to remove the
// existing staged edit first rather than silently computing something
// wrong.
function _insideDecoration(node, stopEl) {
  let e = node.nodeType === 3 ? node.parentElement : node;
  while (e && e !== stopEl) {
    if (_isDecorationEl(e)) return true;
    e = e.parentElement;
  }
  return false;
}

// Maps a live DOM (textNode, localOffset) position back to an offset
// relative to the RUN's ORIGINAL text -- i.e. as if no decoration had ever
// been spliced in. Walks the run's subtree in document order, skipping
// decoration elements entirely (their text doesn't count -- see
// _isDecorationEl) and summing every other text node's length until it
// reaches `textNode`. Plain text nodes and .fv-del spans (the original
// text of an already-staged replacement, still shown struck-through) both
// count normally, since both really are original document text.
function _runRelativeOffset(runEl, textNode, localOffset) {
  let total = 0;
  let found = false;
  (function walk(node) {
    if (found) return;
    if (node === textNode) { total += localOffset; found = true; return; }
    if (node.nodeType === 3) { total += node.textContent.length; return; }
    if (_isDecorationEl(node)) return;
    for (const child of node.childNodes) { walk(child); if (found) return; }
  })(runEl);
  return found ? total : null;
}

// Same original-text-only accounting as _runRelativeOffset, but for the
// run's total length -- used when a multi-run selection spans this run
// entirely (computeSelectionSegments' "middle run" case) or ends inside a
// following run. runEl.textContent alone would over-count once decoration
// has spliced staged .fv-ins text into the run.
function _originalRunLength(runEl) {
  let total = 0;
  (function walk(node) {
    if (node.nodeType === 3) { total += node.textContent.length; return; }
    if (_isDecorationEl(node)) return;
    for (const child of node.childNodes) walk(child);
  })(runEl);
  return total;
}

// Cursor-position variant of computeSelectionSegments: a plain click (no
// drag) is a collapsed selection, which computeSelectionSegments always
// rejects -- correct for field-marking and redlining (you must select real
// text to mark or propose a change to), but exactly what a "click and type
// to insert" direct edit needs instead. Returns a single zero-width segment
// (start === end) at the click point; docx_engine.apply_text_edits and
// extract_text_at on the backend already treat that as "insert here without
// removing anything" -- confirmed with zero server-side changes needed (see
// _apply_paragraph_group's piece-building loop).
function computeCursorPosition(containerEl) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!containerEl.contains(range.commonAncestorContainer)) return null;

  const tn = _toTextNode(range.startContainer, range.startOffset);
  if (!tn.node) return null;

  const runEl = _findAncestorWithClass(tn.node, "run");
  const paraEl = _findAncestorWithClass(tn.node, "para");
  if (!runEl || !paraEl) return null;
  // Clicking inside a run's own already-staged decoration (see
  // _isDecorationEl) has no meaningful "original document position" to
  // report -- direct the caller to remove that staged edit first instead
  // of silently computing a wrong offset.
  if (_insideDecoration(tn.node, runEl)) return { error: "inside-pending-edit" };

  const offset = _runRelativeOffset(runEl, tn.node, tn.offset);
  if (offset === null) return null;

  const pIndex = parseInt(paraEl.dataset.p, 10);
  const tablePath = paraEl.dataset.path || "";
  const r = parseInt(runEl.dataset.r, 10);
  return { paragraph_index: pIndex, table_path: tablePath, segments: [{ r, start: offset, end: offset }], text: "" };
}

function computeSelectionSegments(containerEl) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!containerEl.contains(range.commonAncestorContainer)) return null;

  const startTN = _toTextNode(range.startContainer, range.startOffset);
  const endTN = _toTextNode(range.endContainer, range.endOffset);
  if (!startTN.node || !endTN.node) return null;

  const startRunEl = _findAncestorWithClass(startTN.node, "run");
  const endRunEl = _findAncestorWithClass(endTN.node, "run");
  const startParaEl = _findAncestorWithClass(startTN.node, "para");
  const endParaEl = _findAncestorWithClass(endTN.node, "para");
  if (!startRunEl || !endRunEl || !startParaEl || !endParaEl) return null;
  if (startParaEl !== endParaEl) return { error: "cross-paragraph" };
  // See computeCursorPosition -- a selection that touches already-staged
  // decoration has no clean original-text mapping either.
  if (_insideDecoration(startTN.node, startRunEl) || _insideDecoration(endTN.node, endRunEl)) {
    return { error: "inside-pending-edit" };
  }

  const pIndex = parseInt(startParaEl.dataset.p, 10);
  const tablePath = startParaEl.dataset.path || "";
  const text = range.toString();

  if (startRunEl === endRunEl) {
    const r = parseInt(startRunEl.dataset.r, 10);
    let s = _runRelativeOffset(startRunEl, startTN.node, startTN.offset);
    let e = _runRelativeOffset(endRunEl, endTN.node, endTN.offset);
    if (s === null || e === null) return null;
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
    const runLen = _originalRunLength(runEl);
    let s, e;
    if (i === startIdx) { s = _runRelativeOffset(runEl, startTN.node, startTN.offset); e = runLen; }
    else if (i === endIdx) { s = 0; e = _runRelativeOffset(runEl, endTN.node, endTN.offset); }
    else { s = 0; e = runLen; }
    if (s === null || e === null) return null;
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
  // Bug tracker #36: this used to be document.body.appendChild(toolbar) --
  // .mark-toolbar is position:fixed, so viewport-relative placement doesn't
  // actually need it to live outside the view's own tree, and appending it
  // to document.body meant it (and the document-level mousedown listener
  // below that closes over it) never got cleaned up by render()'s
  // app.innerHTML = "" on navigation -- both just lingered forever,
  // leaking one more dangling toolbar node and listener per visit to this
  // page (e.g. via the Back button or any other nav away and back).
  // Appending it to wrap instead means it's removed for free the moment
  // this view is torn down; the listener itself is still handled
  // separately below via wrap._teardown, since a plain DOM removal doesn't
  // detach listeners registered on `document`.
  wrap.appendChild(toolbar);

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
      // The floating "Mark as placeholder" toolbar can still be open from a
      // selection made just before this -- that selection's offsets are now
      // meaningless against the freshly-reset document. See mark_placeholder's
      // stale-selection guard in main.py for the server-side backstop; this
      // just keeps the (now-dangling) toolbar from lingering on screen too.
      hideToolbar();
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

  // Named (not an inline arrow) so it can actually be removed -- see
  // wrap._teardown below and the #36 comment on the toolbar's own
  // appendChild above.
  function onDocMousedown(e) {
    if (e.target === toolbar || toolbar.contains(e.target)) return;
    if (!contractView.contains(e.target)) hideToolbar();
  }
  document.addEventListener("mousedown", onDocMousedown);
  // Bug tracker #36: picked up by router()'s editorMatch branch and handed
  // to render(), which calls this right before tearing down this view for
  // whatever comes next -- without it, this listener (and its closure over
  // toolbar/contractView, keeping both retained in memory) accumulated one
  // more copy every time this page was visited, each one still firing on
  // every future mousedown anywhere in the app.
  wrap._teardown = () => document.removeEventListener("mousedown", onDocMousedown);

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
            // See mark_placeholder's stale-selection guard (main.py) -- the
            // exact text captured at selection time, compared server-side
            // against whatever's actually at these offsets NOW, so a stale
            // toolbar (see hideToolbar callers) errors instead of silently
            // marking the wrong text.
            expected_text: selectionInfo.text || "",
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
    phList.innerHTML = "";
    phList.appendChild(el("div", { style: "color:var(--muted);font-size:13px;" }, "Loading..."));
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
    }).catch((e) => {
      // This sidebar drives genBtn's enabled state and every "Remove"/
      // "Set redline rule" action -- without this, a failed request left
      // it on "Loading..." forever with no error and no way to retry.
      phList.innerHTML = "";
      phList.appendChild(el("div", { class: "error-box" }, e.message || "Couldn't load placeholders."));
      const retryBtn = el("button", { class: "btn secondary small", style: "margin-top:8px;" }, "Retry");
      retryBtn.addEventListener("click", loadPlaceholders);
      phList.appendChild(retryBtn);
    });
  }

  async function deletePlaceholder(id) {
    try {
      const data = await api(`/api/templates/${templateId}/placeholders/${id}`, { method: "DELETE" });
      contractView.innerHTML = data.html;
      // Same reasoning as "Start over" above -- this re-renders the document
      // (removing the {{token}} restores its original wording, shifting every
      // run's offsets), so any selection the toolbar was still showing is now
      // stale. This is the actual bug scenario: select some OTHER text, then
      // remove an unrelated placeholder from the sidebar without the toolbar
      // ever closing, then click "Mark as placeholder" on stale offsets.
      hideToolbar();
      loadPlaceholders();
    } catch (e) {
      alert(e.message || "Couldn't remove that placeholder. Please try again.");
    }
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

  function loadContract() {
    contractView.innerHTML = "";
    contractView.appendChild(el("div", { style: "color:var(--muted);font-size:13px;padding:12px;" }, "Loading..."));
    api(`/api/templates/${templateId}/html`)
      .then((data) => { contractView.innerHTML = data.html; })
      .catch((e) => {
        // This is the whole point of the page -- without this, a failed
        // request left it on "Loading..." forever with nothing to select
        // and no indication anything went wrong.
        contractView.innerHTML = "";
        contractView.appendChild(el("div", { class: "error-box" }, e.message || "Couldn't load this document."));
        const retryBtn = el("button", { class: "btn secondary small", style: "margin-top:8px;" }, "Retry");
        retryBtn.addEventListener("click", loadContract);
        contractView.appendChild(retryBtn);
      });
  }
  loadContract();
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
    { id: "Phase 2 / #22", title: "Redline overhaul, phase 2 of 4: a declined redline with client pushback had no reply path", fix: "Replaced the old one-shot “leave a comment on a declined redline” with an open comment thread on ANY redline regardless of its decision, Google-Docs-suggest-edit-style, using the real names Phase 1 collects. “Resolved” is independent of the redline's actual decision; posting into a resolved thread auto-reopens it, and either side can also manually reopen. No email for any reply -- owner still gets an in-app bell (respects the existing opt-out toggle), client sees new messages next time they open the thread." },
  ],
  open: [
    { id: "#14", priority: "P3", title: "No rate limit on share-link access-code attempts", detail: "Reviewed and intentionally left open -- not considered important enough to prioritize right now." },
    { id: "#19", priority: "BUILDING", title: "A rejection is a dead end for the owner once the client pushes back with a comment", detail: "Decided: Phase 3 (reconsider flow) -- resend just the reconsidered edit(s) as a new round, everything else in that round stands as already-approved, client notified by email. Phases 1 and 2 (its prerequisites) are both shipped." },
    { id: "#20", priority: "BUILDING", title: "Resubmitting after rejecting a counter loses the negotiation context", detail: "Decided: Phase 3 -- a visible chain linking the resubmission back to the original counter, for transparency and tracking." },
    { id: "#21", priority: "BUILDING", title: "Doing nothing about a counter is silently treated as accepting it", detail: "Decided: Phase 4 -- Finalize and submit becomes a hard block until every counter has an explicit decision (Save progress stays unblocked), plus an “N unresolved” badge on the document dashboard/list view." },
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
    const retryBtn = el("button", { class: "btn secondary small", style: "margin-top:8px;" }, "Retry");
    // AdminView() builds this whole page fresh, including this same
    // api() call -- easiest correct retry is just re-running the router
    // against the current (unchanged) hash rather than threading a
    // reload path through this already-large handler.
    retryBtn.addEventListener("click", () => router());
    body.appendChild(retryBtn);
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
        const retryBtn = el("button", { class: "btn secondary small", style: "margin-top:8px;" }, "Retry");
        retryBtn.addEventListener("click", refresh);
        tableWrap.appendChild(retryBtn);
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
  if (editorMatch) {
    // See render()'s #36 comment -- EditorView attaches a document-level
    // listener that needs explicit teardown, captured here (before shell()
    // wraps it in a fresh outer div) via the _teardown property EditorView
    // sets on its own root element.
    const editorView = EditorView(parseInt(editorMatch[1], 10));
    return render(shell(editorView), editorView._teardown);
  }

  location.hash = "#/draft";
}

window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", router);
