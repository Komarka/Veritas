const HOST_ID = "veritas-ai-shadow-host";
const LOGO_URL = chrome.runtime.getURL("assets/veritas-logo.svg");

const STATUS_TEXT = {
  analyzing: "Analyzing text...",
  searching: "Searching Google sources...",
  forming_verdict: "Generating verdict...",
};
const STATUS_PROGRESS = {
  analyzing: 34,
  searching: 64,
  forming_verdict: 92,
};
const STATUS_STEPS = [
  ["analyzing", "Analyzing text..."],
  ["searching", "Searching Google sources..."],
  ["forming_verdict", "Generating verdict..."],
];

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
      typeof payload?.facts === "string"
        ? payload.facts
        : "Facts are unavailable.",
    sources: Array.isArray(payload?.sources)
      ? payload.sources.filter(
          (source) => typeof source === "string" && source.startsWith("http"),
        )
      : [],
    chartData: payload?.chartData || null,
  };
}

function scoreClass(score) {
  if (score >= 70) return "score-good";
  if (score >= 40) return "score-warn";
  return "score-bad";
}

function clampScore(value, fallback = 0) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : fallback;
}

function sourceDomain(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch (error) {
    return String(value || "unknown-source").replace(/^www\./, "");
  }
}

function compactDomain(domain) {
  const cleanDomain = String(domain || "unknown").replace(/^www\./, "");
  return cleanDomain.length > 16
    ? `${cleanDomain.slice(0, 13)}...`
    : cleanDomain;
}

function deterministicWeight(domain, index) {
  const seed = Array.from(domain).reduce(
    (total, char) => total + char.charCodeAt(0),
    index * 17,
  );
  return 45 + (seed % 46);
}

function fallbackChartData(sources, score) {
  const seen = new Set();
  const domains = sources
    .map((source) => sourceDomain(source))
    .filter((domain) => {
      if (!domain || seen.has(domain)) {
        return false;
      }
      seen.add(domain);
      return true;
    })
    .slice(0, 6);

  const chartSources = domains.map((domain, index) => ({
    domain,
    weight: deterministicWeight(domain, index),
    isKeyEvidence: index === 0,
  }));

  const averageTrustScore = chartSources.length
    ? Math.round(
        chartSources.reduce((total, source) => total + source.weight, 0) /
          chartSources.length,
      )
    : clampScore(score);

  return {
    title: "SOURCE WEIGHT DISTRIBUTION",
    sources: chartSources,
    averageTrustScore,
  };
}

function normalizeChartData(payload, sources, score) {
  const rawSources = Array.isArray(payload?.chartData?.sources)
    ? payload.chartData.sources
    : null;

  if (!rawSources || rawSources.length === 0) {
    return fallbackChartData(sources, score);
  }

  const chartSources = rawSources
    .map((source, index) => ({
      domain: compactDomain(source?.domain || `source-${index + 1}`),
      weight: clampScore(source?.weight),
      isKeyEvidence: Boolean(source?.isKeyEvidence),
    }))
    .slice(0, 6);

  if (!chartSources.some((source) => source.isKeyEvidence)) {
    const strongestIndex = chartSources.reduce(
      (best, source, index) =>
        source.weight > chartSources[best].weight ? index : best,
      0,
    );
    chartSources[strongestIndex].isKeyEvidence = true;
  }

  const averageTrustScore = Number.isFinite(
    Number(payload?.chartData?.averageTrustScore),
  )
    ? clampScore(payload.chartData.averageTrustScore)
    : Math.round(
        chartSources.reduce((total, source) => total + source.weight, 0) /
          chartSources.length,
      );

  return {
    title: "SOURCE WEIGHT DISTRIBUTION",
    sources: chartSources,
    averageTrustScore,
  };
}

function createSourceWeightChart(chartData) {
  const bars = [
    ...chartData.sources,
    {
      domain: "Avg Trust",
      weight: chartData.averageTrustScore,
      isAverageTrust: true,
    },
  ];

  return `
    <section class="section chart-section">
      <h3>Source Weight Distribution</h3>
      <div class="chart" style="--bar-count:${bars.length}">
        ${bars
          .map((bar) => {
            const weight = clampScore(bar.weight);
            const classes = ["chart-bar"];
            let label = compactDomain(bar.domain);

            if (bar.isKeyEvidence) {
              classes.push("key-evidence");
              label = "Key Evidence";
            }

            if (bar.isAverageTrust) {
              classes.push("average-trust");
              label = "Avg Trust";
            }

            return `
              <div class="chart-column" title="${escapeAttribute(bar.domain)}: ${Math.round(weight)}%">
                <span class="${classes.join(" ")}" style="--bar-height:${Math.max(6, weight)}%" data-weight="${Math.round(weight)}%"></span>
                <span class="chart-label">${escapeHtml(label)}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function createLoaderMarkup(status = "analyzing") {
  const progress = STATUS_PROGRESS[status] || STATUS_PROGRESS.analyzing;
  const statusRank = STATUS_STEPS.findIndex(([key]) => key === status);

  return `
    <div class="loader-shell" id="loader-shell" data-status="${status}">
      <div class="progress-card">
        <div class="progress-head">
          <span class="progress-orbit" aria-hidden="true"></span>
          <div class="progress-title">Analysis in<br>Progress</div>
          <div class="progress-percent"><strong id="progress-percent">${progress}%</strong><span>Complete</span></div>
        </div>
        <div class="progress-steps">
          ${STATUS_STEPS.map(([key, label], index) => {
            const state = index < statusRank ? "complete" : index === statusRank ? "active" : "pending";
            return `<div class="progress-step ${state}" data-step="${key}"><span class="step-icon" aria-hidden="true"></span><span>${label}</span></div>`;
          }).join("")}
        </div>
        <div class="progress-track" aria-hidden="true"><span id="progress-fill" style="width:${progress}%"></span></div>
      </div>
    </div>
  `;
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
        background: rgba(0, 0, 0, 0.58);
        backdrop-filter: blur(8px);
      }

      .modal {
        display: block;
        width: min(480px, calc(100vw - 32px));
        max-height: min(760px, calc(100vh - 32px));
        overflow: auto;
        border: 1px solid rgba(0, 229, 255, 0.35);
        border-radius: 8px;
        color: #f4f7fb;
        background:
          radial-gradient(circle at 50% 0%, rgba(0, 229, 255, 0.16), transparent 33%),
          linear-gradient(180deg, #171b1d 0%, #0b0e10 100%);
        box-shadow: 0 30px 80px rgba(0, 0, 0, 0.62), 0 0 42px rgba(0, 229, 255, 0.18);
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
      .loader-shell,
      .section,
      .source-list,
      .chart,
      .chart-column {
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
      button,
      .chart-label,
      .status-text {
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

      .close:hover,
      .retry:hover {
        border-color: #00e5ff;
        color: #ffffff;
      }

      .body {
        gap: 14px;
        padding: 16px;
      }

      .loader-shell {
        min-height: 250px;
        place-items: center;
        gap: 18px;
        text-align: center;
      }

      .cyber-loader {
        position: relative;
        display: grid;
        width: 116px;
        height: 116px;
        place-items: center;
      }

      .cyber-loader::before,
      .cyber-loader::after {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid rgba(0, 229, 255, 0.28);
      }

      .cyber-loader::before {
        border-top-color: #00e5ff;
        border-right-color: #00e5ff;
        animation: spin 1.2s linear infinite;
        box-shadow: 0 0 24px rgba(0, 229, 255, 0.18);
      }

      .cyber-loader::after {
        inset: 16px;
        border-bottom-color: #b8b5ff;
        animation: spin-reverse 1.8s linear infinite;
      }

      .loader-core {
        display: block;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: radial-gradient(circle, #dffcff 0%, #00e5ff 45%, rgba(0, 229, 255, 0.08) 72%);
        box-shadow: 0 0 28px rgba(0, 229, 255, 0.55);
        animation: pulse 1.5s ease-in-out infinite;
      }

      .status-text {
        display: block;
        min-height: 22px;
        color: #f4f7fb;
        font-size: 15px;
        font-weight: 800;
        line-height: 1.35;
        opacity: 1;
        transform: translateY(0);
        transition: opacity 180ms ease, transform 180ms ease;
      }

      .status-text.changing {
        opacity: 0;
        transform: translateY(6px);
      }

      .status-subtext {
        display: block;
        color: #aeb8c6;
        font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 10px;
        font-weight: 800;
        text-transform: uppercase;
      }
      .progress-card {
        display: grid;
        gap: 18px;
        width: 100%;
        padding: 22px 24px;
        border: 1px solid rgba(0, 229, 255, 0.42);
        border-radius: 8px;
        background: rgba(8, 27, 32, 0.94);
        box-shadow: 0 0 24px rgba(0, 229, 255, 0.16);
      }

      .progress-head {
        display: grid;
        grid-template-columns: 30px minmax(0, 1fr) auto;
        align-items: center;
        gap: 13px;
      }

      .progress-orbit {
        display: block;
        width: 30px;
        height: 30px;
        border: 2px solid rgba(255, 255, 255, 0.72);
        border-right-color: #00e5ff;
        border-radius: 50%;
        box-shadow: 0 0 14px rgba(0, 229, 255, 0.3);
        animation: spin 1s linear infinite;
      }

      .progress-title {
        display: block;
        color: #00e5ff;
        font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 15px;
        font-weight: 900;
        letter-spacing: 0.14em;
        line-height: 1.25;
        text-transform: uppercase;
      }

      .progress-percent {
        display: grid;
        gap: 2px;
        color: #ffffff;
        font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 12px;
        font-weight: 800;
        line-height: 1.15;
      }

      .progress-percent strong,
      .progress-percent span {
        display: block;
        color: inherit;
        font: inherit;
      }

      .progress-steps {
        display: grid;
        gap: 12px;
      }

      .progress-step {
        display: flex;
        align-items: center;
        gap: 12px;
        color: rgba(198, 197, 212, 0.42);
        font-size: 15px;
        font-weight: 800;
      }

      .step-icon {
        display: grid;
        width: 17px;
        height: 17px;
        flex: 0 0 auto;
        place-items: center;
        border: 2px solid currentColor;
        border-radius: 50%;
      }

      .progress-step.complete,
      .progress-step.active {
        color: #00e5ff;
      }

      .progress-step.complete .step-icon::before {
        content: "";
        width: 7px;
        height: 4px;
        border-bottom: 2px solid currentColor;
        border-left: 2px solid currentColor;
        transform: rotate(-45deg) translateY(-1px);
      }

      .progress-step.active .step-icon {
        border-color: rgba(0, 229, 255, 0.28);
        border-top-color: currentColor;
        animation: spin 900ms linear infinite;
      }

      .progress-step.active .step-icon::before {
        content: "";
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: currentColor;
      }

      .progress-step.pending .step-icon::before {
        content: "";
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background: currentColor;
        box-shadow: -5px 0 0 currentColor, 5px 0 0 currentColor;
      }

      .progress-track {
        display: block;
        height: 4px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.14);
      }

      .progress-track span {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: #00e5ff;
        box-shadow: 0 0 12px rgba(0, 229, 255, 0.42);
        transition: width 220ms ease;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      @keyframes spin-reverse {
        to { transform: rotate(-360deg); }
      }

      @keyframes pulse {
        50% { transform: scale(0.86); opacity: 0.72; }
      }

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

      .chart-section {
        gap: 14px;
      }

      .chart {
        grid-template-columns: repeat(var(--bar-count, 1), minmax(0, 1fr));
        align-items: end;
        gap: 7px;
        min-height: 132px;
        padding-top: 22px;
      }

      .chart-column {
        min-width: 0;
        height: 118px;
        align-items: end;
        gap: 8px;
      }

      .chart-bar {
        position: relative;
        display: block;
        width: 100%;
        height: var(--bar-height, 0%);
        min-height: 8px;
        border-radius: 4px 4px 0 0;
        background: rgba(189, 194, 255, 0.32);
      }

      .chart-bar::after {
        content: attr(data-weight);
        position: absolute;
        right: 50%;
        bottom: calc(100% + 5px);
        transform: translateX(50%);
        color: #cfd6e0;
        font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 9px;
        font-weight: 800;
      }

      .chart-bar.key-evidence {
        background: rgba(0, 227, 253, 0.7);
        box-shadow: 0 0 14px rgba(0, 227, 253, 0.28);
      }

      .chart-bar.average-trust {
        background: rgba(255, 255, 255, 0.42);
      }

      .chart-label {
        display: block;
        max-width: 100%;
        overflow: hidden;
        color: #cfd6e0;
        font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 9px;
        font-weight: 800;
        line-height: 1.2;
        text-align: center;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .error {
        color: #ff7a7a;
      }

      .retry {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 36px;
        padding: 0 14px;
        border: 1px solid #30383d;
        border-radius: 6px;
        color: #00e5ff;
        background: #121617;
        cursor: pointer;
        font-size: 12px;
        font-weight: 900;
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
          ${createLoaderMarkup("analyzing")}
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

function updateStatus(shadow, status) {
  const progress = STATUS_PROGRESS[status] || STATUS_PROGRESS.analyzing;
  const statusRank = STATUS_STEPS.findIndex(([key]) => key === status);
  const percentEl = shadow.querySelector("#progress-percent");
  const fillEl = shadow.querySelector("#progress-fill");

  if (percentEl) {
    percentEl.textContent = `${progress}%`;
  }

  if (fillEl) {
    fillEl.style.width = `${progress}%`;
  }

  for (const [index, [key]] of STATUS_STEPS.entries()) {
    const stepEl = shadow.querySelector(`[data-step="${key}"]`);

    if (!stepEl) {
      continue;
    }

    stepEl.classList.toggle("complete", index < statusRank);
    stepEl.classList.toggle("active", index === statusRank);
    stepEl.classList.toggle("pending", index > statusRank);
  }
}

function renderResult(shadow, selectedText, payload) {
  const result = normalizeResult(payload);
  const chartData = normalizeChartData(payload, result.sources, result.score);
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
    ${createSourceWeightChart(chartData)}
    <section class="section">
      <h3>Sources &amp; Fact-checking Links</h3>
      <ul class="source-list">${sources}</ul>
    </section>
  `;
}

function renderError(shadow, selectedText, message) {
  const content = shadow.querySelector("#content");
  content.innerHTML = `
    <section class="section">
      <h3>Verification error</h3>
      <p class="error">${escapeHtml(message || "Verification error")}</p>
      <button class="retry" type="button">Retry</button>
    </section>
  `;

  content.querySelector(".retry").addEventListener("click", () => {
    startStreamFactCheck(shadow, selectedText);
  });
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

function resetLoader(shadow) {
  const content = shadow.querySelector("#content");
  content.innerHTML = createLoaderMarkup("analyzing");
}

function startStreamFactCheck(shadow, selectedText) {
  resetLoader(shadow);
  updateStatus(shadow, "analyzing");

  const port = chrome.runtime.connect({ name: "veritas-fact-check-stream" });
  let finished = false;

  port.onMessage.addListener((message) => {
    if (message?.type === "VERITAS_STREAM_STATUS") {
      updateStatus(shadow, message.status);
      return;
    }

    if (message?.type === "VERITAS_STREAM_RESULT") {
      finished = true;
      renderResult(shadow, selectedText, message.result);
      port.disconnect();
      return;
    }

    if (message?.type === "VERITAS_STREAM_ERROR") {
      finished = true;
      renderError(shadow, selectedText, message.error || "Verification error");
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    if (!finished && chrome.runtime.lastError) {
      renderError(shadow, selectedText, chrome.runtime.lastError.message);
    }
  });

  port.postMessage({
    type: "VERITAS_STREAM_FACT_CHECK",
    text: selectedText,
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "VERITAS_SELECTION_RECEIVED") {
    return;
  }

  const selectedText = String(message.text || "").trim();
  const { shadow } = createModal();

  if (!selectedText) {
    renderError(shadow, selectedText, "No selected text was received.");
    return;
  }

  startStreamFactCheck(shadow, selectedText);
});
