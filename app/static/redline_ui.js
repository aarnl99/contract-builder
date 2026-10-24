// Shared building blocks for the in-document redline tools, used by the
// client's review page (share.js) and the sender's document preview
// (app.js). Plain DOM helpers only: they know nothing about either page's
// state, so each page keeps its own list of suggestions and just asks these
// helpers "where in the document did the person click?", "what should the
// next list label be?", and so on.
//
// What the tools do:
//   - highlight text  -> pill: Comment / Replace / Delete
//   - click between words -> pill: Insert text here / New paragraph below
//   - Bold / Italic / Underline for inserted text and new paragraphs
//   - a pinned key that explains the colours and the three gestures
(function () {
  const RU = {};

  // Anything the page itself paints into a run (suggested text, badges,
  // ghost text) is not part of the document's own text, so it must not
  // count when we turn a click into an offset in the ORIGINAL run text.
  RU.SKIP_SELECTOR = ".fv-ins, .fv-ghost, .rl-badge";

  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    });
    [].concat(children == null ? [] : children).forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }
  RU.h = h;

  function skipped(textNode) {
    const p = textNode.parentElement;
    return !!(p && p.closest(RU.SKIP_SELECTOR));
  }

  // Offset of (node, offset) measured in the run's original text. Returns
  // null when the point sits inside text we painted ourselves.
  RU.origOffset = function (runEl, node, offset) {
    if (node.nodeType !== 3) return null;
    if (skipped(node)) return null;
    let total = 0;
    const walker = document.createTreeWalker(runEl, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n === node) return total + offset;
      if (!skipped(n)) total += n.length;
    }
    return null;
  };

  RU.origLength = function (runEl) {
    let total = 0;
    const walker = document.createTreeWalker(runEl, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) if (!skipped(n)) total += n.length;
    return total;
  };

  function closestWithClass(node, cls) {
    let e = node && (node.nodeType === 3 ? node.parentElement : node);
    while (e && !(e.classList && e.classList.contains(cls))) e = e.parentElement;
    return e;
  }

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

  // A drag-selection -> {paragraph_index, table_path, segments, text}, or
  // {error: "cross-paragraph"}, or null when it can't be mapped.
  RU.selectionInfo = function (container, range) {
    if (!range || range.collapsed) return null;
    if (!container.contains(range.commonAncestorContainer)) return null;
    const s = toTextNode(range.startContainer, range.startOffset);
    const e = toTextNode(range.endContainer, range.endOffset);
    if (!s.node || !e.node) return null;
    const sRun = closestWithClass(s.node, "run"), eRun = closestWithClass(e.node, "run");
    const sPara = closestWithClass(s.node, "para"), ePara = closestWithClass(e.node, "para");
    if (!sRun || !eRun || !sPara || !ePara) return null;
    if (sPara !== ePara) return { error: "cross-paragraph" };
    const so = RU.origOffset(sRun, s.node, s.offset);
    const eo = RU.origOffset(eRun, e.node, e.offset);
    if (so == null || eo == null) return null;

    const base = {
      paragraph_index: parseInt(sPara.dataset.p, 10),
      table_path: sPara.dataset.path || "",
      text: "",
    };
    const runs = Array.from(sPara.querySelectorAll(".run"));
    const si = runs.indexOf(sRun), ei = runs.indexOf(eRun);
    if (si === -1 || ei === -1 || si > ei) return null;
    const segments = [];
    for (let i = si; i <= ei; i++) {
      const runEl = runs[i];
      const r = parseInt(runEl.dataset.r, 10);
      const len = RU.origLength(runEl);
      const a = i === si ? so : 0;
      const b = i === ei ? eo : len;
      if (a < b) segments.push({ r, start: a, end: b });
    }
    if (!segments.length) return null;
    return { ...base, segments, text: range.toString() };
  };

  RU.caretRangeFromPoint = function (x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      const r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      r.collapse(true);
      return r;
    }
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    return null;
  };

  // A click between two characters -> a zero-width location. Returns
  // {paragraph_index, table_path, segments:[{r,start,end}], paraEl, runEl, rect}.
  RU.caretInfo = function (container, x, y, fallbackRange) {
    let r = RU.caretRangeFromPoint(x, y);
    if (!r || !container.contains(r.startContainer)) r = fallbackRange || null;
    if (!r || !container.contains(r.startContainer)) return null;
    const t = toTextNode(r.startContainer, r.startOffset);
    if (!t.node) return null;
    const runEl = closestWithClass(t.node, "run");
    const paraEl = closestWithClass(t.node, "para");
    if (!runEl || !paraEl) return null;
    const off = RU.origOffset(runEl, t.node, t.offset);
    if (off == null) return null;
    const rects = r.getClientRects ? r.getClientRects() : [];
    const rect = rects.length ? rects[0] : { left: x, right: x, top: y - 9, bottom: y + 9 };
    return {
      paragraph_index: parseInt(paraEl.dataset.p, 10),
      table_path: paraEl.dataset.path || "",
      segments: [{ r: parseInt(runEl.dataset.r, 10), start: off, end: off }],
      paraEl, runEl,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    };
  };

  // The label a new list item should start with, copied from the paragraph
  // above: "d." -> "e.", "(c)" -> "(d)", "3.2" -> "3.3", "4)" -> "5)". The
  // spacing after the label is copied too. Empty when the paragraph above
  // isn't a typed list item (e.g. Word numbers it itself).
  RU.nextLabel = function (rawText) {
    const t = (rawText || "").replace(/ /g, " ").replace(/^\s+/, "");
    let m;
    const bump = (c) => (c === "z" || c === "Z" ? null : String.fromCharCode(c.charCodeAt(0) + 1));
    if ((m = t.match(/^\(([A-Za-z])\)(\s+)/))) { const n = bump(m[1]); return n ? `(${n})${m[2]}` : ""; }
    if ((m = t.match(/^([A-Za-z])([.)])(\s+)/))) { const n = bump(m[1]); return n ? `${n}${m[2]}${m[3]}` : ""; }
    if ((m = t.match(/^(\d{1,3}(?:\.\d{1,3})+)\.?(\s+)/))) {
      const parts = m[1].split(".");
      parts[parts.length - 1] = String(parseInt(parts[parts.length - 1], 10) + 1);
      return parts.join(".") + m[2];
    }
    if ((m = t.match(/^(\d{1,3})([.)])(\s+)/))) return `${parseInt(m[1], 10) + 1}${m[2]}${m[3]}`;
    return "";
  };

  // Typing words between two others: add the spaces a person would expect
  // ("is" + "in full" + "due" -> "is in full due") without ever doubling one.
  RU.padInsert = function (prevChar, nextChar, value) {
    if (!value || !value.trim()) return value;
    let v = value;
    const opensBefore = /[\s(\[{“"'‘—–\-\/]/;
    const closesAfter = /[\s)\]}”"'’.,;:!?—–\-\/%]/;
    if (prevChar && !opensBefore.test(prevChar) && !/^[\s.,;:!?)\]}”"'’%]/.test(v)) v = " " + v;
    if (nextChar && !closesAfter.test(nextChar) && !/[\s(\[{“"'‘—–\-\/]$/.test(v)) v = v + " ";
    return v;
  };

  RU.fmtString = function (f) {
    return (f && f.b ? "b" : "") + (f && f.i ? "i" : "") + (f && f.u ? "u" : "");
  };
  RU.fmtFlags = function (s) {
    s = s || "";
    return { b: s.includes("b"), i: s.includes("i"), u: s.includes("u") };
  };
  RU.fmtClasses = function (s) {
    s = s || "";
    return (s.includes("b") ? " fmt-b" : "") + (s.includes("i") ? " fmt-i" : "") + (s.includes("u") ? " fmt-u" : "");
  };
  RU.fmtWords = function (s) {
    s = s || "";
    const w = [s.includes("b") && "bold", s.includes("i") && "italic", s.includes("u") && "underlined"].filter(Boolean);
    return w.length ? w.join(", ") : "";
  };

  // B / I / U toggles. state = {b,i,u} is mutated; onChange fires after.
  RU.formatButtons = function (state, onChange) {
    const names = { b: "Bold", i: "Italic", u: "Underline" };
    const row = h("div", { class: "rl-fmt", role: "group", "aria-label": "Text style" });
    ["b", "i", "u"].forEach((k) => {
      const btn = h("button", {
        type: "button", class: "rl-fmt-btn rl-fmt-" + k + (state[k] ? " on" : ""), "aria-label": names[k],
        "aria-pressed": state[k] ? "true" : "false", title: names[k],
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => {
          state[k] = !state[k];
          e.currentTarget.classList.toggle("on", state[k]);
          e.currentTarget.setAttribute("aria-pressed", state[k] ? "true" : "false");
          if (onChange) onChange();
        },
      }, k.toUpperCase());
      row.appendChild(btn);
    });
    return row;
  };

  // Put a floating node near a rect, flipping above when it would run off
  // the bottom of the screen.
  RU.place = function (node, rect, width) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const hgt = node.offsetHeight || 44;
    let top = rect.bottom + 10;
    if (top + hgt > vh - 10) top = Math.max(10, (rect.top != null ? rect.top : rect.bottom) - hgt - 10);
    node.style.top = top + "px";
    const w = node.offsetWidth || width || 280;
    node.style.left = Math.min(vw - w - 10, Math.max(10, rect.left)) + "px";
  };

  // The dark pill. buttons = [{label, cls?, onClick}], null entries skipped.
  RU.pill = function (buttons, rect) {
    const kids = [];
    buttons.filter(Boolean).forEach((b, i) => {
      if (i) kids.push(h("div", { class: "rl-pill-sep" }));
      kids.push(h("button", {
        type: "button", class: "rl-pill-btn" + (b.cls ? " " + b.cls : ""),
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => { e.stopPropagation(); b.onClick(); },
      }, b.label));
    });
    const pill = h("div", { class: "rl-pill", role: "menu" }, kids);
    document.body.appendChild(pill);
    RU.place(pill, rect, 280);
    return pill;
  };

  // The key that stays pinned above the document.
  RU.keyBar = function (opts) {
    opts = opts || {};
    const withComment = opts.comment !== false;
    const sw = (cls, text) => h("span", { class: "rl-key-item" }, [h("i", { class: "rl-sw " + cls }, text)]);
    const help = h("div", { class: "rl-key-help" }, [
      h("div", {}, [h("b", {}, "Highlight text"), withComment ? " to comment on it, replace it or delete it." : " to replace it or delete it."]),
      h("div", {}, [h("b", {}, "Click between words"), " to add words, or a new paragraph below."]),
      h("div", {}, [h("b", {}, "Click a mark"), " you have made to change or remove it."]),
    ]);
    const toggle = h("button", { type: "button", class: "rl-key-toggle", "aria-expanded": "false" }, "How to edit");
    const bar = h("div", { class: "rl-key" }, [
      h("div", { class: "rl-key-row" }, [
        h("span", { class: "rl-key-title" }, "Key"),
        sw("add", "added"), sw("del", "removed"), withComment ? sw("cmt", "comment") : null,
        toggle,
      ]),
      help,
    ]);
    toggle.addEventListener("click", () => {
      const open = bar.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "Hide help" : "How to edit";
    });
    return bar;
  };

  window.RedlineUI = RU;
})();
