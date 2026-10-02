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
  let stream = null;
  let capturedDataUrl = null;

  const consentCheckbox = el("input", { type: "checkbox", id: "consent-checkbox" });
  const errBox = el("div");
  const video = el("video", { autoplay: "true", playsinline: "true", style: "width:100%;border-radius:8px;background:#000;display:none;" });
  const canvas = el("canvas", { style: "display:none;" });
  const photoPreview = el("img", { style: "width:100%;border-radius:8px;display:none;" });
  const startCameraBtn = el("button", { class: "btn block" }, "Agree & continue");
  const captureBtn = el("button", { class: "btn block", style: "display:none;" }, "Take photo");
  const retakeBtn = el("button", { class: "btn secondary", style: "display:none;" }, "Retake");
  const confirmBtn = el("button", { class: "btn", style: "display:none;" }, "Confirm & continue to signing");

  function showError(msg) {
    errBox.innerHTML = "";
    errBox.appendChild(el("div", { class: "error-box" }, msg));
  }

  async function startCamera() {
    errBox.innerHTML = "";
    if (!consentCheckbox.checked) {
      showError("Please check the box above to continue.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError("This browser can't access the camera. Try a recent version of Chrome, Safari, or Firefox.");
      return;
    }
    startCameraBtn.disabled = true;
    startCameraBtn.textContent = "Requesting camera access...";
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      video.srcObject = stream;
      video.style.display = "block";
      captureBtn.style.display = "block";
      startCameraBtn.style.display = "none";
      consentCheckbox.disabled = true;
    } catch (e) {
      showError("Camera access was blocked. You'll need to allow camera access in your browser to continue.");
      startCameraBtn.disabled = false;
      startCameraBtn.textContent = "Agree & continue";
    }
  }

  function takePhoto() {
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    capturedDataUrl = canvas.toDataURL("image/jpeg", 0.85);
    photoPreview.src = capturedDataUrl;
    photoPreview.style.display = "block";
    video.style.display = "none";
    captureBtn.style.display = "none";
    retakeBtn.style.display = "inline-block";
    confirmBtn.style.display = "inline-block";
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  function retake() {
    capturedDataUrl = null;
    photoPreview.style.display = "none";
    retakeBtn.style.display = "none";
    confirmBtn.style.display = "none";
    startCamera();
  }

  async function confirmAndSubmit() {
    if (!capturedDataUrl) return;
    errBox.innerHTML = "";
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Submitting...";
    try {
      const result = await api(`/api/sign/${TOKEN}/consent`, {
        method: "POST",
        body: { consent: true, photo: capturedDataUrl },
      });
      render(SigningFormView({ ...status, embed_src: result.embed_src }));
    } catch (e) {
      showError(e.message || "Something went wrong. Try again.");
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm & continue to signing";
    }
  }

  startCameraBtn.addEventListener("click", startCamera);
  captureBtn.addEventListener("click", takePhoto);
  retakeBtn.addEventListener("click", retake);
  confirmBtn.addEventListener("click", confirmAndSubmit);

  return el("div", {}, [
    topbar(),
    centeredCard([
      el("h2", {}, `Sign "${status.document_name}"`),
      el("p", { class: "subtitle" }, `${status.sender_name} sent this to ${status.signer_name} to sign.`),
      el("div", { class: "card", style: "background:var(--bg);box-shadow:none;margin-bottom:16px;" }, [
        el("label", { style: "display:flex;gap:10px;align-items:flex-start;cursor:pointer;" }, [
          consentCheckbox,
          el("span", {}, [
            "Before signing, we'll take a quick photo of you with your camera. It's stored alongside this signed document as part of the signing record -- it isn't used to verify your identity, just to discourage and record who was present when the document was signed.",
          ]),
        ]),
      ]),
      video,
      canvas,
      photoPreview,
      errBox,
      el("div", { style: "display:flex;gap:10px;margin-top:8px;" }, [startCameraBtn, captureBtn, retakeBtn, confirmBtn]),
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
  if (status.status === "awaiting_consent") {
    render(ConsentView(status));
    return;
  }
  // ready_to_sign -- consent already recorded (e.g. a reloaded tab), go
  // straight to the DocuSeal form.
  render(SigningFormView(status));
}

main();
