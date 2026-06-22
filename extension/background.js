const DEFAULT_BACKEND_URL = "https://us-central1-veritas-c2907.cloudfunctions.net/factCheck";
const TOKEN_STORAGE_KEY = "veritasAuth";
const PENDING_CLAIM_STORAGE_KEY = "veritasPendingClaim";
const MENU_ID = "veritas-check-text";
const POPUP_WIDTH = 560;
const POPUP_HEIGHT = 760;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Check with Veritas AI",
      contexts: ["selection"],
    });
  });
});

async function getAuthContext() {
  const data = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  const authContext = data[TOKEN_STORAGE_KEY] || {};

  return {
    token: authContext.token || null,
    backendUrl: authContext.backendUrl || DEFAULT_BACKEND_URL,
  };
}

async function openVeritasPopup() {
  if (chrome.action?.openPopup) {
    try {
      await chrome.action.openPopup();
      return;
    } catch (error) {
      console.warn("Could not open the toolbar popup. Falling back to popup window.", error);
    }
  }

  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup",
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      focused: true,
    });
  } catch (error) {
    console.warn("Could not open Veritas AI popup window.", error);
  }
}

async function runFactCheck(text) {
  const selectedText = String(text || "").trim();

  if (!selectedText) {
    throw new Error("No selected text was received.");
  }

  const { token, backendUrl } = await getAuthContext();

  if (!token) {
    await openVeritasPopup();
    throw new Error("Please log in via the Veritas AI popup first.");
  }

  const response = await fetch(backendUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: selectedText }),
  });

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("The backend returned an invalid JSON response.");
  }

  if (!response.ok) {
    if (response.status === 401) {
      await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
      await openVeritasPopup();
      throw new Error("Your session expired. Open Veritas AI and sign in again.");
    }

    throw new Error(payload?.error || `Fact check failed with status ${response.status}.`);
  }

  return payload;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText || !tab?.id) {
    return;
  }

  const selectedText = String(info.selectionText || "").trim();

  chrome.storage.local
    .set({
      [PENDING_CLAIM_STORAGE_KEY]: {
        text: selectedText,
        autoSubmit: true,
        updatedAt: Date.now(),
      },
    })
    .then(() => openVeritasPopup())
    .finally(() => {
      chrome.tabs.sendMessage(tab.id, {
        type: "VERITAS_SELECTION_RECEIVED",
        text: selectedText,
      });
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "VERITAS_RUN_FACT_CHECK") {
    return false;
  }

  runFactCheck(message.text)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "Fact check failed." }));

  return true;
});
