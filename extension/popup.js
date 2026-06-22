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
const resultOnlyEls = document.querySelectorAll(".result-only");

function setVisible(element, isVisible) {
  element.classList.toggle("hidden", !isVisible);
}

function setResultMode(hasResult) {
  dashboardView.classList.toggle("has-result", hasResult);

  for (const element of resultOnlyEls) {
    setVisible(element, hasResult);
  }
}

function showError(message = "") {
  errorBannerText.textContent = message;
  setVisible(errorBanner, Boolean(message));
}

function setLoading(isLoading, message = "Loading...") {
  loadingBannerText.textContent = message;
  setVisible(loadingBanner, isLoading);
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
    : "<span>Scan Claim</span><svg class=\"btn-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M9 12l2 2 4-5M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3z\"/></svg>";
  setLoading(isBusy, "Veritas AI is scanning the web...");
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
      typeof payload?.facts === "string" ? payload.facts : "Facts are unavailable.",
    sources: Array.isArray(payload?.sources)
      ? payload.sources.filter(
          (source) => typeof source === "string" && source.startsWith("http"),
        )
      : [],
  };
}

function renderResult(payload) {
  const result = normalizeResult(payload);
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

async function factCheckText(text) {
  if (!auth.currentUser) {
    throw new Error("Please sign in before running a fact check.");
  }

  const token = await storeFreshToken(auth.currentUser);
  const response = await fetch(CLOUD_FUNCTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("The server returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(
      payload?.error || `Fact check failed with status ${response.status}.`,
    );
  }

  return payload;
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
    const result = await factCheckText(text);
    renderResult(result);
  } catch (error) {
    showError(error.message || "Network failure. Try again.");
  } finally {
    setFactCheckBusy(false);
  }
}

factCheckBtn.addEventListener("click", submitFactCheck);

claimText.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }

  event.preventDefault();

  if (!factCheckBtn.disabled) {
    submitFactCheck();
  }
});
