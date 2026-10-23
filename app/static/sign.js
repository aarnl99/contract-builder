// Standalone client-facing signing page. Deliberately separate from
// share.js -- this flow (consent -> photo -> DocuSeal signing form) shares
// no steps with redlining once past the topbar. No account, no session
// token to manage: the token in the URL identifies exactly one signer for
// exactly one signature request, the same bearer-link model DocuSeal's own
// /s/{slug} signing URLs use.

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

const TOKEN = location.pathname.replace(/^\/sign\//, "").replace(/\/$/, "");

async function api(path, opts = {}) {
  const headers = opts.body ? { "Content-Type": "application/json" } : {};
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
    const res = await fetch(`/api/sign/${TOKEN}/brand`);
    if (!res.ok) return;
    BRAND = await res.json();
    if (!BRAND || !BRAND.name) { BRAND = null; return; }
    document.querySelectorAll(".share-topbar").forEach((n) => n.replaceWith(topbar()));
    if (!document.querySelector(".powered-by")) app.appendChild(poweredBy());
  } catch (e) { /* keep the default look */ }
}

function topbar() {
  if (BRAND && BRAND.name) {
    return el("div", { class: "share-topbar" }, [
      el("div", { class: "brand brand-custom" }, [
        BRAND.logo_url
          ? el("img", { class: "brand-logo", src: BRAND.logo_url, alt: BRAND.name })
          : el("div", { class: "brand-name" }, BRAND.name),
      ]),
    ]);
  }
  return el("div", { class: "share-topbar" }, [
    el("a", { class: "brand", href: "https://rotely.ai", style: "text-decoration:none;color:inherit;" }, [
      el("div", { class: "word" }, ["Rotely", el("span", { class: "dot" }, ".ai")]),
    ]),
  ]);
}

function centeredCard(children) {
  return el("div", { style: "max-width:520px;margin:64px auto;padding:0 20px;" }, [
    el("div", { class: "card" }, children),
  ]);
}

function ErrorView(message) {
  return el("div", {}, [topbar(), centeredCard([
    el("h2", {}, "Can't open this link"),
    el("div", { class: "error-box" }, message),
  ])]);
}

function MessageView(title, body) {
  return el("div", {}, [topbar(), centeredCard([
    el("h2", {}, title),
    el("p", { class: "subtitle" }, body),
  ])]);
}

function SigningFormView(status) {
  const container = el("div", { id: "docuseal-form-container" });
  const wrap = el("div", {}, [
    topbar(),
    el("div", { style: "max-width:720px;margin:32px auto;padding:0 20px;" }, [
      el("div", { class: "card" }, [
        el("h2", {}, `Sign "${status.document_name}"`),
        el("p", { class: "subtitle" }, `Sent by ${status.sender_name}`),
      ]),
      container,
    ]),
  ]);

  function mountForm() {
    const script = document.createElement("script");
    script.src = "https://cdn.docuseal.com/js/form.js";
    script.onload = () => {
      const form = document.createElement("docuseal-form");
      form.id = "docusealForm";
      form.setAttribute("data-src", status.embed_src);
      form.setAttribute("data-with-title", "false");
      container.appendChild(form);
      form.addEventListener("completed", () => {
        // UI hint only -- per DocuSeal's own security guidance, this
        // browser event can be forged and is never trusted for anything
        // that changes state. The actual "signed" status is set only by
        // main.py's webhook route, verified via HMAC. This just tells the
        // person what to expect next.
        const note = el("div", { class: "card", style: "margin-top:16px;" }, [
          el("p", { class: "subtitle", style: "margin:0;" }, "Thanks -- your signature was recorded. We're confirming it now; you'll get an email once everyone has signed."),
        ]);
        wrap.appendChild(note);
      });
    };
    document.head.appendChild(script);
  }

  if (window.customElements && window.customElements.get("docuseal-form")) {
    mountForm();
  } else {
    mountForm();
  }
  return wrap;
}

function ConsentView(status) {
  // What the sender asked for: nothing beyond agreeing, a selfie, or a
  // selfie plus a photo of the signer's ID. Each photo step happens in
  // order, then everything is sent in one request.
  const level = status.photo_check || "none";
  const steps = level === "selfie_id" ? ["selfie", "id"] : level === "selfie" ? ["selfie"] : [];
  const STEP_LABEL = { selfie: "Selfie", id: "Photo ID" };
  const photos = { selfie: null, id: null };
  let stepIndex = -1; // -1 = still on the agreement
  let stream = null;
  let pending = null; // photo just taken, not yet accepted

  const sender = status.sender_name || "the sender";
  const agreeText = {
    none: "I agree to review and sign this document electronically.",
    selfie: `Before signing, we'll take a quick selfie. It's stored encrypted alongside this signed document as part of the signing record, and only ${sender} can view it. It isn't used to automatically verify your identity.`,
    selfie_id: `Before signing, we'll take a quick selfie and a photo of your ID. Both are stored encrypted alongside this signed document as part of the signing record, and only ${sender} can view them. They are not sent to DocuSeal and are not matched automatically.`,
  }[level];

  const consentCheckbox = el("input", { type: "checkbox", id: "consent-checkbox" });
  const errBox = el("div");
  const stepsBar = el("div", { class: "capture-steps", style: steps.length ? "" : "display:none;" });
  const hint = el("p", { class: "subtitle", style: "display:none;margin:0 0 10px;" });
  const video = el("video", { autoplay: "true", playsinline: "true", muted: "true", class: "capture-frame", style: "display:none;" });
  const canvas = el("canvas", { style: "display:none;" });
  const photoPreview = el("img", { class: "capture-frame", style: "display:none;" });
  const startBtn = el("button", { class: "btn block" }, steps.length ? "Agree & continue" : "Agree & continue to signing");
  const captureBtn = el("button", { class: "btn block", style: "display:none;" }, "Take photo");
  const retakeBtn = el("button", { class: "btn secondary", style: "display:none;" }, "Retake");
  const confirmBtn = el("button", { class: "btn", style: "display:none;" }, "Use this photo");

  function showError(msg) {
    errBox.innerHTML = "";
    errBox.appendChild(el("div", { class: "error-box" }, msg));
  }

  function drawSteps() {
    stepsBar.innerHTML = "";
    steps.forEach((k, i) => {
      const cls = "capture-step" + (i < stepIndex || photos[k] ? " done" : i === stepIndex ? " active" : "");
      stepsBar.appendChild(el("div", { class: cls }, `${i + 1}. ${STEP_LABEL[k]}`));
    });
  }

  function stopStream() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function startCamera() {
    errBox.innerHTML = "";
    const kind = steps[stepIndex];
    hint.textContent = kind === "id"
      ? "Hold your ID flat in good light so the text and your photo are readable, then take the photo."
      : "Look at the camera in good light, then take the photo.";
    hint.style.display = "block";
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError("This browser can't access the camera. Try a recent version of Chrome, Safari, or Firefox.");
      return false;
    }
    try {
      const facing = kind === "id" ? { ideal: "environment" } : "user";
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
      video.srcObject = stream;
      video.style.display = "block";
      photoPreview.style.display = "none";
      captureBtn.style.display = "block";
      retakeBtn.style.display = "none";
      confirmBtn.style.display = "none";
      return true;
    } catch (e) {
      showError("Camera access was blocked. You'll need to allow camera access in your browser to continue.");
      return false;
    }
  }

  async function begin() {
    errBox.innerHTML = "";
    if (!consentCheckbox.checked) {
      showError("Please check the box above to continue.");
      return;
    }
    if (!steps.length) {
      submitAll();
      return;
    }
    startBtn.disabled = true;
    startBtn.textContent = "Requesting camera access...";
    stepIndex = 0;
    drawSteps();
    const ok = await startCamera();
    if (ok) {
      startBtn.style.display = "none";
      consentCheckbox.disabled = true;
    } else {
      stepIndex = -1;
      drawSteps();
      startBtn.disabled = false;
      startBtn.textContent = "Agree & continue";
    }
  }

  function takePhoto() {
    const maxSide = 1600;
    let w = video.videoWidth || 640;
    let h = video.videoHeight || 480;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    pending = canvas.toDataURL("image/jpeg", 0.85);
    photoPreview.src = pending;
    photoPreview.style.display = "block";
    video.style.display = "none";
    captureBtn.style.display = "none";
    retakeBtn.style.display = "inline-block";
    confirmBtn.style.display = "inline-block";
    confirmBtn.textContent = stepIndex < steps.length - 1 ? "Use this photo & continue" : "Confirm & continue to signing";
    stopStream();
  }

  async function retake() {
    pending = null;
    await startCamera();
  }

  async function acceptPhoto() {
    if (!pending) return;
    photos[steps[stepIndex]] = pending;
    pending = null;
    if (stepIndex < steps.length - 1) {
      stepIndex += 1;
      drawSteps();
      await startCamera();
      return;
    }
    drawSteps();
    await submitAll();
  }

  async function submitAll() {
    errBox.innerHTML = "";
    confirmBtn.disabled = true;
    startBtn.disabled = true;
    confirmBtn.textContent = "Submitting...";
    try {
      const result = await api(`/api/sign/${TOKEN}/consent`, {
        method: "POST",
        body: { consent: true, photo: photos.selfie || "", id_photo: photos.id || "" },
      });
      stopStream();
      render(SigningFormView({ ...status, embed_src: result.embed_src }));
    } catch (e) {
      showError(e.message || "Something went wrong. Try again.");
      confirmBtn.disabled = false;
      startBtn.disabled = false;
      confirmBtn.textContent = "Confirm & continue to signing";
    }
  }

  startBtn.addEventListener("click", begin);
  captureBtn.addEventListener("click", takePhoto);
  retakeBtn.addEventListener("click", retake);
  confirmBtn.addEventListener("click", acceptPhoto);

  return el("div", {}, [
    topbar(),
    centeredCard([
      el("h2", {}, `Sign "${status.document_name}"`),
      el("p", { class: "subtitle" }, `${status.sender_name} sent this to ${status.signer_name} to sign.`),
      el("div", { class: "card", style: "background:var(--bg);box-shadow:none;margin-bottom:16px;" }, [
        el("label", { style: "display:flex;gap:10px;align-items:flex-start;cursor:pointer;" }, [
          consentCheckbox,
          el("span", {}, [agreeText]),
        ]),
      ]),
      stepsBar,
      hint,
      video,
      canvas,
      photoPreview,
      errBox,
      el("div", { style: "display:flex;gap:10px;margin-top:8px;" }, [startBtn, captureBtn, retakeBtn, confirmBtn]),
    ]),
  ]);
}

async function main() {
  render(MessageView("Loading...", ""));
  let status;
  try {
    status = await api(`/api/sign/${TOKEN}`);
  } catch (e) {
    render(ErrorView(e.message || "This signing link is invalid or has expired."));
    return;
  }

  if (status.request_status === "cancelled") {
    render(MessageView("This request was cancelled", "The sender cancelled this signature request. Reach out to them if you believe this is a mistake."));
    return;
  }
  if (status.request_status === "expired") {
    render(MessageView("This link has expired", "Ask the sender to send a new signature request."));
    return;
  }
  if (status.status === "declined") {
    render(MessageView("Declined", "This document was declined."));
    return;
  }
  if (status.status === "completed") {
    render(MessageView("Already signed", "You've already signed this document. No further action is needed."));
    return;
  }
  if (status.your_turn === false) {
    const who = (status.waiting_on || []).join(", ");
    render(MessageView(
      "Waiting for your turn",
      `This document is signed in order, and ${who || "another signer"} still needs to sign first. You'll get an email as soon as it's your turn.`
    ));
    return;
  }
  if (status.status === "awaiting_consent") {
    render(ConsentView(status));
    return;
  }
  // ready_to_sign -- consent already recorded (e.g. a reloaded tab), go
  // straight to the DocuSeal form.
  render(SigningFormView(status));
}

main();
loadBrand();
