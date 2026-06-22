const HOST_ID = "veritas-ai-shadow-host";
const LOGO_URL = chrome.runtime.getURL("assets/veritas-logo.svg");

function normalizeResult(payload) {
  return {
    score: Number.isFinite(Number(payload?.score))
      ? Math.max(0, Math.min(100, Number(payload.score)))
      : 0,
    verdict:
      typeof payload?.verdict === "string" ? payload.verdict : "No verdict",
    analysis:
      typeof payload?.analysis === "string"
        ? payload.analysis
        : "Analysis is unavailable.",
    facts:
      typeof payload?.facts === "string" ? payload.facts : "Facts are unavailable.",
    sources: Array.isArray(payload?.sources)
      ? payload.sources.filter(
          (source) => typeof source === "string" && source.startsWith("http"),
        )
      : [],
  };
}

function scoreClass(score) {
  if (score >= 70) return "score-good";
  if (score >= 40) return "score-warn";
  return "score-bad";
}

function createModal() {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      *, *::before, *::after {
        all: initial;
        box-sizing: border-box;
      }

      :host {
        all: initial;
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgba(0, 0, 0, 0.56);
        backdrop-filter: blur(8px);
      }

      .modal {
        display: block;
        width: min(460px, calc(100vw - 32px));
        max-height: min(740px, calc(100vh - 32px));
        overflow: auto;
        border: 1px solid rgba(0, 229, 255, 0.35);
        border-radius: 8px;
        color: #f4f7fb;
        background:
          radial-gradient(circle at 20% 0%, rgba(0, 229, 255, 0.12), transparent 34%),
          linear-gradient(180deg, #171b1d 0%, #0b0e10 100%);
        box-shadow: 0 30px 80px rgba(0, 0, 0, 0.62), 0 0 38px rgba(0, 229, 255, 0.16);
      }

      .header,
      .brand,
      .summary,
      .score-block,
      .link-row {
        display: flex;
      }

      .header {
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 16px;
        border-bottom: 1px solid #2c3337;
      }

      .brand {
        gap: 10px;
        align-items: center;
      }

      .modal-logo {
        display: block;
        width: 36px;
        height: 36px;
        object-fit: contain;
        filter: drop-shadow(0 0 8px rgba(0, 229, 255, 0.28));
      }

      .copy-block,
      .body,
      .loading,
      .section,
      .source-list {
        display: grid;
      }

      .copy-block {
        gap: 3px;
      }

      .eyebrow,
      .label,
      h3 {
        display: block;
        color: #00e5ff;
        font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      h2,
      h3,
      p,
      .verdict,
      .score,
      .score-caption,
      .claim,
      a,
      li,
      button {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      h2 {
        display: block;
        color: #f4f7fb;
        font-size: 18px;
        font-weight: 900;
        line-height: 1.15;
      }

      .close {
        display: grid;
        width: 32px;
        height: 32px;
        place-items: center;
        border: 1px solid #30383d;
        border-radius: 6px;
        color: #aeb8c6;
        background: #121617;
        cursor: pointer;
        font-size: 15px;
        font-weight: 900;
        line-height: 1;
      }

      .close:hover {
        border-color: #00e5ff;
        color: #ffffff;
      }

      .body {
        gap: 14px;
        padding: 16px;
      }

      .loading {
        gap: 14px;
        min-height: 190px;
        place-items: center;
        text-align: center;
      }

      .spinner {
        display: block;
        width: 72px;
        height: 72px;
        border: 7px solid #30383d;
        border-top-color: #00e5ff;
        border-radius: 50%;
        animation: spin 900ms linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .loading p,
      .section p,
      .section li,
      .claim {
        display: block;
        color: #d9e0ea;
        font-size: 13px;
        line-height: 1.5;
        overflow-wrap: anywhere;
      }

      .claim {
        padding: 12px;
        border: 1px solid #2c3337;
        border-radius: 6px;
        background: #0d1012;
      }

      .summary {
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 14px;
        border: 1px solid #30383d;
        border-radius: 8px;
        background: #1c2022;
      }

      .verdict {
        display: block;
        margin-top: 6px;
        color: #f4f7fb;
        font-size: 19px;
        font-weight: 900;
        line-height: 1.2;
        overflow-wrap: anywhere;
      }

      .score-block {
        flex: 0 0 auto;
        flex-direction: column;
        align-items: center;
        gap: 7px;
      }

      .score {
        display: grid;
        width: 82px;
        height: 82px;
        place-items: center;
        border: 7px solid #00e5ff;
        border-radius: 50%;
        color: #ffffff;
        font-size: 25px;
        font-weight: 900;
      }

      .score-caption {
        display: block;
        width: 96px;
        color: #cfd6e0;
        font-size: 10px;
        font-weight: 800;
        line-height: 1.2;
        text-align: center;
        text-transform: uppercase;
      }

      .score-good { border-color: #21d07a; }
      .score-warn { border-color: #ffad42; }
      .score-bad { border-color: #ff6b6b; }

      .section {
        gap: 8px;
        padding: 14px;
        border: 1px solid #30383d;
        border-radius: 8px;
        background: rgba(21, 24, 25, 0.96);
      }

      h3 {
        color: #b8b5ff;
        font-size: 12px;
      }

      .source-list {
        gap: 9px;
        padding: 0;
        margin: 0;
        list-style: none;
      }

      .link-row {
        min-width: 0;
        align-items: center;
        gap: 8px;
      }

      a {
        display: block;
        min-width: 0;
        color: #00e5ff;
        cursor: pointer;
        font-size: 13px;
        line-height: 1.35;
        overflow-wrap: anywhere;
        text-decoration: underline;
      }

      .error {
        color: #ff7a7a;
      }
    </style>
    <div class="backdrop">
      <article class="modal" role="dialog" aria-modal="true" aria-label="Veritas AI fact check">
        <header class="header">
          <div class="brand">
            <img class="modal-logo" src="${LOGO_URL}" alt="Veritas AI logo">
            <div class="copy-block">
              <div class="eyebrow">SYSTEM STATUS: ACTIVE</div>
              <h2>Veritas AI</h2>
            </div>
          </div>
          <button class="close" type="button" aria-label="Close">X</button>
        </header>
        <div class="body" id="content">
          <div class="loading">
            <div class="spinner" aria-hidden="true"></div>
            <p>Veritas AI is scanning the web...</p>
          </div>
        </div>
      </article>
    </div>
  `;

  shadow.querySelector(".close").addEventListener("click", () => host.remove());
  shadow.querySelector(".backdrop").addEventListener("click", (event) => {
    if (event.target.classList.contains("backdrop")) {
      host.remove();
    }
  });

  document.documentElement.append(host);
  return { host, shadow };
}

function renderResult(shadow, selectedText, payload) {
  const result = normalizeResult(payload);
  const content = shadow.querySelector("#content");
  const sources = result.sources.length
    ? result.sources
        .map(
          (source) => `
            <li class="link-row">
              <a href="${escapeAttribute(source)}" target="_blank" rel="noreferrer">${escapeHtml(source)}</a>
            </li>
          `,
        )
        .join("")
    : "<li>No verified source URLs returned.</li>";

  content.innerHTML = `
    <div class="claim">${escapeHtml(selectedText)}</div>
    <section class="summary">
      <div>
        <div class="label">Verdict</div>
        <p class="verdict">${escapeHtml(result.verdict)}</p>
      </div>
      <div class="score-block">
        <div class="score ${scoreClass(result.score)}">${Math.round(result.score)}</div>
        <div class="score-caption">Bias/Lie Score</div>
      </div>
    </section>
    <section class="section">
      <h3>Comprehensive Analysis</h3>
      <p>${escapeHtml(result.analysis)}</p>
    </section>
    <section class="section">
      <h3>Facts</h3>
      <p>${escapeHtml(result.facts)}</p>
    </section>
    <section class="section">
      <h3>Sources &amp; Fact-checking Links</h3>
      <ul class="source-list">${sources}</ul>
    </section>
  `;
}

function renderError(shadow, message) {
  const content = shadow.querySelector("#content");
  content.innerHTML = `
    <section class="section">
      <h3>Check failed</h3>
      <p class="error">${escapeHtml(message)}</p>
    </section>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "VERITAS_SELECTION_RECEIVED") {
    return;
  }

  const selectedText = String(message.text || "").trim();
  const { shadow } = createModal();

  if (!selectedText) {
    renderError(shadow, "No selected text was received.");
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "VERITAS_RUN_FACT_CHECK",
      text: selectedText,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        renderError(shadow, chrome.runtime.lastError.message);
        return;
      }

      if (!response?.ok) {
        renderError(
          shadow,
          response?.error || "Unable to complete the fact check.",
        );
        return;
      }

      renderResult(shadow, selectedText, response.result);
    },
  );
});
