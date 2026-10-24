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
    // res.statusText is unreliable as a fallback: HTTP/2 (which Render's
    // edge serves) has no status-reason phrase at all, so browsers report
    // it as "" -- an unhandled backend crash (a plain 500 with no JSON
    // "detail", e.g. not raised via HTTPException) would otherwise surface
    // as a blank .error-box with no text, leaving the user with no idea
    // what happened.
    let msg = res.statusText || `Something went wrong (error ${res.status}). Please try again.`;
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
    if (!msg) msg = `Something went wrong (error ${res.status}). Please try again.`;
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
    { key: "signature_events", label: "Someone signs (or finishes signing) a document" },
    { key: "auto_remind_signers", label: "Remind signers who haven't signed yet (day 3, 6, 9)" },
    { key: "renewal_emails", label: "Email me 30 and 7 days before a contract ends" },
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

  // ---- logo shown to clients on review and signing pages. PNG or JPG up
  // to 1 MB; without one, clients see your name instead. ----
  const logoRow = el("div", { class: "plan-row" });
  logoRow.appendChild(el("div", { class: "label" }, "Your logo"));
  const logoBody = el("div", { class: "logo-row" });
  logoRow.appendChild(logoBody);
  const logoHint = el("div", { style: "font-size:11.5px;color:var(--muted);margin-top:6px;line-height:1.4;" }, "Shown to clients on review and signing pages. PNG or JPG, up to 1 MB. Without one, they see your name.");
  logoRow.appendChild(logoHint);
  // Where the logo links to on clients' pages. Blank = not clickable.
  const linkInput = el("input", { type: "text", placeholder: "yourcompany.com", autocomplete: "off", "aria-label": "Website your logo links to", style: "flex:1;min-width:0;" });
  const linkSave = el("button", { class: "btn secondary small" }, "Save");
  const linkMsg = el("div", { style: "font-size:11.5px;margin-top:4px;min-height:15px;color:var(--muted);" });
  logoRow.appendChild(el("div", { class: "label", style: "margin-top:12px;" }, "Logo links to"));
  logoRow.appendChild(el("div", { style: "display:flex;gap:6px;align-items:center;margin-top:4px;" }, [linkInput, linkSave]));
  logoRow.appendChild(linkMsg);
  logoRow.appendChild(el("div", { style: "font-size:11.5px;color:var(--muted);line-height:1.4;" }, "Optional. Clients who click your logo go to this website. Leave it blank and the logo isn't clickable."));
  async function saveLink() {
    linkSave.disabled = true;
    linkMsg.style.color = "var(--muted)";
    linkMsg.textContent = "";
    try {
      const b = await api("/api/account/branding", { method: "PATCH", body: { link: linkInput.value } });
      linkInput.value = b.link || "";
      linkMsg.textContent = b.link ? "Saved. Your logo now links there." : "Saved. Your logo isn't clickable.";
    } catch (e) {
      linkMsg.style.color = "var(--danger)";
      linkMsg.textContent = e.message;
    } finally { linkSave.disabled = false; }
  }
  linkSave.addEventListener("click", saveLink);
  linkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveLink(); } });
  const logoFile = el("input", { type: "file", accept: "image/png,image/jpeg", style: "display:none;" });
  logoRow.appendChild(logoFile);
  dd.appendChild(logoRow);

  function paintLogo(b) {
    if (document.activeElement !== linkInput) linkInput.value = b.link || "";
    logoBody.innerHTML = "";
    const preview = el("div", { class: "logo-preview" });
    if (b.has_logo) preview.appendChild(el("img", { src: b.logo_url, alt: "Your logo" }));
    else preview.textContent = "No logo";
    const upload = el("button", { class: "btn secondary small", onclick: () => logoFile.click() }, b.has_logo ? "Replace" : "Upload logo");
    const actions = el("div", { class: "logo-actions" }, [upload]);
    if (b.has_logo) {
      actions.appendChild(el("button", {
        class: "btn secondary small",
        onclick: async () => {
          try { paintLogo(await api("/api/account/logo", { method: "DELETE" })); } catch (e) { alert(e.message); }
        },
      }, "Remove"));
    }
    logoBody.appendChild(preview);
    logoBody.appendChild(actions);
  }
  logoFile.addEventListener("change", async () => {
    const f = logoFile.files && logoFile.files[0];
    logoFile.value = "";
    if (!f) return;
    if (f.size > 1024 * 1024) { alert("That logo is over 1 MB. Please use a smaller PNG or JPG."); return; }
    const form = new FormData();
    form.append("file", f);
    try {
      const res = await fetch("/api/account/logo", { method: "POST", body: form, credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Couldn't upload that logo. Please try again.");
      paintLogo(data);
    } catch (e) { alert(e.message); }
  });
  api("/api/account/branding").then(paintLogo).catch(() => {
    logoBody.appendChild(el("span", { style: "font-size:11.5px;color:var(--muted);" }, "Couldn't load your logo settings."));
  });

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
// Notification bell -- fires on the events listed in main.py's _notify
// docstring: a client submits redlines, a client comments on a redline, a
// signer finishes signing while others are still pending, a signature
// request is fully signed by everyone, and a signer declines to sign (which
// halts the request right away). Nothing else lights up the bell.
// "response_acknowledged" is kept in the label map only so any older,
// already-delivered notifications of that (now-retired) type still render
// with a readable title instead of raw text.
// ---------------------------------------------------------------------------

const NOTIF_TYPE_LABELS = {
  redline_submitted: "Redlines submitted",
  response_acknowledged: "Response seen",
  redline_comment: "Redline comment",
  signature_signed: "Signature received",
  signature_completed: "Fully signed",
  signature_declined: "Signing declined",
};
// Notification types that are about the e-signature flow, not redlines --
// clicking one of these should open the signature status modal instead of
// the redlines modal (see toggleNotifDropdown's click handler below).
const SIGNATURE_NOTIF_TYPES = new Set(["signature_signed", "signature_completed", "signature_declined"]);

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
        if (n.generated_contract_id) {
          if (SIGNATURE_NOTIF_TYPES.has(n.type)) openSignatureModal(n.generated_contract_id);
          else openRedlinesModal(n.generated_contract_id);
        }
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

// The faint repeated wordmark behind the log in / sign up / reset cards.
// Purely decorative: aria-hidden, and CSS keeps it from taking clicks.
function authBackdrop() {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const words = [];
    for (let j = 0; j < 4; j++) words.push(el("span", { class: "w" }, ["Rotely", el("i", {}, ".ai")]));
    rows.push(el("div", { class: "row", style: "--i:" + i }, words));
  }
  return el("div", { class: "auth-bg", "aria-hidden": "true" }, rows);
}

function AuthView(mode) {
  let tab = mode || "login";
  const wrap = el("div", { class: "auth-shell" });
  const card = el("div", { class: "card" });
  wrap.appendChild(authBackdrop());
  wrap.appendChild(card);

  // If we just landed here from a real (non-hash) redirect -- the
  // verify-email link, the Google OAuth callback erroring out, or a
  // reset-password link that had already expired -- surface a banner once
  // and strip the query off the hash so it doesn't linger through reloads.
  const hashQuery = new URLSearchParams(location.hash.split("?")[1] || "");
  const justVerified = hashQuery.get("verified") === "1";
  const verifyError = hashQuery.get("verify_error") === "1";
  const googleError = hashQuery.get("google_error") === "1";
  const googleErrorReason = hashQuery.get("reason") || "";
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
      el("div", { class: "auth-logo" }, [el("div", { class: "word" }, ["Rotely", el("span", { class: "dot" }, ".ai")])])
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
    } else if (tab === "register" && googleError && googleErrorReason === "access_code") {
      errorBox.appendChild(el("div", { class: "error-box" }, "Enter your access code below, then continue with Google."));
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
    const codeInput = el("input", { type: "text", placeholder: "Enter your access code", autocapitalize: "none", autocorrect: "off" });

    const fields = [];
    if (tab === "register") {
      fields.push(
        el("div", { class: "form-row" }, [
          el("label", { class: "field-label" }, "Access code"),
          codeInput,
          el("div", { style: "font-size:12px;color:var(--muted);margin-top:4px;" }, "Rotely is invite-only right now. Don't have a code? Join the waitlist at rotely.ai."),
        ])
      );
    }
    fields.push(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Email"), emailInput]));
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
        if (!codeInput.value.trim()) {
          errorBox.appendChild(el("div", { class: "error-box" }, "Please enter your access code."));
          return;
        }
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
          const res = await api("/api/register", { method: "POST", body: { email: emailInput.value, password: passInput.value, name: nameInput.value, access_code: codeInput.value } });
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

    const googleBtn = el("a", { href: "/api/auth/google/start", class: "btn secondary block google-btn" }, [
      el("span", { html: '<svg width="16" height="16" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.9 32.6 29.4 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34.1 5.1 29.3 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.2-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.5 19 12 24 12c3.1 0 5.8 1.1 8 3l6-6C34.1 5.1 29.3 3 24 3 16.3 3 9.6 7.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 45c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 36.4 26.7 37 24 37c-5.3 0-9.8-3.4-11.4-8.1l-6.5 5C9.5 40.6 16.2 45 24 45z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3-3.4 5.4-6.3 6.7l6.2 5.2C38.9 37.4 42 31.2 42 24c0-1.2-.1-2.4-.4-3.5z"/></svg>' }),
      el("span", {}, "Continue with Google"),
    ]);
    if (tab === "register") {
      // New accounts need the access code too -- it's only known client-side
      // (the input above), so it rides along as a query param and comes back
      // to us in the session on the server for google_auth_callback to check.
      googleBtn.addEventListener("click", (e) => {
        if (!codeInput.value.trim()) {
          e.preventDefault();
          errorBox.innerHTML = "";
          errorBox.appendChild(el("div", { class: "error-box" }, "Please enter your access code first."));
          return;
        }
        googleBtn.href = `/api/auth/google/start?access_code=${encodeURIComponent(codeInput.value.trim())}`;
      });
    }
    card.appendChild(el("div", { class: "auth-divider" }, [el("span", {}, "or")]));
    card.appendChild(googleBtn);
  }
  draw();
  return wrap;
}

function ResetPasswordView() {
  const wrap = el("div", { class: "auth-shell" });
  const card = el("div", { class: "card" });
  wrap.appendChild(authBackdrop());
  wrap.appendChild(card);

  const hashQuery = new URLSearchParams(location.hash.split("?")[1] || "");
  const token = hashQuery.get("token") || "";

  card.appendChild(el("div", { class: "auth-logo" }, [el("div", { class: "word" }, ["Rotely", el("span", { class: "dot" }, ".ai")])]));

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

// nextSteps / moreItems (optional): the "What's next for this contract?" choices
// shown under the document, and the "⋯" menu for rare actions. When nextSteps is
// given the bottom button row goes away: there is one way to close (✕) and the
// next steps are the page's call to action.
function showPreviewOverlay({ title, subtitle, html, generatedId, extraButtons, editable, onEdited, nextSteps, moreItems }) {
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
    nextSteps
      ? el("div", { style: "display:flex;gap:8px;align-items:center;flex:none;" }, [
          moreItems ? moreMenu(moreItems) : null,
          el("button", { class: "btn ghost small", "aria-label": "Close", title: "Close", onclick: () => closeOverlay() }, "✕"),
        ])
      : el("button", { class: "btn ghost small", onclick: () => closeOverlay() }, "Close"),
  ]);
  box.appendChild(headerRow);

  if (editable && generatedId) {
    // Phase 5 (#23): once a document is shared, a direct edit is no longer
    // instant -- it's queued as a redline the client has to approve, same
    // as the copy in showResult/openDetail's confirmation below. Click-to-
    // insert (no selection needed) added right after Phase 5 shipped, once
    // it was clear "select something to edit it" left no way to just add
    // new text -- see computeCursorPosition.
    // The key stays above the document while editing; "How to edit" explains the gestures.
    box.appendChild(window.RedlineUI.keyBar({ comment: false }));
    box.appendChild(el("p", { style: "font-size:12.5px;color:var(--muted);margin:0 0 10px;" }, "Stage as many changes as you like, then save them all at once -- applied instantly as one new revision if this document hasn't been shared yet, or sent to the client for approval if it has."));
  }

  const preview = el("div", { class: "contract-view compact", style: "max-height:52vh;overflow-y:auto;" });
  preview.innerHTML = pristineHtml;
  box.appendChild(preview);

  const stagedBar = el("div", { style: "display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);" });
  box.appendChild(stagedBar);

  if (editable && generatedId) {
    // The sender gets the same tools as the client (see redline_ui.js):
    // highlight text to replace or delete it, click between words to insert
    // text or add a new paragraph, with Bold / Italic / Underline for new
    // text. Everything is staged locally and painted straight into the
    // document (the same marks the client sees), then saved as one batch.
    const RU = window.RedlineUI;
    let newParaSeq = 0;
    let ghost = null; // { kind, edit, replacesId } -- an unsaved edit being typed in the card
    const pristineRoot = document.createElement("div");
    pristineRoot.innerHTML = pristineHtml;
    const pristineParaText = (tp, pi) => { const p = _findParaEl(pristineRoot, tp, pi); return p ? p.textContent : ""; };
    const pristineRunText = (tp, pi, r) => {
      const p = _findParaEl(pristineRoot, tp, pi);
      const run = p ? p.querySelector(`.run[data-r="${r}"]`) : null;
      return run ? run.textContent : "";
    };
    const shorten = (s, n) => { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

    function stagedKind(e) {
      if (e.new_paragraph) return "paragraph";
      if (e.segments.length && e.segments.every((s) => s.start === s.end)) return "insert";
      if (!(e.new_text || "").trim()) return "delete";
      return "replace";
    }
    const KIND_LABEL = { insert: "Insert", paragraph: "New paragraph", replace: "Replace", delete: "Delete" };

    function paddedInsert(info, value) {
      const seg = info.segments[0];
      const t = pristineRunText(info.table_path, info.paragraph_index, seg.r);
      return RU.padInsert(t[seg.start - 1] || "", t[seg.start] || "", value);
    }

    // Rebuilds the preview from the pristine (server-rendered) HTML, then
    // splices every staged edit back in at its exact run/offset -- the same
    // pattern share.js uses to show a client their pending redlines in place.
    function paintPreview() {
      preview.innerHTML = pristineHtml;
      const items = staged.filter((e) => !(ghost && ghost.replacesId === e.localId)).map((e) => ({ e, isGhost: false, kind: stagedKind(e) }));
      if (ghost) items.push({ e: ghost.edit, isGhost: true, kind: ghost.kind });
      const byPara = {}, newParas = {};
      items.forEach((it) => {
        const pk = `${it.e.table_path || ""} ${it.e.paragraph_index}`;
        const bucket = it.e.new_paragraph ? newParas : byPara;
        (bucket[pk] = bucket[pk] || []).push(it);
      });
      Object.entries(byPara).forEach(([pk, list]) => {
        const sp = pk.lastIndexOf(" ");
        const paraEl = _findParaEl(preview, pk.slice(0, sp), parseInt(pk.slice(sp + 1), 10));
        if (!paraEl) return;
        const runEls = Array.from(paraEl.querySelectorAll(".run"));
        const byRun = {};
        list.forEach((it) => it.e.segments.forEach((seg) => { (byRun[seg.r] = byRun[seg.r] || []).push({ seg, it }); }));
        Object.entries(byRun).forEach(([rIdxStr, segEdits]) => {
          const runEl = runEls[parseInt(rIdxStr, 10)];
          if (!runEl) return;
          segEdits.sort((a, b) => a.seg.start - b.seg.start || a.seg.end - b.seg.end);
          const text = runEl.textContent;
          const frag = document.createDocumentFragment();
          const seen = new Set();
          let cursor = 0;
          segEdits.forEach(({ seg, it }) => {
            const start = Math.max(seg.start, cursor), end = Math.max(seg.end, start);
            if (start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, start)));
            const attrs = it.isGhost ? {} : { "data-staged-id": String(it.e.localId) };
            const first = !seen.has(it.e);
            seen.add(it.e);
            const fmt = RU.fmtClasses(it.e.format);
            const ins = () => el("span", { class: (it.isGhost ? "fv-ghost" : "fv-ins") + fmt, ...attrs }, it.e.new_text || "");
            if (it.kind === "insert") { if (first) frag.appendChild(ins()); }
            else {
              frag.appendChild(el("span", { class: "fv-del", ...attrs }, text.slice(start, end)));
              if (it.kind === "replace" && first) frag.appendChild(ins());
            }
            cursor = end;
          });
          if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
          runEl.innerHTML = "";
          runEl.appendChild(frag);
        });
      });
      Object.entries(newParas).forEach(([pk, list]) => {
        const sp = pk.lastIndexOf(" ");
        let anchor = _findParaEl(preview, pk.slice(0, sp), parseInt(pk.slice(sp + 1), 10));
        if (!anchor) return;
        list.forEach((it) => {
          const p = el("p", {
            class: "newp-mark" + (it.isGhost ? " ghost" : "") + RU.fmtClasses(it.e.format),
            ...(it.isGhost ? {} : { "data-staged-id": String(it.e.localId) }),
          }, [el("span", { class: "np-text" }, it.e.new_text || "")]);
          anchor.after(p);
          anchor = p;
        });
      });
    }

    function repaintStaged() {
      paintPreview();
      renderStagedBar();
    }

    function renderStagedBar() {
      stagedBar.innerHTML = "";
      if (!staged.length) { stagedBar.style.display = "none"; return; }
      stagedBar.style.display = "";
      const list = el("div", { style: "display:flex;flex-direction:column;gap:6px;margin-bottom:10px;" });
      staged.forEach((e, i) => {
        const kind = stagedKind(e);
        const fw = RU.fmtWords(e.format);
        const fwNote = fw ? ` (${fw})` : "";
        let text;
        if (kind === "insert") text = `Add “${shorten(e.new_text, 60)}”${fwNote}`;
        else if (kind === "paragraph") text = `Add paragraph “${shorten(e.new_text, 70)}”${fwNote}`;
        else if (kind === "delete") text = `Remove “${shorten(e.originalText, 60)}”`;
        else text = `“${shorten(e.originalText, 30)}” → “${shorten(e.new_text, 30)}”${fwNote}`;
        const removeBtn = el("span", { class: "staged-edit-remove" }, "Remove");
        removeBtn.addEventListener("click", () => {
          const idx = staged.indexOf(e);
          if (idx !== -1) staged.splice(idx, 1);
          repaintStaged();
        });
        list.appendChild(
          el("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12.5px;background:var(--panel-2, var(--panel));border:1px solid var(--border);border-radius:6px;padding:6px 10px;" }, [
            el("span", { class: "rl-tag " + kind, style: "flex:none;" }, KIND_LABEL[kind]),
            el("div", { style: "min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" }, text),
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
                format: e.format || "",
                new_paragraph: !!e.new_paragraph,
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

    // ---- floating pill + card ----
    let pill = null, activePopover = null, hlEls = [], hlRange = null;
    const clearHl = () => { hlEls.forEach((n) => n.remove()); hlEls = []; };
    function highlight(range) {
      clearHl();
      hlRange = range;
      Array.from(range.getClientRects()).forEach((r) => {
        if (r.width <= 0 || r.height <= 0) return;
        const box = el("div", { class: "text-selection-highlight" });
        box.style.cssText = `top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px`;
        document.body.appendChild(box);
        hlEls.push(box);
      });
    }
    preview.addEventListener("scroll", () => { if (hlRange) { try { highlight(hlRange); } catch (e) { clearHl(); } } });
    const removePill = () => { if (pill) { pill.remove(); pill = null; } };
    const closeCard = () => { if (activePopover) { activePopover.remove(); activePopover = null; } };
    function dismiss() {
      closeCard(); removePill(); clearHl(); hlRange = null;
      preview.querySelectorAll(".selected").forEach((n) => n.classList.remove("selected"));
      if (ghost) { ghost = null; paintPreview(); }
    }
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") dismiss(); });
    document.addEventListener("click", function outside(e) {
      if (!document.body.contains(overlay)) { document.removeEventListener("click", outside); return; }
      if (e.target.closest(".contract-view") || e.target.closest(".rl-pill") || e.target.closest(".redline-popover")) return;
      dismiss();
    });

    function commitStaged(o) {
      // o: { mode, existing, info, value, format }
      const base = { table_path: o.info.table_path, paragraph_index: o.info.paragraph_index, segments: o.info.segments };
      let rec = null;
      if (o.mode === "insert") {
        if (o.value.trim()) rec = { ...base, new_text: paddedInsert(o.info, o.value), originalText: "", format: o.format };
      } else if (o.mode === "paragraph") {
        const v = o.value.trim();
        if (v && v !== (o.prefill || "").trim()) rec = { ...base, segments: [], new_paragraph: true, uid: o.info.uid, new_text: v, originalText: "", format: o.format };
      } else if (o.mode === "delete") {
        rec = { ...base, new_text: "", originalText: o.info.text, format: "" };
      } else {
        const v = o.value.trim();
        if (v !== (o.info.text || "").trim()) rec = { ...base, new_text: v, originalText: o.info.text || "", format: o.format };
      }
      const idx = o.existing ? staged.indexOf(o.existing) : -1;
      if (rec) {
        rec.localId = o.existing ? o.existing.localId : ++stagedSeq;
        if (idx !== -1) staged[idx] = rec; else staged.push(rec);
      } else if (idx !== -1) staged.splice(idx, 1);
      dismiss();
      repaintStaged();
    }

    function openCard(o) {
      // o: { mode: replace|insert|paragraph, info, existing, anchorRect, contextText, prefill }
      closeCard(); removePill();
      const mode = o.mode;
      const st = RU.fmtFlags(o.existing ? o.existing.format : "");
      const live = mode === "insert" || mode === "paragraph";
      const startValue = o.existing ? o.existing.new_text : (mode === "replace" ? (o.info.text || "") : (o.prefill || ""));
      const input = el("textarea", { class: "rl-main-input", rows: mode === "replace" ? "2" : "3",
        placeholder: mode === "insert" ? "Type the words to add…" : mode === "paragraph" ? "Type the new paragraph…" : "" }, startValue);
      const quote = mode === "replace" ? `Currently: “${shorten(o.info.text, 160) || "(blank)"}”`
        : mode === "paragraph" ? `After: “${shorten(o.contextText, 80)}”` : null;
      const hint = mode === "insert" ? "You can see it in the contract as you type. Nothing existing is removed, and we add spaces around it if needed."
        : mode === "paragraph" ? ((o.prefill ? `Your list uses typed labels, so it starts with “${o.prefill.trim()}”. Change it if you like. ` : "It copies the look of the paragraph above. ") + "Nothing existing is changed.")
        : null;
      let okBtn;
      const syncGhost = () => {
        if (!live) return;
        ghost.edit.new_text = mode === "insert" ? paddedInsert(o.info, input.value) : input.value;
        ghost.edit.format = RU.fmtString(st);
        paintPreview();
      };
      const syncOk = () => {
        const v = input.value.trim();
        if (mode === "insert") okBtn.disabled = !v;
        else if (mode === "paragraph") okBtn.disabled = !v || v === (o.prefill || "").trim();
        else okBtn.disabled = false;
      };
      okBtn = el("button", { class: "btn", onclick: () => commitStaged({ mode, existing: o.existing, info: o.info, value: input.value, format: RU.fmtString(st), prefill: o.prefill }) },
        mode === "insert" ? "Add text" : mode === "paragraph" ? "Add paragraph" : "Stage edit");
      const kids = [
        el("div", { class: "rp-label" }, mode === "insert" ? "Insert text here" : mode === "paragraph" ? "New paragraph below" : "Replace with"),
        quote ? el("div", { class: "rl-quote" }, quote) : null,
        el("div", { class: "rp-label rl-label-row" }, [el("span", {}, mode === "replace" ? "New text" : mode === "insert" ? "New text" : "Paragraph text"), RU.formatButtons(st, syncGhost)]),
        input,
        hint ? el("div", { class: "rl-hint" }, hint) : null,
        el("div", { class: "rp-actions" }, [el("button", { class: "btn secondary", onclick: () => dismiss() }, "Cancel"), okBtn]),
      ];
      if (o.existing) kids.push(el("div", { class: "rp-remove", onclick: () => { staged.splice(staged.indexOf(o.existing), 1); dismiss(); repaintStaged(); } }, "Remove change"));

      let anchorRect = o.anchorRect;
      if (live) {
        ghost = {
          kind: mode, replacesId: o.existing ? o.existing.localId : null,
          edit: { table_path: o.info.table_path, paragraph_index: o.info.paragraph_index, segments: o.info.segments, new_paragraph: mode === "paragraph", new_text: mode === "insert" ? paddedInsert(o.info, startValue) : startValue, format: RU.fmtString(st) },
        };
        paintPreview();
        const g = preview.querySelector(".fv-ghost, .newp-mark.ghost");
        if (g) {
          // Keep the spot in view inside the scrolling preview.
          g.scrollIntoView({ block: "nearest" });
          anchorRect = g.getBoundingClientRect();
        }
      }
      const pop = el("div", { class: "redline-popover rl-card" }, kids);
      document.body.appendChild(pop);
      RU.place(pop, anchorRect || { left: 20, bottom: 80, top: 60 }, 320);
      activePopover = pop;
      input.addEventListener("input", () => { syncGhost(); syncOk(); });
      syncOk();
      input.focus();
      if (mode !== "replace") { try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {} }
    }

    function overlapsStaged(info, ignore) {
      if (info.new_paragraph) return false;
      return staged.some((e) => {
        if (e === ignore || e.new_paragraph) return false;
        if (e.table_path !== info.table_path || e.paragraph_index !== info.paragraph_index) return false;
        return e.segments.some((a) => info.segments.some((b) => {
          if (a.r !== b.r) return false;
          const aZero = a.start === a.end, bZero = b.start === b.end;
          if (aZero && bZero) return a.start === b.start;
          if (aZero) return a.start > b.start && a.start < b.end;
          if (bZero) return b.start > a.start && b.start < a.end;
          return a.start < b.end && b.start < a.end;
        }));
      });
    }

    function startParagraph(info, rect) {
      const above = pristineParaText(info.table_path, info.paragraph_index);
      const label = RU.nextLabel(above);
      openCard({ mode: "paragraph", info: { table_path: info.table_path, paragraph_index: info.paragraph_index, segments: [], new_paragraph: true, uid: ++newParaSeq, text: "" }, anchorRect: rect, contextText: above, prefill: label });
    }

    function editStaged(e, rect) {
      const kind = stagedKind(e);
      const info = { table_path: e.table_path, paragraph_index: e.paragraph_index, segments: e.segments, text: e.originalText, new_paragraph: !!e.new_paragraph, uid: e.uid };
      openCard({ mode: kind === "delete" ? "replace" : kind, info, existing: e, anchorRect: rect,
        contextText: kind === "paragraph" ? pristineParaText(e.table_path, e.paragraph_index) : "", prefill: "" });
    }

    function onMarkClick(markEl) {
      const e = staged.find((x) => String(x.localId) === markEl.getAttribute("data-staged-id"));
      if (!e) return;
      dismiss();
      const marks = Array.from(preview.querySelectorAll(`[data-staged-id="${e.localId}"]`));
      marks.forEach((n) => n.classList.add("selected"));
      const rect = marks[marks.length - 1].getBoundingClientRect();
      pill = RU.pill([
        { label: "✎ Edit", onClick: () => editStaged(e, rect) },
        { label: "Remove", cls: "warn", onClick: () => { staged.splice(staged.indexOf(e), 1); dismiss(); repaintStaged(); } },
      ], rect);
    }

    preview.addEventListener("mouseup", (ev) => {
      const target = ev.target;
      setTimeout(() => {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          if (!preview.contains(range.commonAncestorContainer)) return;
          const rect = range.getBoundingClientRect();
          const info = RU.selectionInfo(preview, range);
          const hl = range.cloneRange();
          sel.removeAllRanges();
          if (!info) return;
          if (info.error === "cross-paragraph") { alert("Please select text within a single paragraph."); return; }
          if (!info.text.trim()) return;
          dismiss();
          if (overlapsStaged(info)) { alert("Part of that is already in a change you've staged below. Click the mark to edit or remove it, or pick different words."); return; }
          highlight(hl);
          pill = RU.pill([
            { label: "✎ Replace", onClick: () => openCard({ mode: "replace", info, anchorRect: rect }) },
            { label: "🗑 Delete", cls: "warn", onClick: () => commitStaged({ mode: "delete", info, value: "", format: "" }) },
          ], rect);
          return;
        }
        const markEl = target.closest ? target.closest("[data-staged-id]") : null;
        if (markEl && preview.contains(markEl)) { onMarkClick(markEl); return; }
        const runEl = target.closest ? target.closest(".run") : null;
        if (!runEl || !preview.contains(runEl)) { dismiss(); return; }
        const fallback = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
        const info = RU.caretInfo(preview, ev.clientX, ev.clientY, fallback);
        dismiss();
        if (!info) return;
        const loc = { table_path: info.table_path, paragraph_index: info.paragraph_index, segments: info.segments, text: "" };
        const existing = staged.find((x) => !x.new_paragraph && x.segments.length === 1 && x.segments[0].r === loc.segments[0].r && x.segments[0].start === loc.segments[0].start && x.segments[0].end === loc.segments[0].end && x.paragraph_index === loc.paragraph_index && x.table_path === loc.table_path);
        if (existing) { editStaged(existing, info.rect); return; }
        // Show the blinking caret where the words would go.
        ghost = { kind: "insert", replacesId: null, edit: { ...loc, new_paragraph: false, new_text: "", format: "" } };
        paintPreview();
        const g = preview.querySelector(".fv-ghost");
        const rect = g ? g.getBoundingClientRect() : info.rect;
        pill = RU.pill([
          { label: "＋ Insert text here", onClick: () => openCard({ mode: "insert", info: loc, anchorRect: rect }) },
          { label: "¶ New paragraph below", onClick: () => startParagraph(loc, rect) },
        ], rect);
      }, 0);
    });
  }

  if (nextSteps) {
    box.appendChild(el("div", { class: "next-heading" }, "What\u2019s next for this contract?"));
    box.appendChild(nextSteps);
  } else {
    const actions = el("div", { class: "panel-actions" });
    if (generatedId) {
      actions.appendChild(el("a", { class: "btn", href: `/api/generated/${generatedId}/download` }, "Download .docx"));
    }
    if (extraButtons) extraButtons.forEach((b) => actions.appendChild(b));
    actions.appendChild(el("button", { class: "btn secondary", onclick: () => closeOverlay() }, "Close"));
    box.appendChild(actions);
  }

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
  // panel would render on top of this modal and block its Close button.
  document.querySelectorAll(".panel-overlay").forEach((o) => o.remove());
  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", {}, el("p", { class: "subtitle" }, "Loading..."));
  const modal = el("div", { class: "modal share-modal" }, [el("h2", {}, "Share for review"), body]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // A brand-new share link needs a real client attached (first name, last
  // name, valid email -- see main.create_share_link). An EXISTING link never
  // gets blocked by that. So: try the plain lookup first; if the server says
  // it needs the client's info, show the intake form instead of a raw error.
  const NEEDS_INTAKE = "Enter the client's first name, last name, and email";

  // People this account has shared with before -- suggestions while typing.
  // Best-effort: no suggestions if it fails.
  let recents = [];
  try { recents = await api("/api/recipients"); } catch (e) { /* suggestions are optional */ }

  function recipientList() {
    return el("datalist", { id: "recipient-suggestions" },
      recents.map((r) => el("option", { value: r.email }, [r.first_name, r.last_name].filter(Boolean).join(" "))));
  }

  // Picking a remembered email fills in the name boxes (only if still empty).
  function wireSuggestions(emailInput, firstInput, lastInput) {
    emailInput.setAttribute("list", "recipient-suggestions");
    emailInput.addEventListener("input", () => {
      const hit = recents.find((r) => r.email.toLowerCase() === emailInput.value.trim().toLowerCase());
      if (!hit) return;
      if (!firstInput.value.trim()) firstInput.value = hit.first_name || "";
      if (!lastInput.value.trim()) lastInput.value = hit.last_name || "";
      firstInput.dispatchEvent(new Event("change"));
    });
  }

  function initials(first, last, email) {
    const f = (first || "").trim(), l = (last || "").trim();
    return ((f[0] || "") + (l[0] || "")).toUpperCase() || (email || "?")[0].toUpperCase();
  }

  function fmtSent(iso) {
    const d = new Date(iso);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function copyRow(label, value) {
    return el("div", { class: "share-row" }, [
      el("div", { class: "share-row-text" }, [el("div", { class: "k" }, label), el("div", { class: "v", title: value }, value)]),
      el("button", { class: "btn secondary small copy-btn", onclick: (e) => copyToClipboard(value, e.currentTarget) }, "Copy"),
    ]);
  }

  function renderShareInfo(share) {
    const linkUrl = `${location.origin}${share.url}`;
    body.innerHTML = "";
    let editingRecipient = false, editingReply = false;

    async function save(fields) {
      return api(`/api/generated/${generatedId}/share`, { method: "POST", body: fields });
    }

    function draw() {
      body.innerHTML = "";
      const clientName = [share.client_first_name, share.client_last_name].filter(Boolean).join(" ");

      // ---- who it's for (asked once; edit in place) ----
      if (!editingRecipient) {
        body.appendChild(el("div", { class: "recipient-card" }, [
          el("div", { class: "avatar" }, initials(share.client_first_name, share.client_last_name, share.client_email)),
          el("div", { class: "recipient-text" }, [
            el("div", { class: "recipient-name" }, clientName || share.client_email || "No recipient"),
            clientName ? el("div", { class: "recipient-email" }, share.client_email) : null,
          ]),
          el("button", { class: "link-btn", onclick: () => { editingRecipient = true; draw(); } }, "Change"),
        ]));
      } else {
        const f = el("input", { type: "text", placeholder: "First name", value: share.client_first_name || "" });
        const l = el("input", { type: "text", placeholder: "Last name", value: share.client_last_name || "" });
        const em = el("input", { type: "email", placeholder: "Email", value: share.client_email || "" });
        wireSuggestions(em, f, l);
        const err = el("div", {});
        body.appendChild(el("div", { class: "recipient-edit" }, [
          recipientList(),
          el("div", { class: "field-grid" }, [f, l]), em, err,
          el("div", { class: "inline-actions" }, [
            el("button", { class: "btn secondary small", onclick: () => { editingRecipient = false; draw(); } }, "Cancel"),
            el("button", { class: "btn small", onclick: async (e) => {
              err.innerHTML = "";
              const btn = e.currentTarget; btn.disabled = true;
              try {
                share = await save({ client_first_name: f.value.trim(), client_last_name: l.value.trim(), client_email: em.value.trim(), sender_email: share.sender_email || "" });
                editingRecipient = false; draw();
              } catch (ex) { btn.disabled = false; err.appendChild(el("div", { class: "error-box" }, ex.message)); }
            } }, "Save"),
          ]),
        ]));
      }

      // ---- did the email actually go out? ----
      const status = el("div", { class: "share-status " + (share.emailed_at ? "ok" : "warn") });
      if (share.emailed_at) {
        status.appendChild(el("span", { class: "share-status-icon" }, "✓"));
        status.appendChild(el("span", { class: "share-status-text" }, `Emailed to ${share.client_email} · ${fmtSent(share.emailed_at)}`));
        status.appendChild(el("button", { class: "link-btn", onclick: (e) => resend(e.currentTarget, status) }, "Send again"));
      } else {
        status.appendChild(el("span", { class: "share-status-icon" }, "!"));
        status.appendChild(el("span", { class: "share-status-text" }, `${share.client_first_name ? share.client_first_name + " hasn't" : "They haven't"} been emailed yet. Send it now, or copy the link and code below.`));
        status.appendChild(el("button", { class: "link-btn", onclick: (e) => resend(e.currentTarget, status) }, "Send email"));
      }
      body.appendChild(status);

      // ---- link + code ----
      body.appendChild(el("div", { class: "share-links" }, [copyRow("Review link", linkUrl), copyRow("Access code", share.access_code)]));
      body.appendChild(el("p", { class: "share-note" }, "Anyone with the link and the code can open this document."));

      // ---- reply-to (collapsed) ----
      const replyTo = share.sender_email || (state.user && state.user.email) || "your login email";
      if (!editingReply) {
        body.appendChild(el("div", { class: "share-note" }, [
          `Replies go to ${replyTo} · `,
          el("button", { class: "link-btn", onclick: () => { editingReply = true; draw(); } }, "Change"),
        ]));
      } else {
        const s = el("input", { type: "email", placeholder: "you@company.com (blank = your login email)", value: share.sender_email || "" });
        const err = el("div", {});
        body.appendChild(el("div", { class: "recipient-edit" }, [
          el("label", { class: "field-label" }, "Reply-to email (shown to the client)"), s, err,
          el("div", { class: "inline-actions" }, [
            el("button", { class: "btn secondary small", onclick: () => { editingReply = false; draw(); } }, "Cancel"),
            el("button", { class: "btn small", onclick: async (e) => {
              err.innerHTML = ""; const btn = e.currentTarget; btn.disabled = true;
              try { share = await save({ sender_email: s.value.trim() }); editingReply = false; draw(); }
              catch (ex) { btn.disabled = false; err.appendChild(el("div", { class: "error-box" }, ex.message)); }
            } }, "Save"),
          ]),
        ]));
      }

      // ---- actions ----
      body.appendChild(el("div", { class: "modal-actions share-actions" }, [
        el("button", { class: "link-btn danger", onclick: async (e) => {
          if (!confirm("Close this review link? The client won't be able to open it or submit further redlines. You can share a fresh link afterward if needed.")) return;
          const btn = e.currentTarget; btn.disabled = true;
          try { await api(`/api/generated/${generatedId}/share/close`, { method: "POST" }); overlay.remove(); }
          catch (err) { btn.disabled = false; alert(err.message); }
        } }, "Close review link"),
        el("button", { class: "btn", onclick: () => overlay.remove() }, "Done"),
      ]));
    }

    async function resend(btn, statusEl) {
      btn.disabled = true; btn.textContent = "Sending...";
      try {
        share = await api(`/api/generated/${generatedId}/share/email`, { method: "POST" });
        draw();
      } catch (ex) {
        btn.disabled = false; btn.textContent = "Try again";
        statusEl.querySelector(".share-status-text").textContent = ex.message;
      }
    }

    draw();
  }

  function renderIntakeForm(errMsg) {
    body.innerHTML = "";
    body.appendChild(el("p", { class: "subtitle share-sub" }, "Who is reviewing this? We'll email them the link and access code, and use their name on their comments."));
    const errBox = el("div", {});
    if (errMsg) errBox.appendChild(el("div", { class: "error-box" }, errMsg));
    const emailInput = el("input", { type: "email", placeholder: "client@company.com", autocomplete: "off" });
    const firstNameInput = el("input", { type: "text", placeholder: "Jamie" });
    const lastNameInput = el("input", { type: "text", placeholder: "Rivera" });
    wireSuggestions(emailInput, firstNameInput, lastNameInput);
    body.appendChild(recipientList());
    body.appendChild(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Email"), emailInput]));
    body.appendChild(el("div", { class: "field-grid" }, [
      el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "First name"), firstNameInput]),
      el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Last name"), lastNameInput]),
    ]));
    body.appendChild(errBox);
    const createBtn = el("button", { class: "btn" }, "Share for review");
    createBtn.addEventListener("click", async () => {
      errBox.innerHTML = "";
      const first = firstNameInput.value.trim(), last = lastNameInput.value.trim(), email = emailInput.value.trim();
      if (!first || !last || !email) {
        errBox.appendChild(el("div", { class: "error-box" }, "First name, last name, and email are all required."));
        return;
      }
      createBtn.disabled = true;
      createBtn.textContent = "Sharing...";
      try {
        const share = await api(`/api/generated/${generatedId}/share`, {
          method: "POST",
          body: { client_first_name: first, client_last_name: last, client_email: email },
        });
        renderShareInfo(share);
      } catch (err) {
        errBox.appendChild(el("div", { class: "error-box" }, err.message));
        createBtn.disabled = false;
        createBtn.textContent = "Share for review";
      }
    });
    body.appendChild(el("div", { class: "modal-actions" }, [el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"), createBtn]));
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
// Upload a document straight to e-signature, skipping Draft entirely --
// for a contract someone else already wrote, or a one-off the owner
// doesn't want turned into a reusable master document. Posts to
// /api/documents/upload-for-signature, then immediately opens the normal
// openSignatureModal intake form for the document it creates -- from that
// point on it's indistinguishable from any other document.
// ---------------------------------------------------------------------------

function openUploadForSignatureModal(onDone) {
  document.querySelectorAll(".panel-overlay, .modal-overlay").forEach((o) => o.remove());
  const overlay = el("div", { class: "modal-overlay" });

  const nameInput = el("input", { type: "text", placeholder: "Defaults to the file name" });
  const typeSelect = el("select", {}, state.documentTypes.map((t) => el("option", { value: t }, t)));
  const customTypeInput = el("input", { type: "text", placeholder: "Type a custom document type", style: "display:none;margin-top:8px;" });
  typeSelect.appendChild(el("option", { value: "__custom__" }, "Custom..."));
  typeSelect.addEventListener("change", () => {
    customTypeInput.style.display = typeSelect.value === "__custom__" ? "block" : "none";
  });
  const fileInput = el("input", { type: "file", accept: ".docx" });
  const errBox = el("div", {});
  const uploadBtn = el("button", { class: "btn" }, "Upload and continue");

  uploadBtn.addEventListener("click", async () => {
    errBox.innerHTML = "";
    if (!fileInput.files[0]) {
      errBox.appendChild(el("div", { class: "error-box" }, "Choose a .docx file first."));
      return;
    }
    const docType = typeSelect.value === "__custom__" ? customTypeInput.value.trim() || "Other" : typeSelect.value;
    const fd = new FormData();
    fd.append("name", nameInput.value.trim());
    fd.append("document_type", docType);
    fd.append("file", fileInput.files[0]);
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading...";
    try {
      const res = await fetch("/api/documents/upload-for-signature", { method: "POST", body: fd, credentials: "same-origin" });
      if (!res.ok) {
        let msg = res.statusText || `Something went wrong (error ${res.status}). Please try again.`;
        try {
          const data = await res.json();
          msg = (data && (typeof data.detail === "object" ? data.detail.message : data.detail)) || msg;
        } catch (e) {}
        throw new Error(msg);
      }
      const doc = await res.json();
      overlay.remove();
      if (typeof onDone === "function") onDone();
      openSignatureModal(doc.generated_id);
    } catch (e) {
      errBox.appendChild(el("div", { class: "error-box" }, e.message));
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = "Upload and continue";
    }
  });

  const modal = el("div", { class: "modal" }, [
    el("h2", {}, "Upload document to sign"),
    el("p", { class: "subtitle" }, "Send a document straight out for signature -- no need to draft it here first."),
    el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Word document (.docx)"), fileInput]),
    el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Document name"), nameInput]),
    el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Document type"), typeSelect, customTypeInput]),
    errBox,
    el("div", { class: "modal-actions" }, [el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"), uploadBtn]),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// E-signature: send a finished document out through DocuSeal for signing.
// Mirrors openShareModal's shape (intake form -> created-state view) but for
// /api/generated/{id}/signature-request instead of /share. Any number of
// signers (up to 10), each with a role label the owner types (Client, CEO,
// CFO...), optionally signing in order.
// ---------------------------------------------------------------------------

async function openSignatureModal(generatedId) {
  document.querySelectorAll(".panel-overlay").forEach((o) => o.remove());
  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", {}, el("p", { class: "subtitle" }, "Loading..."));
  const modal = el("div", { class: "modal", style: "width:700px;" }, [el("h2", {}, "Send for signature"), body]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function statusLabel(s) {
    return { awaiting_consent: "Awaiting consent", ready_to_sign: "Ready to sign", completed: "Signed", declined: "Declined" }[s] || s;
  }

  // ---- evidence: our photo check next to DocuSeal's own record ----------
  function hasEvidence(s) {
    return !!(s.consent_given_at || s.has_photo || s.has_id_photo || s.ds_completed_at);
  }

  function fmtWhen(iso) {
    if (!iso) return "\u2014";
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
    return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function deviceLabel(ua) {
    if (!ua) return "\u2014";
    const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
      : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS"
      : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
    return os ? `${browser} on ${os}` : browser;
  }

  function evidenceRow(label, value) {
    return el("div", { class: "evidence-row" }, [el("div", { class: "evidence-k" }, label), el("div", { class: "evidence-v" }, value)]);
  }

  function evidencePhoto(sr, s, kind, has, captured) {
    const requested = kind === "selfie" ? sr.photo_check !== "none" : sr.photo_check === "selfie_id";
    if (!has) return el("span", { class: "evidence-muted" }, requested ? "Not captured yet" : "Not requested");
    const url = `/api/generated/${generatedId}/signature-request/signers/${s.signer_id}/photo/${kind}`;
    const img = el("img", { class: "evidence-photo", src: url, alt: kind === "selfie" ? "Selfie" : "Photo ID" });
    img.addEventListener("error", () => img.replaceWith(el("span", { class: "evidence-muted" }, "Photo unavailable")));
    return el("div", {}, [
      el("a", { href: url, target: "_blank", rel: "noopener" }, [img]),
      el("div", { class: "evidence-muted" }, `Taken ${fmtWhen(captured)}`),
    ]);
  }

  function toggleEvidence(btn, s, rowEl) {
    const existing = rowEl.nextElementSibling;
    if (existing && existing.classList.contains("evidence-panel")) {
      existing.remove();
      btn.textContent = "Evidence";
      return;
    }
    const sr = currentSr;
    // Only mention photos when the sender asked for them (or one exists from
    // before) -- a "no photo" send shouldn't show Selfie / Photo ID rows or
    // the photo disclaimer at all.
    const wantsSelfie = sr.photo_check === "selfie" || sr.photo_check === "selfie_id" || s.has_photo;
    const wantsId = sr.photo_check === "selfie_id" || s.has_id_photo;
    const rotelyRows = [
      el("div", { class: "evidence-title" }, "Rotely check"),
      evidenceRow("Agreed to sign", fmtWhen(s.consent_given_at)),
    ];
    if (wantsSelfie) rotelyRows.push(evidenceRow("Selfie", evidencePhoto(sr, s, "selfie", s.has_photo, s.photo_captured_at)));
    if (wantsId) rotelyRows.push(evidenceRow("Photo ID", evidencePhoto(sr, s, "id", s.has_id_photo, s.id_photo_captured_at)));
    const panel = el("div", { class: "evidence-panel" }, [
      el("div", { class: "evidence-col" }, rotelyRows),
      el("div", { class: "evidence-col" }, [
        el("div", { class: "evidence-title" }, "DocuSeal check"),
        evidenceRow("Opened", fmtWhen(s.ds_opened_at)),
        evidenceRow("Signed", fmtWhen(s.ds_completed_at)),
        evidenceRow("IP address", s.ds_ip || "\u2014"),
        evidenceRow("Device", el("span", { title: s.ds_user_agent || "" }, deviceLabel(s.ds_user_agent))),
      ]),
      (wantsSelfie || wantsId)
        ? el("div", { class: "evidence-note" }, "Photos show who was in front of the camera when this was signed. Rotely doesn't compare the selfie to the ID, so look at them side by side yourself. Stored encrypted; only you can open them.")
        : null,
    ]);
    rowEl.after(panel);
    btn.textContent = "Hide evidence";
  }

  function waitDaysText(days) {
    return days < 1 ? "since today" : days === 1 ? "1 day" : `${days} days`;
  }

  // Sends a "still waiting on you" email to one signer (position given) or
  // to everyone who can sign right now (position omitted).
  async function sendReminder(btn, position) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending...";
    try {
      const res = await api(`/api/generated/${generatedId}/signature-request/remind`, {
        method: "POST",
        body: position === undefined ? {} : { position },
      });
      renderStatusView(res);
      const note = el("div", { class: "info-box" }, `Reminder sent to ${res.reminded.join(", ")}.`);
      body.insertBefore(note, body.firstChild);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      alert(err.message);
    }
  }

  let currentSr = null;
  function renderStatusView(sr) {
    currentSr = sr;
    body.innerHTML = "";
    body.appendChild(el("p", { class: "subtitle" }, "Sent through DocuSeal. Each signer first " + ({ none: "agrees to sign electronically", selfie: "agrees and takes a selfie", selfie_id: "agrees and takes a selfie and a photo of their ID" }[sr.photo_check || "none"]) + " on Rotely's own page before reaching the actual signing form." + (sr.sign_in_order ? " Signers sign in the order listed -- each one is emailed when the person before them has signed." : "")));
    // Bug tracker #55: nothing told the owner that a signature request only
    // ever updates itself automatically if DocuSeal's webhook is actually
    // configured -- without it, this modal could sit on "Pending" forever
    // even after the document is fully signed, with no clue why. Surface
    // the exact URL to add in DocuSeal's dashboard whenever that env var
    // isn't set (the backend reports this honestly via webhook_configured,
    // not guessed client-side), and only while there's still something to
    // wait on.
    if (!sr.webhook_configured && sr.status === "pending") {
      body.appendChild(
        el("div", { class: "warn-box" }, [
          el("strong", {}, "Status won't update automatically yet. "),
          "Add this URL as a webhook endpoint in your DocuSeal account (Settings → Webhooks) to get live updates, or use “Check for updates” below in the meantime: ",
          el("code", {}, sr.webhook_url || `${location.origin}/api/webhooks/docuseal`),
        ])
      );
    }
    // The request's own state, front and centre -- a cancelled, declined or
    // expired request used to look just like a live one (signers still
    // "Awaiting consent" with links), with no way to start over.
    const ended = ["cancelled", "declined", "expired"].includes(sr.status);
    const banner = {
      cancelled: "This request was cancelled. Nobody can sign it anymore.",
      declined: "A signer declined, so this request was stopped. Nobody can sign it anymore.",
      expired: "This request expired. Nobody can sign it anymore.",
      completed: "Everyone has signed.",
    }[sr.status];
    if (banner) body.appendChild(el("div", { class: ended ? "warn-box" : "info-box" }, banner));
    const list = el("div", { class: "share-info-box" });
    sr.signers.forEach((s) => {
      const linkUrl = `${location.origin}${s.sign_url}`;
      const live = sr.status === "pending";
      const notSigned = ended && s.status !== "completed" && s.status !== "declined";
      const isWaiting = !!s.waiting_since;
      const waitingNote = isWaiting
        ? `Waiting ${waitDaysText(s.days_waiting)}${s.reminder_count ? ` \u00b7 reminded ${s.reminder_count} time${s.reminder_count === 1 ? "" : "s"}` : ""}`
        : "";
      const rowEl =
        el("div", { class: "row" }, [
          el("div", { style: "min-width:0;" }, [
            el("div", { class: "k" }, `${sr.sign_in_order ? (s.position + 1) + ". " : ""}${s.name} (${s.role})`),
            el("div", { class: "v" }, notSigned
              ? "Didn't sign"
              : live && s.status !== "completed" && s.status !== "declined" && sr.sign_in_order && s.your_turn === false
                ? "Waiting for the signer(s) before them"
                : `${statusLabel(s.status)}${live && (s.status === "awaiting_consent" || s.status === "ready_to_sign") ? " -- " + linkUrl : ""}`),
            waitingNote ? el("div", { class: "v waiting-note" + (s.days_waiting >= 3 ? " overdue" : "") }, waitingNote) : null,
          ]),
          el("div", { class: "row-actions" }, [
            hasEvidence(s) ? el("button", { class: "btn secondary small", onclick: (e) => toggleEvidence(e.currentTarget, s, rowEl) }, "Evidence") : null,
            isWaiting ? el("button", { class: "btn secondary small", onclick: (e) => sendReminder(e.currentTarget, s.position) }, "Remind") : null,
            live && s.status !== "completed" ? el("button", { class: "btn secondary small copy-btn", onclick: (e) => copyToClipboard(linkUrl, e.currentTarget) }, "Copy link") : null,
          ]),
        ]);
      list.appendChild(rowEl);
    });
    body.appendChild(list);

    const actions = [];
    if (sr.status === "pending" && (sr.waiting_on || []).length > 1) {
      actions.push(el("button", { class: "btn secondary", onclick: (e) => sendReminder(e.currentTarget) }, "Remind everyone waiting"));
    }
    if (sr.status === "pending") {
      // Bug tracker #55: the only way "pending" ever moved before was
      // DocuSeal's webhook firing -- never configured, or a delivery lost,
      // and a fully-signed document just sat here forever with nothing in
      // the UI to do about it. This hits the same reconciliation endpoint
      // the backend would otherwise only run from a webhook, on demand.
      actions.push(
        el(
          "button",
          {
            class: "btn secondary",
            onclick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              btn.textContent = "Checking...";
              try {
                const refreshed = await api(`/api/generated/${generatedId}/signature-request/refresh`, { method: "POST" });
                renderStatusView(refreshed);
              } catch (err) {
                btn.disabled = false;
                btn.textContent = "Check for updates";
                alert(err.message);
              }
            },
          },
          "Check for updates"
        )
      );
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
                // Stay in the modal on the cancelled state, where "Send again"
                // is one click away.
                renderStatusView(await api(`/api/generated/${generatedId}/signature-request`));
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
    if (ended) {
      // Start over on the same document: the people and roles come back
      // prefilled (change anyone's name/email), and any signature fields
      // already placed are kept.
      actions.push(
        el("button", {
          class: "btn",
          onclick: () => renderIntakeForm({
            signers: sr.signers.map((s) => ({ name: s.name, email: s.email, role: s.role })),
            sign_in_order: !!sr.sign_in_order,
            photo_check: sr.photo_check || "none",
          }),
        }, "Send again")
      );
    }
    actions.push(el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Close"));
    body.appendChild(el("div", { class: "modal-actions" }, actions));
  }

  // Highlight-to-field flow (replaces the old DocuSeal Form Builder
  // embed): the owner highlights any text in the document -- the ______,
  // a "Signature:" line, whatever -- and that exact range becomes a
  // signature field assigned to a signer. Same interaction as Google
  // Docs eSignature. Field placements are stored as data on the
  // GeneratedContract (see main.py's place_signature_field); the DocuSeal
  // text tags are only spliced into a throwaway copy at send time.

  // identities: { signers: [{name, email, role}], sign_in_order }
  // collected by renderIntakeForm below, passed through unchanged once the
  // owner clicks "Continue to send" here -- this step only ever places
  // fields, it doesn't re-collect who's signing.
  async function renderFieldPlacer(identities) {
    body.innerHTML = "";
    body.appendChild(el("p", { class: "subtitle" }, "Highlight any text in the document (like the ______) to turn it into a signature field, then pick who signs it. Placed fields are highlighted below -- remove one anytime before sending."));
    const errBox = el("div", {});
    const previewWrap = el("div", { class: "esign-preview" });
    const fieldListWrap = el("div", { class: "esign-field-list" });
    body.appendChild(previewWrap);
    body.appendChild(fieldListWrap);
    body.appendChild(errBox);

    const toolbar = el("div", { class: "esign-toolbar" }, [el("button", {}, "Make signature field")]);
    body.appendChild(toolbar);
    let currentSelection = null;
    let currentFields = [];

    function hideToolbar() {
      toolbar.style.display = "none";
      currentSelection = null;
    }

    // Turn the backend's data-field-key="sigfield:{i}" markers into
    // visible badges showing each field's role and type.
    function decorateBadges() {
      previewWrap.querySelectorAll(".run.field-value[data-field-key]").forEach((runEl) => {
        const m = /^sigfield:(\d+)$/.exec(runEl.dataset.fieldKey || "");
        if (!m || runEl.querySelector(".esign-badge")) return;
        const f = currentFields[parseInt(m[1], 10)];
        if (!f) return;
        const badge = el("span", { class: "esign-badge" }, `\u270D ${f.role} ${f.field_type}`);
        runEl.appendChild(badge);
      });
    }

    function renderFieldList() {
      fieldListWrap.innerHTML = "";
      // Per-signer coverage, so it's obvious who still has nowhere to sign.
      fieldListWrap.appendChild(
        el("div", { class: "esign-coverage" }, identities.signers.map((s) => {
          const n = currentFields.filter((f) => f.role === s.role).length;
          return el("span", { class: "esign-cov-chip" + (n ? "" : " empty"), title: s.name }, `${s.role}: ${n ? n + " field" + (n > 1 ? "s" : "") : "no field yet"}`);
        }))
      );
      if (!currentFields.length) {
        fieldListWrap.appendChild(el("p", { class: "subtitle" }, "No fields placed yet."));
        return;
      }
      currentFields.forEach((f, i) => {
        const row = el("div", { class: "esign-field-chip" }, [
          el("div", {}, [
            el("div", { class: "k" }, `\u270D ${f.label}`),
            el("div", { class: "t" }, `assigned to ${f.role} \u00B7 "${(f.original_text || "").slice(0, 40)}${(f.original_text || "").length > 40 ? "..." : ""}"`),
          ]),
          el("button", {}, "Remove"),
        ]);
        row.querySelector("button").addEventListener("click", async () => {
          errBox.innerHTML = "";
          try {
            const data = await api(`/api/generated/${generatedId}/signature-fields/${i}`, { method: "DELETE" });
            paintPreview(data);
          } catch (e) {
            errBox.appendChild(el("div", { class: "error-box" }, e.message));
          }
        });
        fieldListWrap.appendChild(row);
      });
    }

    function paintPreview(data) {
      currentFields = data.fields || [];
      previewWrap.innerHTML = data.html || "";
      decorateBadges();
      renderFieldList();
      hideToolbar();
    }

    async function reloadPreview() {
      errBox.innerHTML = "";
      try {
        const data = await api(`/api/generated/${generatedId}/esign-preview`);
        paintPreview(data);
      } catch (e) {
        errBox.appendChild(el("div", { class: "error-box" }, e.message));
      }
    }

    previewWrap.addEventListener("mouseup", () => {
      setTimeout(() => {
        const info = computeSelectionSegments(previewWrap);
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
        toolbar.style.top = Math.max(8, rect.top - 46) + "px";
        toolbar.style.display = "block";
      }, 0);
    });

    toolbar.querySelector("button").addEventListener("click", () => {
      const sel = currentSelection;
      if (!sel) return;
      hideToolbar();
      openPlaceFieldModal(sel);
    });

    function openPlaceFieldModal(selectionInfo) {
      const overlay2 = el("div", { class: "modal-overlay" });
      const inner = el("div", { class: "modal", style: "width:440px;" });
      const errBox2 = el("div", {});
      const roleSelect = el("select", {}, identities.signers.map((s) => el("option", { value: s.role }, `${s.role} (${s.name})`)));
      const typeSelect = el("select", {}, [
        el("option", { value: "signature" }, "Signature"),
        el("option", { value: "initials" }, "Initials"),
        el("option", { value: "date" }, "Date"),
        el("option", { value: "text" }, "Text"),
      ]);
      inner.appendChild(el("h3", {}, "Make signature field"));
      inner.appendChild(el("p", { class: "subtitle" }, `Selected: "${(selectionInfo.text || "").slice(0, 80)}${(selectionInfo.text || "").length > 80 ? "..." : ""}"`));
      inner.appendChild(el("div", { class: "form-row" }, [el("label", { class: "field-label" }, "Who signs it"), roleSelect]));
      inner.appendChild(el("div", { class: "form-row", style: "margin-top:10px;" }, [el("label", { class: "field-label" }, "Field type"), typeSelect]));
      inner.appendChild(errBox2);
      const placeBtn = el("button", { class: "btn", style: "margin-top:12px;" }, "Place field");
      placeBtn.addEventListener("click", async () => {
        errBox2.innerHTML = "";
        placeBtn.disabled = true;
        try {
          const data = await api(`/api/generated/${generatedId}/signature-fields`, {
            method: "POST",
            body: {
              paragraph_index: selectionInfo.paragraph_index,
              table_path: selectionInfo.table_path,
              segments: selectionInfo.segments,
              expected_text: selectionInfo.text,
              role: roleSelect.value,
              field_type: typeSelect.value,
            },
          });
          overlay2.remove();
          paintPreview(data);
        } catch (e) {
          errBox2.appendChild(el("div", { class: "error-box" }, e.message));
          placeBtn.disabled = false;
        }
      });
      inner.appendChild(
        el("div", { class: "modal-actions" }, [
          el("button", { class: "btn secondary", onclick: () => overlay2.remove() }, "Cancel"),
          placeBtn,
        ])
      );
      overlay2.appendChild(inner);
      body.appendChild(overlay2);
    }

    const continueBtn = el("button", { class: "btn", style: "margin-top:14px;" }, "Continue to send");
    continueBtn.addEventListener("click", async () => {
      errBox.innerHTML = "";
      continueBtn.disabled = true;
      continueBtn.textContent = "Sending...";
      try {
        const reqBody = { signers: identities.signers, sign_in_order: identities.sign_in_order, photo_check: identities.photo_check || "none" };
        const sr = await api(`/api/generated/${generatedId}/signature-request`, { method: "POST", body: reqBody });
        renderStatusView(sr);
      } catch (err) {
        errBox.appendChild(el("div", { class: "error-box" }, err.message));
        continueBtn.disabled = false;
        continueBtn.textContent = "Continue to send";
      }
    });
    body.appendChild(
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn secondary", onclick: () => { toolbar.remove(); renderIntakeForm(identities); } }, "Back"),
        continueBtn,
      ])
    );

    await reloadPreview();
  }

  async function renderIntakeForm(prev) {
    body.innerHTML = "";
    const errBox = el("div", {});

    // Friction fix: if this document already has an open share link, the
    // client's name and email were already collected at that step -- just
    // in a different shape (first/last split there vs. one combined name
    // field here). Prefill from it instead of asking again from scratch.
    // Best-effort: any failure here just leaves the fields blank.
    let shareInfo = { exists: false };
    try {
      shareInfo = await api(`/api/generated/${generatedId}/share-link`);
    } catch (e) {
      // not worth blocking the modal over
    }
    const prefillName = shareInfo.exists
      ? [shareInfo.client_first_name, shareInfo.client_last_name].filter(Boolean).join(" ")
      : "";

    // Fields already placed on this document (from an earlier pass through
    // the next step). A signer who has fields can't be removed or have
    // their role renamed -- those fields would point at nobody -- so we
    // load them up front to lock those rows. Best-effort like the above.
    let placedFields = [];
    try {
      placedFields = (await api(`/api/generated/${generatedId}/esign-preview`)).fields || [];
    } catch (e) {
      // no fields known -> nothing locked; the server still checks at send
    }
    const fieldCount = (role) => placedFields.filter((f) => f.role === role).length;

    const MAX_SIGNERS = 10;
    const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,39}$/;
    const rows = []; // { nameInput, emailInput, roleInput, lockedRole }
    const listWrap = el("div", { class: "signer-list" });
    const addRowBtn = el("button", { class: "btn secondary small", type: "button" }, "+ Add signer");
    const addMeBtn = el("button", { class: "btn secondary small", type: "button" }, "+ Add me");
    const orderInput = el("input", { type: "checkbox" });
    const orderWrap = el("div", { class: "form-row", style: "margin-top:12px;display:none;" }, [
      el("label", { style: "display:flex;gap:8px;align-items:center;cursor:pointer;" }, [orderInput, "Signers must sign in this order (top to bottom)"]),
      el("p", { class: "subtitle", style: "margin:2px 0 0;" }, "Each person is emailed only after the one above them has signed. Leave unchecked to email everyone at once."),
    ]);

    // What each signer is asked for before DocuSeal's form opens. Off by
    // default: the sender opts in per contract.
    const PHOTO_CHOICES = [
      ["none", "No photo check", "The signer just agrees to sign electronically."],
      ["selfie", "Selfie", "The signer takes a quick selfie before signing."],
      ["selfie_id", "Selfie + photo ID", "The signer takes a selfie and a photo of their ID."],
    ];
    let photoCheck = (prev && prev.photo_check) || "none";
    const photoWrap = el("div", { class: "form-row", style: "margin-top:14px;" }, [
      el("label", { class: "field-label" }, "Photo check before signing"),
      el("p", { class: "subtitle", style: "margin:2px 0 8px;" }, "Photos are stored encrypted with the signing record and only you can view them. They show who was in front of the camera; Rotely doesn't match them against each other automatically."),
    ]);
    const photoGrid = el("div", { class: "photo-choice-grid" });
    function renderPhotoChoices() {
      photoGrid.innerHTML = "";
      PHOTO_CHOICES.forEach(([value, title, desc]) => {
        const radio = el("input", { type: "radio", name: "photo-check", value });
        radio.checked = photoCheck === value;
        radio.addEventListener("change", () => { photoCheck = value; renderPhotoChoices(); });
        photoGrid.appendChild(
          el("label", { class: "photo-choice" + (photoCheck === value ? " selected" : "") }, [
            el("div", { class: "photo-choice-head" }, [radio, el("span", { class: "photo-choice-title" }, title)]),
            el("div", { class: "photo-choice-desc" }, desc),
          ])
        );
      });
    }
    renderPhotoChoices();
    photoWrap.appendChild(photoGrid);

    function uniqueRole(base) {
      const taken = new Set(rows.map((r) => r.roleInput.value.trim().toLowerCase()));
      if (!taken.has(base.toLowerCase())) return base;
      let n = 2;
      while (taken.has(`${base} ${n}`.toLowerCase())) n++;
      return `${base} ${n}`;
    }

    function addRow(data = {}) {
      const nameInput = el("input", { type: "text", placeholder: "Full name" });
      nameInput.value = data.name || "";
      const emailInput = el("input", { type: "email", placeholder: "email@company.com" });
      emailInput.value = data.email || "";
      const roleInput = el("input", { type: "text", placeholder: "Role (CEO, CFO, Client...)", maxlength: "40" });
      roleInput.value = data.role || "";
      const n = fieldCount(data.role || "");
      const row = { nameInput, emailInput, roleInput, lockedRole: n > 0 ? data.role : null };
      if (row.lockedRole) {
        roleInput.readOnly = true;
        roleInput.title = `${n} signature field${n > 1 ? "s are" : " is"} placed for this role, so it can't be renamed. Remove those fields first.`;
      }
      rows.push(row);
      renderRows();
    }

    function renderRows() {
      listWrap.innerHTML = "";
      rows.forEach((row, i) => {
        const up = el("button", { class: "btn secondary small", type: "button", title: "Move up" }, "▲");
        const down = el("button", { class: "btn secondary small", type: "button", title: "Move down" }, "▼");
        const rm = el("button", { class: "btn secondary small", type: "button", title: "Remove this signer" }, "Remove");
        up.disabled = i === 0;
        down.disabled = i === rows.length - 1;
        up.addEventListener("click", () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; renderRows(); });
        down.addEventListener("click", () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; renderRows(); });
        rm.addEventListener("click", () => {
          errBox.innerHTML = "";
          if (row.lockedRole) {
            const c = fieldCount(row.lockedRole);
            errBox.appendChild(el("div", { class: "error-box" },
              `${row.lockedRole} still has ${c} signature field${c > 1 ? "s" : ""} placed. Remove ${c > 1 ? "those fields" : "that field"} in the next step (Next → Remove) before taking this signer off the list.`));
            return;
          }
          rows.splice(i, 1);
          renderRows();
        });
        listWrap.appendChild(
          el("div", { class: "signer-row" }, [
            el("div", { class: "signer-num" }, String(i + 1)),
            el("div", { class: "signer-fields" }, [row.nameInput, row.emailInput, row.roleInput]),
            el("div", { class: "signer-actions" }, [up, down, rows.length > 1 ? rm : null]),
          ])
        );
      });
      addRowBtn.style.display = rows.length >= MAX_SIGNERS ? "none" : "";
      const meTaken = rows.some((r) => r.emailInput.value.trim().toLowerCase() === (state.user.email || "").toLowerCase());
      addMeBtn.style.display = rows.length >= MAX_SIGNERS || meTaken ? "none" : "";
      orderWrap.style.display = rows.length >= 2 ? "block" : "none";
    }

    addRowBtn.addEventListener("click", () => addRow({}));
    addMeBtn.addEventListener("click", () => addRow({ name: state.user.name || "", email: state.user.email || "", role: uniqueRole("Sender") }));

    // Initial rows: what was entered before if we came back from the next
    // step; otherwise the client (prefilled from a share link if any).
    // Roles that already have fields placed always get a row, so those
    // fields can't be left pointing at nobody.
    if (prev && prev.signers && prev.signers.length) {
      prev.signers.forEach((s) => addRow(s));
      orderInput.checked = !!prev.sign_in_order;
    } else {
      addRow({ name: prefillName, email: (shareInfo.exists && shareInfo.client_email) || "", role: "Client" });
    }
    const have = new Set(rows.map((r) => r.roleInput.value.trim()));
    [...new Set(placedFields.map((f) => f.role))].forEach((role) => {
      if (!have.has(role)) addRow({ name: "", email: "", role });
    });

    body.appendChild(
      el("div", { class: "form-row" }, [
        el("label", { class: "field-label" }, "Who needs to sign?"),
        el("p", { class: "subtitle", style: "margin:2px 0 8px;" }, shareInfo.exists
          ? "The first signer is filled in from this document's share link. Add everyone else who needs to sign (your CEO, CFO, a co-signer...) with a role label for each."
          : "Add everyone who needs to sign, with a role label for each (Client, CEO, CFO...). You'll choose where each person signs on the next step."),
        listWrap,
        el("div", { style: "display:flex;gap:8px;margin-top:8px;" }, [addRowBtn, addMeBtn]),
      ])
    );
    body.appendChild(orderWrap);
    body.appendChild(photoWrap);
    renderRows();
    body.appendChild(errBox);

    const nextBtn = el("button", { class: "btn", style: "margin-top:14px;" }, "Next: place signature fields");
    nextBtn.addEventListener("click", () => {
      errBox.innerHTML = "";
      const fail = (msg) => errBox.appendChild(el("div", { class: "error-box" }, msg));
      const signers = rows.map((r) => ({
        name: r.nameInput.value.trim(),
        email: r.emailInput.value.trim(),
        role: r.roleInput.value.trim().replace(/\s+/g, " "),
      }));
      if (!signers.length) return fail("Add at least one signer.");
      for (let i = 0; i < signers.length; i++) {
        const s = signers[i];
        if (!s.name || !s.email || !s.role) return fail(`Signer ${i + 1} needs a name, an email and a role.`);
        if (!ROLE_RE.test(s.role)) return fail(`Signer ${i + 1}'s role can use letters, numbers, spaces, hyphens, underscores and periods (up to 40 characters).`);
      }
      const emails = new Set(), roles = new Set();
      for (const s of signers) {
        if (emails.has(s.email.toLowerCase())) return fail(`${s.email} is on the list twice -- each signer needs their own email address.`);
        if (roles.has(s.role.toLowerCase())) return fail(`Two signers have the role "${s.role}" -- give each one their own label (for example Client 1 and Client 2).`);
        emails.add(s.email.toLowerCase());
        roles.add(s.role.toLowerCase());
      }
      renderFieldPlacer({ signers, sign_in_order: orderInput.checked && signers.length > 1, photo_check: photoCheck });
    });
    body.appendChild(
      el("div", { class: "modal-actions" }, [el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"), nextBtn])
    );
  }

  try {
    const existing = await api(`/api/generated/${generatedId}/signature-request`);
    if (existing.exists) {
      renderStatusView(existing);
    } else {
      await renderIntakeForm();
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

// A multi-line text box that grows with what is typed in it, so a long counter
// or a long AI suggestion can be read and edited without scrolling a tiny box.
function longTextBox(attrs, value) {
  const ta = el("textarea", { rows: "3", ...attrs }, value || "");
  ta.classList.add("counter-text");
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(Math.max(ta.scrollHeight, 76), 420) + "px"; };
  ta.addEventListener("input", grow);
  // Size it once it is on screen (scrollHeight is 0 while hidden / detached).
  ta.fit = () => requestAnimationFrame(grow);
  return ta;
}

// The line above a counter box that says, in plain words, that what is in the
// box IS the counter (so nobody thinks they still have to "do" the counter).
// call .refresh(value, fromAI) whenever the box shows or its text changes.
function counterStatusNote() {
  const n = el("div", { class: "counter-status" });
  n.refresh = (value, fromAI) => {
    const has = !!(value || "").trim();
    n.classList.toggle("ok", has);
    n.textContent = !has
      ? "Write your counter below."
      : fromAI
        ? "✓ The AI suggestion is now your counter. Edit it if you like — it is sent when you press Send response."
        : "✓ This is your counter. It is sent when you press Send response.";
  };
  return n;
}

// A "⋯" button that opens a small menu of the rare or risky actions for a row,
// so they are one deliberate click away instead of competing with the main
// choices. items: [{label, onClick, danger}] or {divider: true}.
function moreMenu(items) {
  const wrap = el("div", { class: "more-wrap" });
  const btn = el("button", { type: "button", class: "more-btn", "aria-label": "More actions", "aria-haspopup": "menu", "aria-expanded": "false" }, "⋯");
  const menu = el("div", { class: "more-menu", role: "menu", style: "display:none;" });
  const onDoc = (ev) => { if (!wrap.contains(ev.target)) close(); };
  function close() {
    menu.style.display = "none";
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDoc, true);
  }
  items.forEach((it) => {
    if (it.divider) { menu.appendChild(el("div", { class: "more-sep" })); return; }
    const b = el("button", { type: "button", role: "menuitem", class: "more-item" + (it.danger ? " danger" : "") }, it.label);
    b.addEventListener("click", () => { close(); it.onClick(); });
    menu.appendChild(b);
  });
  btn.addEventListener("click", () => {
    const open = menu.style.display === "none";
    menu.style.display = open ? "" : "none";
    btn.setAttribute("aria-expanded", String(open));
    if (open) document.addEventListener("click", onDoc, true);
    else document.removeEventListener("click", onDoc, true);
  });
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return wrap;
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

        // A round with several undecided changes gets a plain-English
        // summary: which are routine, which need a look, and which are worth
        // a lawyer's eye (that last part is decided in code, not by the AI).
        if (awaitingResponse && sub.origin !== "owner_reconsideration" && sub.origin !== "owner_edit" && undecidedCount >= 3) {
          const sumBox = el("div", { class: "summary-box", style: "display:none;" });
          const sumBtn = el("button", { class: "btn secondary small advisor-btn" }, `Summarize these ${undecidedCount} changes`);
          sumBtn.addEventListener("click", async () => {
            sumBtn.disabled = true;
            sumBtn.textContent = "Reading...";
            sumBox.style.display = "none";
            try {
              const res = await api(`/api/redline-submissions/${sub.id}/summary`, { method: "POST" });
              const sm = res.summary;
              const bits = [];
              if (sm.counts.routine) bits.push(`${sm.counts.routine} routine`);
              if (sm.counts.review) bits.push(`${sm.counts.review} to review`);
              if (sm.counts.lawyer) bits.push(`${sm.counts.lawyer} worth a lawyer's eye`);
              const labels = { routine: "Routine", review: "Review", lawyer: "Lawyer's eye" };
              sumBox.innerHTML = "";
              sumBox.appendChild(el("div", { class: "advisor-tag" }, "AI summary"));
              sumBox.appendChild(el("div", { class: "summary-counts" }, bits.join(" · ")));
              if (sm.overview) sumBox.appendChild(el("div", { class: "advisor-why" }, sm.overview));
              sm.items.forEach((it) => {
                sumBox.appendChild(
                  el("div", { class: "summary-row" }, [
                    el("span", { class: "level-badge level-" + it.level }, labels[it.level] || it.level),
                    el("div", {}, [
                      el("div", { class: "summary-term" }, it.term),
                      el("div", { class: "advisor-why" }, it.meaning),
                    ]),
                  ])
                );
              });
              if (sm.left_out) sumBox.appendChild(el("div", { class: "advisor-left" }, `${sm.left_out} more change${sm.left_out === 1 ? "" : "s"} not shown here. Review them below.`));
              sumBox.appendChild(el("div", { class: "advisor-foot" }, [
                el("span", { class: "advisor-left" }, res.disclaimer),
                el("span", { class: "advisor-left" }, `${res.usage.remaining} of ${res.usage.limit} AI suggestions left this month`),
              ]));
              sumBox.style.display = "";
            } catch (e) {
              sumBox.innerHTML = "";
              sumBox.appendChild(el("div", { class: "advisor-why" }, e.message));
              sumBox.style.display = "";
            }
            sumBtn.disabled = false;
            sumBtn.textContent = `Summarize these ${undecidedCount} changes`;
          });
          subBox.appendChild(el("div", { style: "margin:0 0 10px;" }, [sumBtn]));
          subBox.appendChild(sumBox);
        }

        // Live progress for this round ("2 of 3 decided") and the shortcut
        // for long rounds. onStageChange is called by each row when its
        // choice changes; the header, the footer and the Send button all
        // follow from it.
        const acceptable = [];
        const flaggedUpfront = sub.edits.filter((e) => e.decision === "pending" && e.risk).length;
        const progressHead = el("div", { class: "decision-head" });
        const progressText = el("div", { class: "decision-head-text" });
        let onStageChange = () => {};
        const decidedNow = () => sub.edits.filter((e) => e.decision !== "pending" || (subStage[e.id] && subStage[e.id].decision !== "pending")).length;
        if (awaitingResponse && sub.origin !== "owner_reconsideration" && sub.origin !== "owner_edit") {
          progressHead.appendChild(progressText);
          if (undecidedCount >= 2) {
            const acceptAllLink = el("button", {
              type: "button", class: "link-btn",
              title: flaggedUpfront ? "Changes flagged for a lawyer's eye are skipped" : "",
            }, flaggedUpfront ? `Accept all remaining (skips ${flaggedUpfront} flagged)` : "Accept all remaining");
            acceptAllLink.addEventListener("click", () => acceptable.forEach((f) => f()));
            progressHead.appendChild(acceptAllLink);
            progressHead.acceptAll = acceptAllLink;
          }
          subBox.appendChild(progressHead);
        }

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
            // Withdrawing is rare, so it lives in the "⋯" menu (and still asks first).
            const doRemove = async () => {
              if (!confirm("Remove this change? The client will no longer see it.")) return;
              try {
                await api(`/api/redline-edits/${edit.id}/withdraw`, { method: "DELETE" });
                load();
              } catch (e) {
                alert(e.message);
              }
            };
            actions = el("div", { class: "decision-row" }, [summaryEl, moreMenu([{ label: "Remove this change…", danger: true, onClick: doRemove }])]);
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
            let toggleReconsider = () => {};
            const reconsiderBtn = edit.superseded
              ? null
              : moreMenu([{ label: "Reconsider this decision", onClick: () => toggleReconsider() }]);
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
            toggleReconsider = () => {
              reconsiderOpen = !reconsiderOpen;
              reconsiderBox.style.display = reconsiderOpen ? "" : "none";
              if (reconsiderOpen && !reconsiderBuilt) { reconsiderBuilt = true; buildReconsiderForm(); }
            };

            function buildReconsiderForm() {
              const rstage = { decision: "pending", counter_value: "" };
              const counterInput = longTextBox({ placeholder: "Your counter value...", style: "display:none;margin-top:8px;" });
              const rNote = counterStatusNote();
              rNote.style.display = "none";
              counterInput.addEventListener("input", () => { rstage.counter_value = counterInput.value; rNote.refresh(counterInput.value); });
              const rejectBtn = el("button", { class: "btn small outcome o-reject" }, "Reject");
              const counterBtn = el("button", { class: "btn small outcome o-counter" }, "Counter");
              const acceptBtn = el("button", { class: "btn small outcome o-accept" }, "Accept");
              // Same idea as the first-time decision row: once picked, only
              // that action shows, with a "Change" link to bring the rest back.
              const rChange = el("button", {
                type: "button", style: "display:none;background:none;border:0;padding:0 2px;font:inherit;font-size:12px;color:var(--accent);text-decoration:underline;cursor:pointer;",
              }, "Change");
              function paintRStage() {
                const picked = rstage.decision !== "pending";
                counterInput.style.display = rstage.decision === "countered" ? "" : "none";
                rNote.style.display = rstage.decision === "countered" ? "" : "none";
                rNote.refresh(counterInput.value);
                rejectBtn.textContent = picked && rstage.decision === "rejected" ? "✓ Rejecting" : "Reject";
                counterBtn.textContent = picked && rstage.decision === "countered" ? "✓ Your counter" : "Counter";
                acceptBtn.textContent = picked && rstage.decision === "accepted" ? "✓ Accepting" : "Accept";
                [rejectBtn, counterBtn, acceptBtn].forEach((b) => b.classList.remove("staged-active", "stage-accepted", "stage-rejected", "stage-countered"));
                if (rstage.decision === "rejected") rejectBtn.classList.add("staged-active", "stage-rejected");
                if (rstage.decision === "countered") counterBtn.classList.add("staged-active", "stage-countered");
                if (rstage.decision === "accepted") acceptBtn.classList.add("staged-active", "stage-accepted");
                rejectBtn.style.display = picked && rstage.decision !== "rejected" ? "none" : "";
                counterBtn.style.display = picked && rstage.decision !== "countered" ? "none" : "";
                acceptBtn.style.display = picked && rstage.decision !== "accepted" ? "none" : "";
                rChange.style.display = picked ? "" : "none";
              }
              function setRStage(d) {
                rstage.decision = rstage.decision === d ? "pending" : d;
                paintRStage();
                if (rstage.decision === "countered") { counterInput.fit(); counterInput.focus(); }
              }
              rChange.addEventListener("click", () => { rstage.decision = "pending"; paintRStage(); });
              rejectBtn.addEventListener("click", () => setRStage("rejected"));
              counterBtn.addEventListener("click", () => setRStage("countered"));
              acceptBtn.addEventListener("click", () => setRStage("accepted"));
              const sendBtn = el("button", { class: "btn" }, "Send new decision");
              const rCancel = el("button", { type: "button", class: "link-btn" }, "Cancel");
              rCancel.addEventListener("click", () => toggleReconsider());
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
                  el("div", { class: "decision-btns" }, [acceptBtn, counterBtn, rejectBtn, rChange]),
                  rNote,
                  counterInput,
                  el("div", { style: "margin-top:8px;display:flex;gap:14px;align-items:center;" }, [sendBtn, rCancel]),
                ])
              );
            }
            }
          } else if (!awaitingResponse) {
            actions = el("div", { class: "decision-row" }, [el("div", { class: "decided pending" }, "No response yet")]);
          } else {
            const stage = subStage[edit.id] || { decision: "pending", counter_value: "" };
            subStage[edit.id] = stage;
            const counterInput = longTextBox({ placeholder: "Your counter value...", style: stage.decision === "countered" ? "" : "display:none;" }, stage.counter_value);
            const cNote = counterStatusNote();
            let fromAI = false;
            counterInput.addEventListener("input", () => { stage.counter_value = counterInput.value; cNote.refresh(counterInput.value, fromAI); });
            // Three real alternatives, shown at equal weight: same size, told
            // apart by label and a light tint, never by one being louder.
            const rejectBtn = el("button", { class: "btn small outcome o-reject" }, "Reject");
            const counterBtn = el("button", { class: "btn small outcome o-counter" }, "Counter");
            const acceptBtn = el("button", { class: "btn small outcome o-accept" }, "Accept");
            const askLine = el("div", { class: "decision-ask" }, "Decide on this change.");
            // Once an action is picked, only that action shows: the other two
            // buttons and the AI-suggestion extras get out of the way (they
            // read as competing choices), and a small "Change" link brings
            // the full set back. See the matching block in buildReconsiderForm.
            const changeLink = el("button", {
              type: "button", style: "display:none;background:none;border:0;padding:0 2px;font:inherit;font-size:12px;color:var(--accent);text-decoration:underline;cursor:pointer;",
            }, "Change");
            const extras = el("div"); // lawyer note (always) and the AI helper (inside the Counter step only)
            const aiWrap = el("div"); // "Suggest with AI" + its box; shown only once Counter is picked
            function paintStage() {
              const picked = stage.decision !== "pending";
              askLine.style.display = picked ? "none" : "";
              counterInput.style.display = stage.decision === "countered" ? "" : "none";
              cNote.style.display = stage.decision === "countered" ? "" : "none";
              cNote.refresh(counterInput.value, fromAI);
              // The picked action reads as a status ("✓ Your counter"), not as
              // a button still waiting to be pressed.
              rejectBtn.textContent = picked && stage.decision === "rejected" ? "✓ Rejecting" : "Reject";
              counterBtn.textContent = picked && stage.decision === "countered" ? "✓ Your counter" : "Counter";
              acceptBtn.textContent = picked && stage.decision === "accepted" ? "✓ Accepting" : "Accept";
              [rejectBtn, counterBtn, acceptBtn].forEach((b) => b.classList.remove("staged-active", "stage-accepted", "stage-rejected", "stage-countered"));
              if (stage.decision === "rejected") rejectBtn.classList.add("staged-active", "stage-rejected");
              if (stage.decision === "countered") counterBtn.classList.add("staged-active", "stage-countered");
              if (stage.decision === "accepted") acceptBtn.classList.add("staged-active", "stage-accepted");
              rejectBtn.style.display = picked && stage.decision !== "rejected" ? "none" : "";
              counterBtn.style.display = picked && stage.decision !== "countered" ? "none" : "";
              acceptBtn.style.display = picked && stage.decision !== "accepted" ? "none" : "";
              changeLink.style.display = picked ? "" : "none";
              // The AI helper belongs to the Counter step: it is not offered
              // before a choice is made, where it would compete with the three
              // real options.
              aiWrap.style.display = stage.decision === "countered" ? "" : "none";
              if (stage.decision === "countered") counterInput.fit();
              onStageChange();
            }
            function setStage(d) {
              stage.decision = stage.decision === d ? "pending" : d;
              paintStage();
              if (stage.decision === "countered") counterInput.focus();
            }
            changeLink.addEventListener("click", () => { stage.decision = "pending"; paintStage(); });
            rejectBtn.addEventListener("click", () => setStage("rejected"));
            counterBtn.addEventListener("click", () => setStage("countered"));
            acceptBtn.addEventListener("click", () => setStage("accepted"));
            // AI counter advisor: facts are computed server-side and the
            // model only proposes a value plus a short reason. The result is
            // an editable draft; nothing is sent until "Send response".
            const adviceBox = el("div", { class: "advisor-box", style: "display:none;" });
            const adviceBtn = el("button", { type: "button", class: "link-btn advisor-btn" }, "✦ Suggest with AI");
            adviceBtn.addEventListener("click", async () => {
              adviceBtn.disabled = true;
              adviceBtn.textContent = "Thinking...";
              adviceBox.style.display = "none";
              try {
                const res = await api(`/api/redline-edits/${edit.id}/suggest-counter`, { method: "POST" });
                const sug = res.suggestion;
                const input = longTextBox({ "aria-label": "Suggested counter" }, sug.counter_value);
                const useBtn = el("button", { class: "btn small" }, "Use as my counter");
                useBtn.addEventListener("click", () => {
                  if (stage.decision !== "countered") setStage("countered");
                  counterInput.value = input.value;
                  stage.counter_value = input.value;
                  fromAI = true;
                  adviceBox.style.display = "none"; // it is now the counter above, so close the suggestion
                  cNote.refresh(counterInput.value, fromAI);
                  counterInput.fit();
                  counterInput.focus();
                });
                adviceBox.innerHTML = "";
                adviceBox.appendChild(el("div", { class: "advisor-tag" }, "AI suggestion"));
                adviceBox.appendChild(input);
                if (sug.reasoning) adviceBox.appendChild(el("div", { class: "advisor-why" }, sug.reasoning));
                adviceBox.appendChild(el("div", { class: "advisor-left" }, res.disclaimer || "AI suggestion. Not legal advice."));
                adviceBox.appendChild(el("div", { class: "advisor-foot" }, [
                  useBtn,
                  el("span", { class: "advisor-left" }, `${res.usage.remaining} of ${res.usage.limit} AI suggestions left this month`),
                ]));
                adviceBox.style.display = "";
                input.fit();
              } catch (e) {
                adviceBox.innerHTML = "";
                adviceBox.appendChild(el("div", { class: "advisor-why" }, e.message));
                adviceBox.style.display = "";
              }
              adviceBtn.disabled = false;
              adviceBtn.textContent = "✦ Suggest with AI";
            });
            // A change that touches liability, ownership, termination and the
            // like gets a plain note instead of an AI counter (decided in
            // code on the server, see advisor.clause_risk).
            const lawyerNote = edit.risk
              ? el("div", { class: "lawyer-note" }, [
                  el("div", { class: "advisor-tag lawyer-tag" }, "Worth a lawyer's eye"),
                  el("div", { class: "advisor-why" }, edit.risk.message),
                ])
              : null;
            if (lawyerNote) extras.appendChild(lawyerNote);
            else { aiWrap.appendChild(adviceBtn); aiWrap.appendChild(adviceBox); }
            extras.appendChild(aiWrap);
            // "Accept all remaining" can only act on rows that are not flagged
            // for a lawyer's eye: those always need a person's decision.
            if (!edit.risk) acceptable.push(() => { if (stage.decision === "pending") { stage.decision = "accepted"; paintStage(); } });

            actions = el("div", { class: "decision-col wide" }, [
              askLine,
              el("div", { class: "decision-row" }, [
                el("div", { class: "decision-btns" }, [acceptBtn, counterBtn, rejectBtn, changeLink]),
                cNote,
                counterInput,
              ]),
              extras,
            ]);
            paintStage();
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
                (() => {
                  // Read the change in plain words: an addition, a removal, a
                  // comment on unchanged text, or a before -> after.
                  const shownTo = (sub.origin === "owner_edit" ? edit.counter_value : edit.proposed_value) || "";
                  const fw = window.RedlineUI.fmtWords(edit.format);
                  const fwNote = fw ? ` (${fw})` : "";
                  if (!edit.original_value && shownTo.trim()) {
                    return el("div", { class: "change" }, [edit.new_paragraph ? "Add a new paragraph: “" : "Add: “", el("span", { class: "to" }, shownTo.trim()), `”${fwNote}`]);
                  }
                  if (edit.original_value && !shownTo.trim()) {
                    return el("div", { class: "change" }, ["Remove: “", el("span", { class: "from" }, edit.original_value), "”"]);
                  }
                  if (edit.original_value && edit.original_value.trim() === shownTo.trim() && edit.comment) {
                    return el("div", { class: "change" }, ["Comment on: “", el("span", { class: "from", style: "text-decoration:none;" }, edit.original_value), "”"]);
                  }
                  return el("div", { class: "change" }, [
                    el("span", { class: "from" }, edit.original_value || "(blank)"),
                    " → ",
                    el("span", { class: "to" }, shownTo),
                    fwNote,
                  ]);
                })(),
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

        // The footer says where the round stands and carries the one button
        // that moves it forward (Send response, or Apply once it is sent).
        const footerNote = el("div", { class: "decision-foot-note" });
        const footerBtns = el("div", { class: "decision-foot-btns" });
        const footerActions = el("div", { class: "decision-foot" }, [footerNote]);

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
          footerBtns.appendChild(sendBtn);
          onStageChange = () => {
            const stagedCount = Object.values(subStage).filter((v) => v.decision !== "pending").length;
            const decided = decidedNow();
            const total = sub.edits.length;
            progressText.innerHTML = "";
            progressText.appendChild(el("strong", {}, "Decide on each change. "));
            progressText.appendChild(el("span", { class: "muted" }, `${decided} of ${total} decided.`));
            footerNote.innerHTML = "";
            footerNote.appendChild(el("div", { class: "decision-foot-count" }, `${decided} of ${total} decided`));
            footerNote.appendChild(el("div", { class: "decision-foot-hint" },
              stagedCount === 0
                ? "Decide on at least one change to send a response."
                : decided === total
                ? "Everything is decided. Nothing is sent until you press the button."
                : "Send now, or finish the rest first. Nothing is sent until you press the button."));
            sendBtn.disabled = stagedCount === 0;
            // Nothing left that the shortcut could accept: take it away.
            if (progressHead.acceptAll) {
              const anyLeft = sub.edits.some((e) => !e.risk && e.decision === "pending" && subStage[e.id] && subStage[e.id].decision === "pending");
              progressHead.acceptAll.style.display = anyLeft ? "" : "none";
            }
          };
          onStageChange();
        }

        // Excludes superseded edits (see apply_redline_submission's
        // superseded_edit_ids) -- an edit whose "accepted" decision has
        // since been overridden by a reconsideration must not make this
        // button appear, since Apply itself will now skip it; showing Apply
        // here for a fully-superseded round with nothing else live would be
        // a dead end that fails with "No accepted edits to apply yet."
        const hasAcceptedSomewhere = sub.edits.some((e) => !e.superseded && (e.decision === "accepted" || (e.decision === "pending" && e.evaluation === "auto_approved")));
        if (sub.status === "pending" && hasAcceptedSomewhere) {
          // Once nothing is left to decide, Apply is the step that moves the
          // round forward, so it is the main button; while decisions are still
          // open it stays quiet so there is only one clear next step.
          const applyBtn = el("button", { class: awaitingResponse ? "btn secondary" : "btn" }, "Apply accepted changes → new draft");
          if (!awaitingResponse) {
            const acceptedN = sub.edits.filter((e) => !e.superseded && e.decision === "accepted").length;
            const counteredN = sub.edits.filter((e) => !e.superseded && e.decision === "countered").length;
            footerNote.appendChild(el("div", { class: "decision-foot-count" }, `${acceptedN} accepted${counteredN ? `, ${counteredN} countered` : ""}`));
            footerNote.appendChild(el("div", { class: "decision-foot-hint" }, "Applying creates a new draft with the accepted changes." + (counteredN ? " Counters stay open." : "")));
          }
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
          footerBtns.appendChild(applyBtn);
        }
        if (footerBtns.children.length) {
          footerActions.appendChild(footerBtns);
          subBox.appendChild(footerActions);
        }

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
    prefill && prefill.ai
      ? el("div", { class: "advisor-box ai-banner" }, [
          el("div", { class: "advisor-tag" }, "AI suggestion. Check every field."),
          el("div", { class: "advisor-why" }, prefill.ai.summary),
          prefill.ai.notes ? el("div", { class: "advisor-why" }, prefill.ai.notes) : null,
        ])
      : null,
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
  wrap.appendChild(
    el("div", { style: "margin:2px 0 16px;" }, [
      el("button", { class: "btn secondary", onclick: () => startDraftFromText() }, "Draft from an email or notes"),
    ])
  );

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
        // Search, filter by document type, and a "Recently used" row, so a
        // long library doesn't turn into one wall of identical cards.
        const types = [...new Set(ready.map((t) => t.document_type))].sort();
        let query = "";
        let typeFilter = "All";
        const searchInput = el("input", { type: "search", class: "draft-search", placeholder: "Search master documents", "aria-label": "Search master documents" });
        const pillRow = el("div", { class: "pill-row", role: "group", "aria-label": "Filter by document type" });
        const results = el("div", {});

        function draftCard(t) {
          const labels = t.field_labels || [];
          const chips = labels.slice(0, 3).map((l) => el("span", { class: "field-chip" }, l));
          if (t.placeholder_count > chips.length) chips.push(el("span", { class: "field-chip more" }, `+${t.placeholder_count - chips.length}`));
          const used = t.generated_count
            ? `Drafted ${t.generated_count} time${t.generated_count === 1 ? "" : "s"}${t.last_used_at ? " · last " + fmtShortDate(t.last_used_at) : ""}`
            : "Not used yet";
          return el("div", { class: "doc-card" }, [
            el("div", { class: "top-row" }, [el("div", { class: "icon" }, "☰"), el("div", { class: "type-tag" }, t.document_type)]),
            el("div", { class: "name" }, t.name),
            el("div", { class: "field-chips" }, chips),
            el("div", { class: "meta" }, `${t.placeholder_count} field${t.placeholder_count === 1 ? "" : "s"} · ${used}`),
            el("div", { class: "actions" }, [el("button", { class: "btn small block", onclick: () => startDraft(t.id) }, "Use this template")]),
          ]);
        }

        function section(title, items) {
          const grid = el("div", { class: "grid" });
          items.forEach((t) => grid.appendChild(draftCard(t)));
          return el("div", { class: "draft-section" }, [el("div", { class: "draft-section-title" }, title), grid]);
        }

        function renderPills() {
          pillRow.innerHTML = "";
          ["All", ...types].forEach((ty) => {
            const n = ty === "All" ? ready.length : ready.filter((t) => t.document_type === ty).length;
            const b = el("button", { type: "button", class: "pill" + (ty === typeFilter ? " active" : ""), "aria-pressed": ty === typeFilter ? "true" : "false" }, `${ty} ${n}`);
            b.addEventListener("click", () => { typeFilter = ty; renderPills(); renderResults(); });
            pillRow.appendChild(b);
          });
        }

        function renderResults() {
          results.innerHTML = "";
          const q = query.trim().toLowerCase();
          const matches = ready.filter((t) =>
            (typeFilter === "All" || t.document_type === typeFilter) &&
            (!q || t.name.toLowerCase().includes(q) || t.document_type.toLowerCase().includes(q) || (t.field_labels || []).some((l) => l.toLowerCase().includes(q)))
          );
          if (!matches.length) {
            results.appendChild(el("div", { class: "empty-state" }, "No master documents match that. Try a different search or filter."));
            return;
          }
          // Only when browsing everything: surface what you used lately.
          let rest = matches;
          let restTitle = q || typeFilter !== "All" ? `${matches.length} result${matches.length === 1 ? "" : "s"}` : "All master documents";
          if (!q && typeFilter === "All") {
            const recent = [...ready].filter((t) => t.last_used_at).sort((a, b) => b.last_used_at.localeCompare(a.last_used_at)).slice(0, 3);
            if (recent.length && ready.length > 3) {
              results.appendChild(section("Recently used", recent));
              const recentIds = new Set(recent.map((t) => t.id));
              rest = matches.filter((t) => !recentIds.has(t.id));
              restTitle = "More master documents";
            }
          }
          if (rest.length) results.appendChild(section(restTitle, rest));
        }

        searchInput.addEventListener("input", () => { query = searchInput.value; renderResults(); });
        body.appendChild(el("div", { class: "draft-toolbar" }, [searchInput, types.length > 1 ? pillRow : null]));
        body.appendChild(results);
        renderPills();
        renderResults();

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

  // Paste an email or notes: Claude picks the master document and fills in
  // what it can, then it opens in the normal fill-in form. Nothing is created
  // until the owner presses Generate there.
  function startDraftFromText() {
    const overlay = el("div", { class: "modal-overlay" });
    const errBox = el("div");
    const ta = el("textarea", { rows: "10", maxlength: "12000", placeholder: "Paste the client's email or your notes here...", "aria-label": "Email or notes" });
    const goBtn = el("button", { class: "btn" }, "Suggest a draft");
    const modal = el("div", { class: "modal" }, [
      el("h2", {}, "Draft from an email or notes"),
      el("p", { class: "subtitle", style: "margin:2px 0 16px;" }, "Rotely picks the master document and fills in what the text says. You review every field before anything is created."),
      errBox,
      el("div", { class: "form-row" }, [ta]),
      el("div", { style: "font-size:11.5px;color:var(--muted);line-height:1.4;" }, "AI suggestion. Each one uses 1 of your 50 monthly AI suggestions."),
      el("div", { class: "modal-actions" }, [el("button", { class: "btn secondary", onclick: () => overlay.remove() }, "Cancel"), goBtn]),
    ]);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    ta.focus();
    goBtn.addEventListener("click", async () => {
      if (goBtn.disabled) return;
      errBox.innerHTML = "";
      if (!ta.value.trim()) { errBox.appendChild(el("div", { class: "error-box" }, "Paste an email or some notes first.")); return; }
      goBtn.disabled = true;
      goBtn.textContent = "Reading...";
      try {
        const res = await api("/api/draft-from-text", { method: "POST", body: { text: ta.value } });
        if (!res.template_id) {
          errBox.appendChild(el("div", { class: "error-box" }, "That didn't match any of your master documents. " + (res.notes || "")));
          goBtn.disabled = false;
          goBtn.textContent = "Suggest a draft";
          return;
        }
        const tpl = await api(`/api/templates/${res.template_id}`);
        overlay.remove();
        const left = `${res.usage.remaining} of ${res.usage.limit} AI suggestions left this month`;
        openFillModal(
          tpl,
          {
            values: res.values,
            party_b: res.other_party,
            ai: { summary: `Suggested ${res.template_name}, filled ${res.filled} of ${res.total} fields. ${left}.`, notes: res.notes },
          },
          (result, prefill) => showResult(tpl, result, prefill)
        );
      } catch (e) {
        errBox.appendChild(el("div", { class: "error-box" }, e.message));
        goBtn.disabled = false;
        goBtn.textContent = "Suggest a draft";
      }
    });
  }

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
    // Where the contract stands decides which next steps to offer and which
    // one needs attention first. If the lookup fails we fall back to the
    // plain draft choices rather than blocking the preview.
    api(`/api/generated/${result.generated_id}`)
      .then((g) => g.status || null, () => null)
      .then((status) => renderResult(tpl, result, lastPrefill, status));
  }

  function renderResult(tpl, result, lastPrefill, status) {
    const editFn = () => {
      overlay.remove();
      api(`/api/templates/${tpl.id}`)
        .then((freshTpl) => {
          openFillModal(freshTpl, lastPrefill, (res2, prefill2) => showResult(freshTpl, res2, prefill2));
        })
        // The overlay above is already gone by the time this could fail --
        // without this, a failed request here silently dropped the person
        // back at the bare Draft tab with no fill form and no explanation.
        .catch((e) => alert(e.message || "Couldn't reopen this document for editing. Please try again."));
    };

    const key = (status && status.key) || "draft";
    const roundOpen = key === "submitted" || key === "response_sent" || key === "client_reviewing";
    const agreed = key === "applied" || key === "reviewed_no_changes";
    const card = ({ title, text, onClick, badge }) =>
      el("button", { type: "button", class: "next-card" + (badge ? " needs-you" : ""), onclick: onClick }, [
        badge ? el("span", { class: "next-badge" }, badge) : null,
        el("div", { class: "next-title" }, title),
        el("div", { class: "next-text" }, text),
      ]);
    // Equal choices, ordered by what is most likely next. A round waiting on
    // the owner comes first and carries a "Needs you" badge; Redlines only
    // appears while a round is open.
    const redlinesCard = roundOpen
      ? card({
          title: "Redlines",
          text: key === "submitted" ? "The other side sent changes. Decide on each one." : "Waiting on the other side. Open to see where it stands.",
          badge: key === "submitted" ? "Needs you" : null,
          onClick: () => openRedlinesModal(result.generated_id),
        })
      : null;
    const shareCard = card({
      title: "Share for review",
      text: agreed ? "Open a new round with someone else before signing." : key === "shared" ? "Shared, awaiting review. Open to see the link." : "Send someone a link to read and suggest changes.",
      onClick: () => openShareModal(result.generated_id),
    });
    const signCard = card({
      title: "Send for signature",
      text: roundOpen ? "Ready when every change is settled. Not yet: a round is open." : "Choose who signs and place the signature fields.",
      onClick: () => openSignatureModal(result.generated_id),
    });
    const nextSteps = el("div", { class: "next-grid" }, (roundOpen ? [redlinesCard, shareCard, signCard] : agreed ? [signCard, shareCard] : [shareCard, signCard]).filter(Boolean));
    var overlay = showPreviewOverlay({
      title: result.name,
      subtitle: agreed
        ? "✓ Every change is settled. Nothing is waiting on you or the other side."
        : `Generated from ${tpl.name} · saved to your Documents library`,
      html: result.html,
      generatedId: result.generated_id,
      nextSteps,
      moreItems: [
        { label: "Edit values", onClick: editFn },
        { label: "View in Documents", onClick: () => { overlay.remove(); location.hash = "#/documents"; } },
        { divider: true },
        { label: "Download .docx", onClick: () => { location.href = `/api/generated/${result.generated_id}/download`; } },
      ],
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
          const dupBtn = el("button", { class: "btn secondary small", title: "Make a copy, fields included" }, "Duplicate");
          dupBtn.addEventListener("click", () => duplicateTemplate(t.id, dupBtn));
          actions.push(dupBtn);
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

  async function duplicateTemplate(id, btn) {
    btn.disabled = true;
    btn.textContent = "Duplicating...";
    try {
      await api(`/api/templates/${id}/duplicate`, { method: "POST" });
      load();
    } catch (e) {
      alert(e.message);
      btn.disabled = false;
      btn.textContent = "Duplicate";
    }
  }

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
  // A document someone else drafted (or a one-off the owner doesn't want
  // to turn into a reusable master document) can be sent straight out for
  // signature without ever going through Draft -- see
  // openUploadForSignatureModal / POST /api/documents/upload-for-signature.
  toolbar.appendChild(
    el("button", { class: "btn secondary", style: "margin-left:auto;", onclick: () => openUploadForSignatureModal(load) }, "Upload document to sign")
  );
  wrap.appendChild(toolbar);

  // "Renewing soon": confirmed end dates in the next 90 days (and anything
  // that ended in the last two weeks), plus suggested dates waiting to be
  // confirmed. Hidden entirely when there's nothing to show.
  const renewalWrap = el("div", {});
  wrap.appendChild(renewalWrap);

  const listWrap = el("div", {});
  wrap.appendChild(listWrap);

  async function loadRenewals() {
    try {
      const res = await api("/api/renewals");
      renewalWrap.innerHTML = "";
      if (!res.renewing.length && !res.to_confirm.length) return;
      const cards = [];
      res.renewing.forEach((r) =>
        cards.push(
          el("button", { class: "renew-card" + (r.days_left <= 7 ? " urgent" : ""), type: "button", title: r.name, onclick: () => openDetail({ id: r.id }) }, [
            el("div", { class: "renew-head" }, [el("div", { class: "renew-name" }, r.name), r.auto_renews ? el("span", { class: "renew-chip" }, "Auto-renews") : null]),
            el("div", { class: "renew-when" }, `${fmtDay(r.end_date)} · ${endsText(r.days_left)}`),
          ])
        )
      );
      res.to_confirm.forEach((r) =>
        cards.push(
          el("button", { class: "renew-card confirm", type: "button", onclick: () => openDetail({ id: r.id }) }, [
            el("div", { class: "renew-name" }, r.name),
            el("div", { class: "renew-when" }, "Suggested end date to confirm"),
          ])
        )
      );
      renewalWrap.appendChild(el("div", { class: "renew-strip" }, [el("div", { class: "renew-title" }, "Renewing soon"), el("div", { class: "renew-cards" }, cards)]));
    } catch (e) {
      renewalWrap.innerHTML = ""; // a nicety: the document list below still works without it
    }
  }
  loadRenewals();

  // "Ends Mar 1, 2027" / "Confirm end date" next to a document's name.
  function termTagEl(d) {
    if (d.end_date) return el("span", { class: "term-tag" + (daysUntil(d.end_date) <= 30 ? " soon" : "") }, "Ends " + fmtDay(d.end_date));
    if (d.has_end_date_suggestion) return el("span", { class: "term-tag confirm" }, "Confirm end date");
    return null;
  }

  // Small colored pill for a document's current step (drafted, shared,
  // redlines submitted, response sent, applied) -- reuses the same
  // .status-tag tones the folder view's "Redlines applied" badge already
  // used, so draft/pending/final read consistently everywhere.
  function statusTagEl(status) {
    if (!status) return null;
    return el("span", { class: "status-tag " + (status.tone || "draft") }, status.label);
  }

  // "Waiting on Morgan \u00b7 4 days" / "Fully signed" -- where the latest
  // signature request stands. Click to open the request.
  function signatureTagEl(sig, docId) {
    if (!sig) return null;
    return el("span", {
      class: "status-tag signature-tag " + (sig.tone || "pending"),
      title: "Open signature request",
      onclick: (e) => { e.stopPropagation(); openSignatureModal(docId); },
    }, sig.label);
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
          el("div", { class: "folder-name-row" }, [el("div", { class: "name" }, d.name), statusTagEl(d.status), signatureTagEl(d.signature, d.id), termTagEl(d), unresolvedBadgeEl(d.unresolved_count)]),
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
            signatureTagEl(latest.signature, latest.id),
            termTagEl(latest),
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
      // Stored-XSS fix (QA, HIGH): these labels/values include text a client
      // typed into a redline, so they must NEVER go through innerHTML. Built
      // as DOM nodes via el() so everything is set as text, not markup.
      const valueRows = full.values.map((v) =>
        el("div", { class: "field-row" }, [
          el("div", { class: "k" }, String(v.label == null ? "" : v.label)),
          el("div", { class: "v" }, String(v.value || "—")),
        ])
      );
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
        el("div", {}, valueRows.length ? el("div", {}, valueRows) : el("div", { style: "color:var(--muted);font-size:13px;" }, "No field values recorded.")),
        renewalSectionEl(d.id, () => { loadRenewals(); load(); }),
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
          el("button", { class: "btn secondary", onclick: () => { panelOverlay.remove(); openRedlinesModal(d.id); } }, full.status && full.status.key === "submitted" ? "Redlines · Needs you" : "Redlines"),
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

// A plain calendar day ("2027-03-01") as local text. Parsed by hand because
// new Date("2027-03-01") is UTC midnight, which shows as the day before in
// any timezone west of UTC.
function parseDay(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtDay(iso) {
  return parseDay(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
function daysUntil(iso) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((parseDay(iso) - today) / 86400000);
}
function endsText(days) {
  if (days < 0) return days === -1 ? "ended yesterday" : `ended ${-days} days ago`;
  if (days === 0) return "ends today";
  if (days === 1) return "ends tomorrow";
  return `ends in ${days} days`;
}

// "Contract term" block in a document's detail panel: confirmed end date,
// auto-renew flag and renewal notes, plus the AI suggestion (if any) that
// still needs the owner to confirm, edit or dismiss it. A suggestion never
// counts for the "Renewing soon" strip or emails until confirmed.
function renewalSectionEl(docId, onChange) {
  const box = el("div", { class: "term-box" }, el("div", { class: "term-title" }, "Contract term"));
  const body = el("div", {}, el("div", { class: "term-status" }, "Loading..."));
  box.appendChild(body);

  async function save(values, btn) {
    if (btn) { btn.disabled = true; }
    try {
      const res = await api(`/api/generated/${docId}/renewal`, { method: "PUT", body: values });
      paint(res);
      if (onChange) onChange();
    } catch (err) {
      if (btn) btn.disabled = false;
      alert(err.message);
    }
  }

  function paint(info, note) {
    body.innerHTML = "";
    const dateInput = el("input", { type: "date", class: "term-date", value: info.end_date || "" });
    const autoCheck = el("input", { type: "checkbox", id: `term-auto-${docId}` });
    autoCheck.checked = !!info.auto_renews;
    const notes = el("input", { type: "text", class: "term-notes", maxlength: "300", placeholder: "Renewal or notice terms (optional)", value: info.renewal_terms || "" });

    if (info.suggestion) {
      const sg = info.suggestion;
      const summary = [sg.end_date ? "Ends " + fmtDay(sg.end_date) : "No end date found", sg.auto_renews ? "renews automatically" : null].filter(Boolean).join(" · ");
      const useBtn = sg.end_date
        ? el("button", { class: "btn small", type: "button", onclick: (e) => save({ end_date: sg.end_date, auto_renews: !!sg.auto_renews, renewal_terms: sg.renewal_terms || "" }, e.currentTarget) }, "Use this")
        : null;
      body.appendChild(
        el("div", { class: "term-suggestion" }, [
          el("div", { class: "term-sg-label" }, "AI suggestion · check it against the contract"),
          el("div", { class: "term-sg-main" }, summary),
          sg.renewal_terms ? el("div", { class: "term-sg-note" }, sg.renewal_terms) : null,
          sg.evidence ? el("div", { class: "term-sg-quote" }, `\u201c${sg.evidence}\u201d`) : null,
          el("div", { class: "term-sg-actions" }, [
            useBtn,
            el("button", {
              class: "btn secondary small", type: "button",
              onclick: () => {
                if (sg.end_date) dateInput.value = sg.end_date;
                autoCheck.checked = !!sg.auto_renews;
                notes.value = sg.renewal_terms || "";
                dateInput.focus();
              },
            }, "Edit first"),
            el("button", {
              class: "btn secondary small", type: "button",
              onclick: async (e) => {
                e.currentTarget.disabled = true;
                try { paint(await api(`/api/generated/${docId}/renewal/dismiss`, { method: "POST" })); if (onChange) onChange(); }
                catch (err) { alert(err.message); }
              },
            }, "Dismiss"),
          ]),
        ])
      );
    }

    if (info.end_date) {
      const d = info.days_left;
      body.appendChild(el("div", { class: "term-status" + (d <= 30 ? " soon" : "") }, `Ends ${fmtDay(info.end_date)} · ${endsText(d)}`));
    } else if (!info.suggestion) {
      body.appendChild(el("div", { class: "term-status muted" }, "No end date set. Add one and Rotely will email you before it ends."));
    }
    if (note) body.appendChild(el("div", { class: "term-status muted" }, note));

    body.appendChild(
      el("div", { class: "term-form" }, [
        el("label", { class: "term-field" }, [el("span", {}, "End date"), dateInput]),
        el("label", { class: "term-check", for: `term-auto-${docId}` }, [autoCheck, "Renews automatically"]),
        el("label", { class: "term-field wide" }, [el("span", {}, "Notes"), notes]),
      ])
    );
    const actions = [
      el("button", {
        class: "btn small", type: "button",
        onclick: (e) => save({ end_date: dateInput.value || null, auto_renews: autoCheck.checked, renewal_terms: notes.value }, e.currentTarget),
      }, "Save"),
    ];
    if (info.ai_available && !info.suggestion) {
      actions.push(
        el("button", {
          class: "btn secondary small", type: "button",
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = "Reading...";
            try {
              const res = await api(`/api/generated/${docId}/renewal/suggest`, { method: "POST" });
              paint(res, res.found ? null : "Couldn't find a clear end date in this document.");
              if (onChange) onChange();
            } catch (err) {
              btn.disabled = false;
              btn.textContent = "Suggest from document";
              alert(err.message);
            }
          },
        }, "Suggest from document")
      );
    }
    body.appendChild(el("div", { class: "term-actions" }, actions));
  }

  api(`/api/generated/${docId}/renewal`)
    .then((info) => paint(info))
    .catch((err) => { body.innerHTML = ""; body.appendChild(el("div", { class: "error-box" }, err.message || "Couldn't load the contract term.")); });
  return box;
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
