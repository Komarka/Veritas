const CLOUD_FUNCTION_URL = "https://us-central1-veritas-c2907.cloudfunctions.net/factCheck";
const TOKEN_STORAGE_KEY = "veritasAuth";
const MENU_ID = "veritas-check";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Check text with Veritas AI",
    contexts: ["selection"],
  });
});

async function getStoredToken() {
  const data = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  return data[TOKEN_STORAGE_KEY]?.token || null;
}

async function runFactCheck(text) {
  const token = await getStoredToken();

  if (!token) {
    throw new Error("Open Veritas AI and sign in before using context-menu checks.");
  }

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
    throw new Error("The server returned an invalid JSON response.");
  }

  if (!response.ok) {
    if (response.status === 401) {
      await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
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

  chrome.tabs.sendMessage(tab.id, {
    type: "VERITAS_SELECTION_RECEIVED",
    text: info.selectionText,
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "VERITAS_RUN_FACT_CHECK") {
    return false;
  }

  runFactCheck(String(message.text || ""))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "Fact check failed." }));

  return true;
});
