import { initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

const CLOUD_FUNCTION_URL =
  "https://us-central1-veritas-c2907.cloudfunctions.net/factCheck";
const TOKEN_STORAGE_KEY = "veritasAuth";
const PENDING_CLAIM_STORAGE_KEY = "veritasPendingClaim";
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
const riskCountEl = document.querySelector("#risk-count");
const analysisEl = document.querySelector("#analysis");
const factsEl = document.querySelector("#facts");
const sourcesEl = document.querySelector("#sources");
const sourceWeightTitleEl = document.querySelector("#source-weight-title");
const sourceWeightChartEl = document.querySelector("#source-weight-chart");
const sourceWeightLabelsEl = document.querySelector("#source-weight-labels");
const dashboardPanes = document.querySelectorAll("[data-view]");
const navButtons = document.querySelectorAll("[data-nav-view]");
const sourceModeButtons = document.querySelectorAll("[data-source-mode]");
const sourceModePanels = document.querySelectorAll("[data-source-panel]");
const resultOnlyEls = document.querySelectorAll(".result-only");

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

  if (options.scrollToTop !== false) {
    appShell.scrollTo({ top: 0, behavior: "smooth" });
  }
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

function renderFactCheckProgress(status = "analyzing") {
  const progress = STREAM_STATUS_PROGRESS[status] || STREAM_STATUS_PROGRESS.analyzing;
  const steps = [
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

function setFactCheckStatus(status) {
  renderFactCheckProgress(status);
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

function riskCount(score) {
  return Math.max(1, Math.ceil((100 - score) / 10));
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
  riskCountEl.textContent = String(riskCount(result.score));
  riskCountEl.style.color = color;
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

  setVisible(resultBox, true);
  setResultMode(true);
}

async function storeFreshToken(user) {
  const token = await user.getIdToken(true);
  await chrome.storage.local.set({
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
  await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
}

async function applyPendingClaim() {
  const data = await chrome.storage.local.get(PENDING_CLAIM_STORAGE_KEY);
  const pendingClaim = data[PENDING_CLAIM_STORAGE_KEY];
  const text = String(pendingClaim?.text || "").trim();

  if (!text) {
    return false;
  }

  claimText.value = text;
  setVisible(resultBox, false);
  setResultMode(false);
  await chrome.storage.local.remove(PENDING_CLAIM_STORAGE_KEY);
  return Boolean(pendingClaim?.autoSubmit);
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
      const shouldAutoSubmit = await applyPendingClaim();
      if (shouldAutoSubmit && !factCheckBtn.disabled) {
        await submitFactCheck();
      }
    } catch (error) {
      showError("Could not refresh your session token. Please sign in again.");
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

async function submitFactCheck() {
  const text = claimText.value.trim();

  showError();
  setVisible(resultBox, false);
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
