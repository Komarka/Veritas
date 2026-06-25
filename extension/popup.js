import { initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

const CLOUD_FUNCTION_URL =
  "https://us-central1-veritas-c2907.cloudfunctions.net/factCheck";
const TOKEN_STORAGE_KEY = "veritasAuth";
const LEGACY_TOKEN_STORAGE_KEY = "veritas_token";
const PENDING_CLAIM_STORAGE_KEY = "veritasPendingClaim";
const PENDING_IMAGE_STORAGE_KEY = "veritasPendingImage";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const STREAM_STATUS_TEXT = {
  analyzing: "Analyzing text...",
  searching: "Searching Google sources...",
  forming_verdict: "Generating verdict...",
};
const STREAM_STATUS_PROGRESS = {
  analyzing: 34,
  searching: 64,
  forming_verdict: 92,
};

const firebaseConfig = {
  apiKey: "AIzaSyAr2nGkJueFNBXT803B4O3i6Mr6I4qeExo",
  authDomain: "veritas-c2907.firebaseapp.com",
  projectId: "veritas-c2907",
  storageBucket: "veritas-c2907.firebasestorage.app",
  messagingSenderId: "747739833868",
  appId: "1:747739833868:web:9bd9c5dfbe01925dbbf029",
  measurementId: "G-BQLF4YLZ4E",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const appShell = document.querySelector(".app-shell");
const authView = document.querySelector("#auth-view");
const dashboardView = document.querySelector("#dashboard-view");
const authForm = document.querySelector("#auth-form");
const emailInput = document.querySelector("#email");
const passwordInput = document.querySelector("#password");
const loginBtn = document.querySelector("#login-btn");
const registerBtn = document.querySelector("#register-btn");
const googleLoginBtn = document.querySelector("#google-login-btn");
const logoutBtn = document.querySelector("#logout-btn");
const errorBanner = document.querySelector("#error-banner");
const errorBannerText = document.querySelector("#error-banner-text");
const loadingBanner = document.querySelector("#loading-banner");
const loadingBannerText = document.querySelector("#loading-banner-text");
const sessionLabel = document.querySelector("#session-label");
const claimText = document.querySelector("#claim-text");
const factCheckBtn = document.querySelector("#fact-check-btn");
const resultBox = document.querySelector("#result-box");
const verdictEl = document.querySelector("#verdict");
const scoreEl = document.querySelector("#score");
const scoreRing = document.querySelector("#score-ring");
const confidenceChip = document.querySelector("#confidence-chip");
const sourceCountEl = document.querySelector("#source-count");
const alertsBadgeEl = document.querySelector("#alerts-badge");
const analysisEl = document.querySelector("#analysis");
const factsEl = document.querySelector("#facts");
const sourcesEl = document.querySelector("#sources");
const sourceWeightTitleEl = document.querySelector("#source-weight-title");
const sourceWeightChartEl = document.querySelector("#source-weight-chart");
const sourceWeightLabelsEl = document.querySelector("#source-weight-labels");
const alertsSummaryEl = document.querySelector("#alerts-summary");
const alertsContainerEl = document.querySelector("#alerts-container");
const dashboardPanes = document.querySelectorAll("[data-view]");
const navButtons = document.querySelectorAll("[data-nav-view]");
const sourceModeButtons = document.querySelectorAll("[data-source-mode]");
const sourceModePanels = document.querySelectorAll("[data-source-panel]");
const resultOnlyEls = document.querySelectorAll(".result-only");
const checkModeButtons = document.querySelectorAll("[data-check-mode]");
const checkModePanels = document.querySelectorAll("[data-check-panel]");
const imageFileInput = document.querySelector("#image-file-input");
const imageDropZone = document.querySelector("#image-drop-zone");
const imageEmptyState = document.querySelector("#image-empty-state");
const imagePreviewState = document.querySelector("#image-preview-state");
const imagePreview = document.querySelector("#image-preview");
const imageMeta = document.querySelector("#image-meta");
const imageCheckBtn = document.querySelector("#image-check-btn");
const imageResultBox = document.querySelector("#image-result-box");
const imageVerdictEl = document.querySelector("#image-verdict");
const imageScoreEl = document.querySelector("#image-score");
const imageAiProbabilityEl = document.querySelector("#image-ai-probability");
const imageAiAnalysisEl = document.querySelector("#image-ai-analysis");
const imageTextAnalysisEl = document.querySelector("#image-text-analysis");
let selectedImage = null;
let unreadAlerts = [];

function setVisible(element, isVisible) {
  element.classList.toggle("hidden", !isVisible);
}

function setActiveView(viewName, options = {}) {
  for (const pane of dashboardPanes) {
    const isTarget = pane.dataset.view === viewName;
    pane.classList.toggle("hidden", !isTarget);
  }

  for (const button of navButtons) {
    const isTarget = button.dataset.navView === viewName;
    button.classList.toggle("active", isTarget);
    button.setAttribute("aria-current", isTarget ? "page" : "false");
  }

  if (viewName === "alerts") {
    unreadAlerts = [];
    updateAlertsBadge(unreadAlerts);
  }

  if (options.scrollToTop !== false) {
    appShell.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function setCheckMode(mode) {
  for (const button of checkModeButtons) {
    const isTarget = button.dataset.checkMode === mode;
    button.classList.toggle("active", isTarget);
    button.setAttribute("aria-selected", String(isTarget));
  }

  for (const panel of checkModePanels) {
    setVisible(panel, panel.dataset.checkPanel === mode);
  }
}

function clearImageResult() {
  setVisible(imageResultBox, false);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "Unknown size";
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function base64FromDataUrl(dataUrl) {
  const [, base64 = ""] = String(dataUrl).split(",");
  return base64;
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read image data."));
    reader.readAsDataURL(blob);
  });
}

function sourceLabelFromUrl(imageUrl) {
  if (!imageUrl) {
    return "Uploaded image";
  }

  try {
    return new URL(imageUrl).hostname.replace(/^www\./, "");
  } catch (error) {
    return "Web image";
  }
}

async function setSelectedImageFromBlob(blob, options = {}) {
  const mimeType = String(blob?.type || options.mimeType || "").toLowerCase();

  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    throw new Error("Unsupported image type. Use PNG, JPEG, or WebP.");
  }

  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error("Image is too large. Maximum size is 5 MB.");
  }

  const dataUrl = await readBlobAsDataUrl(blob);
  selectedImage = {
    imageBase64: base64FromDataUrl(dataUrl),
    mimeType,
    imageUrl: options.imageUrl || "",
    previewUrl: dataUrl,
    size: blob.size,
    label: options.label || sourceLabelFromUrl(options.imageUrl),
  };

  imagePreview.src = selectedImage.previewUrl;
  imageDropZone.classList.add("has-preview");
  imageMeta.textContent = `${selectedImage.label} | ${mimeType} | ${formatBytes(blob.size)}`;
  setVisible(imageEmptyState, false);
  setVisible(imagePreviewState, true);
  imageCheckBtn.disabled = false;
  setCheckMode("image");
  setVisible(resultBox, false);
  clearImageResult();
  setResultMode(false);
}

async function setSelectedImageFromFile(file) {
  await setSelectedImageFromBlob(file, {
    label: file.name || "Uploaded image",
    mimeType: file.type,
  });
}

async function setSelectedImageFromUrl(imageUrl) {
  const response = await fetch(imageUrl);

  if (!response.ok) {
    throw new Error(`Could not load image (${response.status}).`);
  }

  const contentType = String(response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const blob = await response.blob();
  const typedBlob = blob.type
    ? blob
    : new Blob([blob], { type: contentType || "application/octet-stream" });

  await setSelectedImageFromBlob(typedBlob, {
    imageUrl,
    mimeType: contentType || typedBlob.type,
    label: sourceLabelFromUrl(imageUrl),
  });
}
function setSourceMode(mode) {
  for (const button of sourceModeButtons) {
    const isTarget = button.dataset.sourceMode === mode;
    button.classList.toggle("active", isTarget);
    button.setAttribute("aria-selected", String(isTarget));
  }

  for (const panel of sourceModePanels) {
    setVisible(panel, panel.dataset.sourcePanel === mode);
  }
}

function setResultMode(hasResult) {
  if (!hasResult) {
    updateAlertsBadge([]);
  }

  dashboardView.classList.toggle("has-result", hasResult);

  for (const element of resultOnlyEls) {
    setVisible(element, hasResult);
  }

  setActiveView("check", { scrollToTop: false });
  setSourceMode("list");
}

function showError(message = "") {
  errorBannerText.textContent = message;
  setVisible(errorBanner, Boolean(message));
}

function setLoading(isLoading, message = "Loading...") {
  loadingBanner.classList.remove("progress-banner");
  loadingBanner.replaceChildren();

  const loader = document.createElement("span");
  loader.className = "loader";
  loader.setAttribute("aria-hidden", "true");

  const text = document.createElement("p");
  text.id = "loading-banner-text";
  text.textContent = message;

  loadingBanner.append(loader, text);
  setVisible(loadingBanner, isLoading);
}

function renderFactCheckProgress(status = "analyzing", mode = "text") {
  const progress = STREAM_STATUS_PROGRESS[status] || STREAM_STATUS_PROGRESS.analyzing;
  const steps =
    mode === "image"
      ? [
          ["analyzing", "Scanning visual layers..."],
          ["searching", "Querying Google Search indexes..."],
          ["forming_verdict", "Generating visual verdict..."],
        ]
      : [
          ["analyzing", "Analyzing text..."],
          ["searching", "Searching Google sources..."],
          ["forming_verdict", "Generating verdict..."],
        ];
  const statusRank = steps.findIndex(([key]) => key === status);

  loadingBanner.classList.add("progress-banner");
  loadingBanner.innerHTML = `
    <div class="progress-card">
      <div class="progress-head">
        <span class="progress-orbit" aria-hidden="true"></span>
        <div class="progress-title">Analysis in<br>Progress</div>
        <div class="progress-percent"><strong>${progress}%</strong><span>Complete</span></div>
      </div>
      <div class="progress-steps">
        ${steps
          .map(([key, label], index) => {
            const state = index < statusRank ? "complete" : index === statusRank ? "active" : "pending";
            return `<div class="progress-step ${state}"><span class="step-icon" aria-hidden="true"></span><span>${label}</span></div>`;
          })
          .join("")}
      </div>
      <div class="progress-track" aria-hidden="true"><span style="width:${progress}%"></span></div>
    </div>
  `;
  setVisible(loadingBanner, true);
}

function setAuthBusy(isBusy, message = "Authenticating...") {
  loginBtn.disabled = isBusy;
  registerBtn.disabled = isBusy;
  googleLoginBtn.disabled = isBusy;
  emailInput.disabled = isBusy;
  passwordInput.disabled = isBusy;
  setLoading(isBusy, message);
}

function setFactCheckBusy(isBusy) {
  factCheckBtn.disabled = isBusy;
  claimText.disabled = isBusy;
  factCheckBtn.innerHTML = isBusy
    ? "<span>Scanning...</span>"
    : '<span>Scan Claim</span><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 12l2 2 4-5M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3z"/></svg>';

  if (isBusy) {
    renderFactCheckProgress("analyzing");
  } else {
    setLoading(false);
  }
}

function setImageCheckBusy(isBusy) {
  imageCheckBtn.disabled = isBusy || !selectedImage;
  imageDropZone.disabled = isBusy;
  imageCheckBtn.innerHTML = isBusy
    ? "<span>Scanning image...</span>"
    : '<span>Scan Image</span><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3z" /><path d="M9 12l2 2 4-5" /></svg>';

  if (isBusy) {
    renderFactCheckProgress("analyzing", "image");
  } else {
    setLoading(false);
  }
}
function setFactCheckStatus(status) {
  renderFactCheckProgress(status, "text");
}

function setImageCheckStatus(status) {
  renderFactCheckProgress(status, "image");
}

function friendlyAuthError(error, fallback) {
  const code = error?.code || "";

  switch (code) {
    case "auth/email-already-in-use":
      return "This email is already registered. Use Sign In instead.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "auth/missing-email":
      return "Enter your email address.";
    case "auth/missing-password":
      return "Enter your password.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/operation-not-allowed":
      return "Email/password sign-up is disabled in Firebase Authentication.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    case "auth/invalid-credential":
      return "Invalid email or password.";
    default:
      return error?.message || fallback;
  }
}

function requireValidAuthForm() {
  if (authForm.reportValidity()) {
    return true;
  }

  showError("Enter a valid email and a password with at least 6 characters.");
  return false;
}
function scoreColor(score) {
  if (score >= 70) return "#21d07a";
  if (score >= 40) return "#ffad42";
  return "#ff6b6b";
}

function confidenceLabel(score) {
  if (score >= 70) return "High Confidence Rating";
  if (score >= 40) return "Moderate Caution";
  return "High Risk Alert";
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
  return cleanDomain.length > 17
    ? `${cleanDomain.slice(0, 14)}...`
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
    .slice(0, 7);

  const fallbackSources = domains.map((domain, index) => ({
    domain,
    weight: deterministicWeight(domain, index),
    isKeyEvidence: index === 0,
  }));

  const averageTrustScore = fallbackSources.length
    ? Math.round(
        fallbackSources.reduce((total, source) => total + source.weight, 0) /
          fallbackSources.length,
      )
    : clampScore(score);

  return {
    title: "SOURCE WEIGHT DISTRIBUTION",
    sources: fallbackSources,
    averageTrustScore,
  };
}

function normalizeChartData(payload, sources, score) {
  const chartData = payload?.chartData;
  const rawSources = Array.isArray(chartData?.sources)
    ? chartData.sources
    : null;

  if (!rawSources || rawSources.length === 0) {
    return fallbackChartData(sources, score);
  }

  const normalizedSources = rawSources
    .map((source, index) => ({
      domain: compactDomain(source?.domain || `source-${index + 1}`),
      weight: clampScore(source?.weight),
      isKeyEvidence: Boolean(source?.isKeyEvidence),
    }))
    .slice(0, 7);

  if (!normalizedSources.some((source) => source.isKeyEvidence)) {
    const strongestSource = normalizedSources.reduce(
      (best, source, index) =>
        source.weight > normalizedSources[best].weight ? index : best,
      0,
    );
    normalizedSources[strongestSource].isKeyEvidence = true;
  }

  const averageTrustScore = Number.isFinite(
    Number(chartData?.averageTrustScore),
  )
    ? clampScore(chartData.averageTrustScore)
    : Math.round(
        normalizedSources.reduce((total, source) => total + source.weight, 0) /
          normalizedSources.length,
      );

  return {
    title:
      typeof chartData?.title === "string" && chartData.title.trim()
        ? chartData.title.trim()
        : "",
    sources: normalizedSources,
    averageTrustScore,
  };
}

function updateScoreGauge(score, color) {
  const circumference = 314;
  const offset = circumference - (circumference * score) / 100;

  scoreRing.style.stroke = color;
  scoreRing.style.strokeDashoffset = String(offset);
}

const ALERT_CONFIG = {
  critical: {
    label: "CRITICAL",
    icon: "!",
    summary: "Immediate Intervention Advised",
  },
  warning: {
    label: "WARNING",
    icon: "?",
    summary: "Context Review Required",
  },
  info: {
    label: "INFO",
    icon: "i",
    summary: "Source Metadata",
  },
};

function normalizeAlerts(payload) {
  const rawAlerts = Array.isArray(payload?.alerts) ? payload.alerts : [];

  return rawAlerts
    .map((alert, index) => {
      if (!alert || typeof alert !== "object") {
        return null;
      }

      const severity = String(alert.severity || "info").toLowerCase();
      const title = typeof alert.title === "string" ? alert.title.trim() : "";
      const description =
        typeof alert.description === "string" ? alert.description.trim() : "";

      if (!ALERT_CONFIG[severity] || !title || !description) {
        return null;
      }

      return {
        id:
          typeof alert.id === "string" && alert.id.trim()
            ? alert.id.trim()
            : `alert_${index + 1}`,
        severity,
        title,
        description,
        details: typeof alert.details === "string" ? alert.details.trim() : "",
        url:
          typeof alert.url === "string" && alert.url.startsWith("http")
            ? alert.url.trim()
            : "",
      };
    })
    .filter(Boolean);
}

function updateAlertsBadge(alerts) {
  if (!alertsBadgeEl) {
    return;
  }

  const count = alerts.length;
  const hasCritical = alerts.some((alert) => alert.severity === "critical");
  const hasWarning = alerts.some((alert) => alert.severity === "warning");
  alertsBadgeEl.classList.toggle("hidden", count === 0);
  alertsBadgeEl.classList.toggle("critical", hasCritical);
  alertsBadgeEl.classList.toggle("warning", !hasCritical && hasWarning);
  alertsBadgeEl.textContent = count > 99 ? "99+" : String(count);
  alertsBadgeEl.setAttribute("aria-label", String(count) + " alerts");
}

function detectAlertLanguage(value) {
  const text = String(value || "");

  if (/[\u0406\u0456\u0404\u0454\u0407\u0457\u0490\u0491]/.test(text)) {
    return "uk";
  }

  const cyrillicCount = (text.match(/[\u0400-\u04ff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;

  return cyrillicCount > latinCount ? "ru" : "en";
}

function emptyAlertsMessage(languageContext) {
  switch (detectAlertLanguage(languageContext)) {
    case "uk":
      return "\u0421\u0438\u0433\u043d\u0430\u043b\u0456\u0432 \u0437\u0430\u0433\u0440\u043e\u0437\u0438 \u043d\u0435 \u0432\u0438\u044f\u0432\u043b\u0435\u043d\u043e. \u0422\u0435\u043a\u0441\u0442 \u0447\u0438\u0441\u0442\u0438\u0439.";
    case "ru":
      return "\u0421\u0438\u0433\u043d\u0430\u043b\u043e\u0432 \u0443\u0433\u0440\u043e\u0437\u044b \u043d\u0435 \u043e\u0431\u043d\u0430\u0440\u0443\u0436\u0435\u043d\u043e. \u0422\u0435\u043a\u0441\u0442 \u0447\u0438\u0441\u0442.";
    default:
      return "No threat signals detected. The text is clean.";
  }
}

function renderAlerts(alerts, languageContext = "") {
  unreadAlerts = [...alerts];
  updateAlertsBadge(unreadAlerts);
  alertsContainerEl.replaceChildren();

  if (alerts.length === 0) {
    alertsSummaryEl.textContent = "No Threat Signals";
    const empty = document.createElement("div");
    empty.className = "alerts-empty-state";
    empty.textContent = emptyAlertsMessage(languageContext);
    alertsContainerEl.append(empty);
    return;
  }

  const criticalCount = alerts.filter(
    (alert) => alert.severity === "critical",
  ).length;
  alertsSummaryEl.textContent = criticalCount
    ? `${criticalCount} Critical / ${alerts.length} Total`
    : `${alerts.length} Context Signals`;

  for (const alert of alerts) {
    const config = ALERT_CONFIG[alert.severity];
    const card = document.createElement("article");
    const header = document.createElement("div");
    const icon = document.createElement("span");
    const body = document.createElement("div");
    const severity = document.createElement("span");
    const title = document.createElement("h4");
    const description = document.createElement("p");
    const toggle = document.createElement("button");
    const details = document.createElement("div");
    const detailsText = document.createElement("p");

    card.className = `alert-card ${alert.severity}`;
    header.className = "alert-card-header";
    icon.className = "alert-icon";
    icon.textContent = config.icon;
    body.className = "alert-card-copy";
    severity.className = "alert-severity";
    severity.textContent = `${config.label} | ${config.summary}`;
    title.textContent = alert.title;
    description.textContent = alert.description;
    toggle.className = "alert-toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "Info";
    details.className = "alert-details";
    details.hidden = true;
    detailsText.textContent = alert.details || alert.description;

    details.append(detailsText);

    if (alert.url) {
      const link = document.createElement("a");
      link.href = alert.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Open counter-evidence";
      details.append(link);
    }

    toggle.addEventListener("click", () => {
      const isExpanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!isExpanded));
      toggle.textContent = isExpanded ? "Info" : "Collapse";
      details.hidden = isExpanded;
      card.classList.toggle("expanded", !isExpanded);
    });

    body.append(severity, title, description);
    header.append(icon, body, toggle);
    card.append(header, details);
    alertsContainerEl.append(card);
  }
}
function normalizeResult(payload) {
  return {
    query: typeof payload?.query === "string" ? payload.query : "",
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
    alerts: normalizeAlerts(payload),
    chartData: null,
  };
}

function renderSourceWeightChart(chartData) {
  const bars = [
    ...chartData.sources,
    {
      domain: "Avg Trust",
      weight: chartData.averageTrustScore,
      isAverageTrust: true,
    },
  ];

  sourceWeightTitleEl.textContent = chartData.title.toUpperCase();
  sourceWeightChartEl.style.setProperty("--bar-count", String(bars.length));
  sourceWeightLabelsEl.style.setProperty("--bar-count", String(bars.length));
  sourceWeightChartEl.replaceChildren();
  sourceWeightLabelsEl.replaceChildren();

  for (const bar of bars) {
    const barEl = document.createElement("span");
    const labelEl = document.createElement("span");
    const weight = clampScore(bar.weight);

    barEl.className = "source-bar";
    barEl.style.setProperty("--bar-height", `${Math.max(6, weight)}%`);
    barEl.dataset.weight = `${Math.round(weight)}%`;

    if (bar.isKeyEvidence) {
      barEl.classList.add("key-evidence");
      labelEl.classList.add("key-evidence-label");
      labelEl.textContent = "Key Evidence";
    } else if (bar.isAverageTrust) {
      barEl.classList.add("average-trust");
      labelEl.classList.add("average-trust-label");
      labelEl.textContent = "Avg Trust";
    } else {
      labelEl.textContent = compactDomain(bar.domain);
    }

    barEl.title = `${bar.domain}: ${Math.round(weight)}% trust weight`;
    sourceWeightChartEl.append(barEl);
    sourceWeightLabelsEl.append(labelEl);
  }
}

function renderResult(payload) {
  const result = normalizeResult(payload);
  result.chartData = normalizeChartData(payload, result.sources, result.score);
  const color = scoreColor(result.score);

  verdictEl.textContent = result.verdict;
  scoreEl.textContent = String(Math.round(result.score));
  updateScoreGauge(result.score, color);
  confidenceChip.textContent = confidenceLabel(result.score);
  confidenceChip.style.color = color;
  confidenceChip.style.borderColor = color;
  sourceCountEl.textContent = String(result.sources.length);
  renderAlerts(
    result.alerts,
    result.query || claimText.value || result.verdict || result.analysis || result.facts,
  );
  analysisEl.textContent = result.analysis;
  factsEl.textContent = result.facts;
  sourcesEl.replaceChildren();
  renderSourceWeightChart(result.chartData);

  if (result.sources.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No sources returned.";
    sourcesEl.append(empty);
  } else {
    for (const source of result.sources) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = source;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = source;
      item.append(link);
      sourcesEl.append(item);
    }
  }

  setVisible(imageResultBox, false);
  setVisible(resultBox, true);
  setResultMode(true);
  setCheckMode("text");
}

function normalizeImageResult(payload) {
  const aiProbability = Number.isFinite(Number(payload?.aiProbability))
    ? Math.max(0, Math.min(100, Number(payload.aiProbability)))
    : 0;

  return {
    query: typeof payload?.query === "string" ? payload.query : "",
    score: Number.isFinite(Number(payload?.score))
      ? Math.max(0, Math.min(100, Number(payload.score)))
      : 0,
    verdict:
      typeof payload?.verdict === "string" ? payload.verdict : "No verdict",
    isAiGenerated:
      typeof payload?.isAiGenerated === "boolean"
        ? payload.isAiGenerated
        : aiProbability >= 50,
    aiProbability,
    aiAnalysis:
      typeof payload?.aiAnalysis === "string"
        ? payload.aiAnalysis
        : "Visual integrity analysis is unavailable.",
    textAnalysis:
      typeof payload?.textAnalysis === "string"
        ? payload.textAnalysis
        : "Text grounding analysis is unavailable.",
    sources: Array.isArray(payload?.sources)
      ? payload.sources.filter(
          (source) => typeof source === "string" && source.startsWith("http"),
        )
      : [],
    alerts: normalizeAlerts(payload),
    chartData: null,
  };
}

function renderSourcesList(sources) {
  sourcesEl.replaceChildren();

  if (sources.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No sources returned.";
    sourcesEl.append(empty);
    return;
  }

  for (const source of sources) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = source;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = source;
    item.append(link);
    sourcesEl.append(item);
  }
}

function renderImageResult(payload) {
  const result = normalizeImageResult(payload);
  result.chartData = normalizeChartData(payload, result.sources, result.score);
  const color = scoreColor(result.score);
  const aiColor = result.aiProbability >= 70 ? "#ff6b6b" : result.aiProbability >= 40 ? "#ffad42" : "#21d07a";

  imageVerdictEl.textContent = result.verdict;
  imageScoreEl.textContent = String(Math.round(result.score));
  imageScoreEl.style.color = color;
  imageAiProbabilityEl.textContent = `${Math.round(result.aiProbability)}%`;
  imageAiProbabilityEl.style.color = aiColor;
  imageAiAnalysisEl.textContent = result.aiAnalysis;
  imageTextAnalysisEl.textContent = result.textAnalysis;

  scoreEl.textContent = String(Math.round(result.score));
  updateScoreGauge(result.score, color);
  confidenceChip.textContent = result.isAiGenerated
    ? "AI Generation Risk Detected"
    : confidenceLabel(result.score);
  confidenceChip.style.color = result.isAiGenerated ? aiColor : color;
  confidenceChip.style.borderColor = result.isAiGenerated ? aiColor : color;
  sourceCountEl.textContent = String(result.sources.length);
  renderAlerts(
    result.alerts,
    result.query || result.verdict || result.textAnalysis || result.aiAnalysis,
  );

  renderSourcesList(result.sources);
  renderSourceWeightChart(result.chartData);
  setVisible(imageResultBox, true);
  setResultMode(true);
  setCheckMode("image");
}
async function storeFreshToken(user) {
  const token = await user.getIdToken(true);
  await chrome.storage.local.set({
    [LEGACY_TOKEN_STORAGE_KEY]: token,
    [TOKEN_STORAGE_KEY]: {
      token,
      backendUrl: CLOUD_FUNCTION_URL,
      email: user.email || "",
      updatedAt: Date.now(),
    },
  });
  return token;
}

async function clearStoredToken() {
  await chrome.storage.local.remove([TOKEN_STORAGE_KEY, LEGACY_TOKEN_STORAGE_KEY]);
}

async function applyPendingClaim() {
  const data = await chrome.storage.local.get(PENDING_CLAIM_STORAGE_KEY);
  const pendingClaim = data[PENDING_CLAIM_STORAGE_KEY];
  const text = String(pendingClaim?.text || "").trim();

  if (!text) {
    return false;
  }

  setCheckMode("text");

  claimText.value = text;
  setVisible(resultBox, false);
  setResultMode(false);
  await chrome.storage.local.remove(PENDING_CLAIM_STORAGE_KEY);
  return Boolean(pendingClaim?.autoSubmit);
}

async function applyPendingImage() {
  const data = await chrome.storage.local.get(PENDING_IMAGE_STORAGE_KEY);
  const pendingImage = data[PENDING_IMAGE_STORAGE_KEY];
  const imageUrl = String(pendingImage?.imageUrl || "").trim();

  if (!imageUrl) {
    return false;
  }

  setCheckMode("image");
  setActiveView("check", { scrollToTop: false });
  setVisible(imageResultBox, false);
  setResultMode(false);
  await chrome.storage.local.remove(PENDING_IMAGE_STORAGE_KEY);
  await setSelectedImageFromUrl(imageUrl);
  return Boolean(pendingImage?.autoSubmit);
}
function parseSseChunk(buffer, onEvent) {
  const events = buffer.split("\n\n");
  const remainder = events.pop() || "";

  for (const eventText of events) {
    const dataLines = eventText
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    if (dataLines.length === 0) {
      continue;
    }

    onEvent(JSON.parse(dataLines.join("\n")));
  }

  return remainder;
}

async function readStreamedFactCheck(response, onStatus) {
  if (!response.body) {
    throw new Error("Streaming is not available.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  let streamError = null;

  const handleEvent = (event) => {
    if (event.status) {
      onStatus?.(event.status);
    }

    if (event.result) {
      result = event.result;
    }

    if (event.error) {
      streamError = event.error;
    }
  };

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseChunk(buffer, handleEvent);
  }

  buffer += decoder.decode();
  parseSseChunk(`${buffer}\n\n`, handleEvent);

  if (streamError) {
    throw new Error(streamError);
  }

  if (!result) {
    throw new Error("The server did not return a final verdict.");
  }

  return result;
}
async function factCheckText(text, onStatus) {
  if (!auth.currentUser) {
    throw new Error("Please sign in before running a fact check.");
  }

  onStatus?.("analyzing");
  const token = await storeFreshToken(auth.currentUser);
  const response = await fetch(CLOUD_FUNCTION_URL, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error("The server returned an invalid response.");
    }

    throw new Error(
      payload?.error || `Fact check failed with status ${response.status}.`,
    );
  }

  return readStreamedFactCheck(response, onStatus);
}

async function factCheckImage(imageInput, onStatus) {
  if (!auth.currentUser) {
    throw new Error("Please sign in before running an image check.");
  }

  if (!imageInput?.imageBase64 || !imageInput?.mimeType) {
    throw new Error("Select an image to scan.");
  }

  onStatus?.("analyzing");
  const token = await storeFreshToken(auth.currentUser);
  const response = await fetch(CLOUD_FUNCTION_URL, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      imageBase64: imageInput.imageBase64,
      mimeType: imageInput.mimeType,
      imageUrl: imageInput.imageUrl || "",
    }),
  });

  if (!response.ok) {
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error("The server returned an invalid response.");
    }

    throw new Error(
      payload?.error || `Image check failed with status ${response.status}.`,
    );
  }

  return readStreamedFactCheck(response, onStatus);
}
onAuthStateChanged(auth, async (user) => {
  setVisible(authView, !user);
  setVisible(dashboardView, Boolean(user));
  setVisible(logoutBtn, Boolean(user));
  setResultMode(false);
  showError();
  setLoading(false);

  if (user) {
    sessionLabel.textContent = user.email || "Signed in";
    try {
      await storeFreshToken(user);
      const shouldAutoSubmitImage = await applyPendingImage();
      if (shouldAutoSubmitImage && !imageCheckBtn.disabled) {
        await submitImageCheck();
        return;
      }

      const shouldAutoSubmit = await applyPendingClaim();
      if (shouldAutoSubmit && !factCheckBtn.disabled) {
        await submitFactCheck();
      }
    } catch (error) {
      showError(error.message || "Could not prepare the pending verification.");
    }
  } else {
    sessionLabel.textContent = "Secure fact-checking";
    await clearStoredToken();
  }
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError();

  if (!requireValidAuthForm()) {
    return;
  }

  setAuthBusy(true, "Signing in securely...");

  try {
    await signInWithEmailAndPassword(
      auth,
      emailInput.value.trim(),
      passwordInput.value,
    );
  } catch (error) {
    showError(friendlyAuthError(error, "Could not sign in."));
  } finally {
    setAuthBusy(false);
  }
});

function clearCachedGoogleTokens() {
  return new Promise((resolve) => {
    chrome.identity.clearAllCachedAuthTokens(() => resolve());
  });
}

function removeCachedGoogleToken(token) {
  return new Promise((resolve) => {
    if (!token) {
      resolve();
      return;
    }

    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function getGoogleAuthToken() {
  await clearCachedGoogleTokens();

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      const lastError = chrome.runtime.lastError;

      if (lastError) {
        reject(new Error(lastError.message || "Google sign-in was cancelled."));
        return;
      }

      if (!token) {
        reject(new Error("Google did not return an auth token."));
        return;
      }

      resolve(token);
    });
  });
}

async function handleGoogleSignIn() {
  showError();
  setAuthBusy(true, "Opening Google sign-in...");

  try {
    const googleToken = await getGoogleAuthToken();
    const credential = GoogleAuthProvider.credential(null, googleToken);
    await signInWithCredential(auth, credential);
    await removeCachedGoogleToken(googleToken);
  } catch (error) {
    showError(error.message || "Could not sign in with Google.");
  } finally {
    setAuthBusy(false);
  }
}

googleLoginBtn.addEventListener("click", handleGoogleSignIn);
registerBtn.addEventListener("click", async () => {
  showError();

  if (!requireValidAuthForm()) {
    return;
  }

  setAuthBusy(true, "Creating your account...");

  try {
    await createUserWithEmailAndPassword(
      auth,
      emailInput.value.trim(),
      passwordInput.value,
    );
  } catch (error) {
    showError(friendlyAuthError(error, "Could not create account."));
  } finally {
    setAuthBusy(false);
  }
});

async function handleSignOut() {
  showError();
  setLoading(true, "Signing out...");

  try {
    await signOut(auth);
    await clearStoredToken();
  } catch (error) {
    showError(error.message || "Could not sign out.");
  } finally {
    setLoading(false);
  }
}

logoutBtn.addEventListener("click", handleSignOut);

async function submitImageCheck() {
  showError();
  setVisible(imageResultBox, false);
  setVisible(resultBox, false);
  setResultMode(false);
  setCheckMode("image");

  if (!selectedImage) {
    showError("Select an image to scan.");
    return;
  }

  setImageCheckBusy(true);

  try {
    const result = await factCheckImage(selectedImage, setImageCheckStatus);
    renderImageResult(result);
  } catch (error) {
    showError(error.message || "Image verification failed. Try again.");
  } finally {
    setImageCheckBusy(false);
  }
}

async function handleImageFile(file) {
  showError();
  setCheckMode("image");

  try {
    await setSelectedImageFromFile(file);
  } catch (error) {
    showError(error.message || "Could not load image.");
  }
}
async function submitFactCheck() {
  const text = claimText.value.trim();

  showError();
  setCheckMode("text");
  setVisible(resultBox, false);
  setVisible(imageResultBox, false);
  setResultMode(false);

  if (!text) {
    showError("Enter text to analyze.");
    return;
  }

  setFactCheckBusy(true);

  try {
    const result = await factCheckText(text, setFactCheckStatus);
    renderResult(result);
  } catch (error) {
    showError(error.message || "Network failure. Try again.");
  } finally {
    setFactCheckBusy(false);
  }
}

factCheckBtn.addEventListener("click", submitFactCheck);
imageCheckBtn.addEventListener("click", submitImageCheck);
imageDropZone.addEventListener("click", () => imageFileInput.click());
imageFileInput.addEventListener("change", () => {
  const [file] = imageFileInput.files || [];

  if (file) {
    handleImageFile(file);
  }

  imageFileInput.value = "";
});

imageDropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  imageDropZone.classList.add("drag-over");
});

imageDropZone.addEventListener("dragleave", () => {
  imageDropZone.classList.remove("drag-over");
});

imageDropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  imageDropZone.classList.remove("drag-over");
  const [file] = event.dataTransfer?.files || [];

  if (file) {
    handleImageFile(file);
  }
});

for (const button of checkModeButtons) {
  button.addEventListener("click", () => {
    setCheckMode(button.dataset.checkMode);
    showError();
  });
}

for (const button of navButtons) {
  button.addEventListener("click", () => setActiveView(button.dataset.navView));
}

for (const button of sourceModeButtons) {
  button.addEventListener("click", () =>
    setSourceMode(button.dataset.sourceMode),
  );
}

claimText.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }

  event.preventDefault();

  if (!factCheckBtn.disabled) {
    submitFactCheck();
  }
});
