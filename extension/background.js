const DEFAULT_BACKEND_URL =
  "https://us-central1-veritas-c2907.cloudfunctions.net/factCheck";
const TOKEN_STORAGE_KEY = "veritasAuth";
const LEGACY_TOKEN_STORAGE_KEY = "veritas_token";
const PENDING_CLAIM_STORAGE_KEY = "veritasPendingClaim";
const PENDING_IMAGE_STORAGE_KEY = "veritasPendingImage";
const TEXT_MENU_ID = "veritas-check-text";
const IMAGE_MENU_ID = "veritas-check-image";
const POPUP_WIDTH = 560;
const POPUP_HEIGHT = 760;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: TEXT_MENU_ID,
      title: "Check with Veritas AI",
      contexts: ["selection"],
    });

    chrome.contextMenus.create({
      id: IMAGE_MENU_ID,
      title: "Check image with Veritas AI",
      contexts: ["image"],
    });
  });
});
async function getAuthContext() {
  const data = await chrome.storage.local.get([
    TOKEN_STORAGE_KEY,
    LEGACY_TOKEN_STORAGE_KEY,
  ]);
  const authContext = data[TOKEN_STORAGE_KEY] || {};

  return {
    token: authContext.token || data[LEGACY_TOKEN_STORAGE_KEY] || null,
    backendUrl: authContext.backendUrl || DEFAULT_BACKEND_URL,
  };
}

async function openVeritasPopup() {
  if (chrome.action?.openPopup) {
    try {
      await chrome.action.openPopup();
      return;
    } catch (error) {
      console.warn(
        "Could not open the toolbar popup. Falling back to popup window.",
        error,
      );
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

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error("The backend returned an invalid JSON response.");
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

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    if (response.status === 401) {
      await chrome.storage.local.remove([TOKEN_STORAGE_KEY, LEGACY_TOKEN_STORAGE_KEY]);
      await openVeritasPopup();
      throw new Error(
        "Your session expired. Open Veritas AI and sign in again.",
      );
    }

    throw new Error(
      payload?.error || `Fact check failed with status ${response.status}.`,
    );
  }

  return payload;
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

    try {
      onEvent(JSON.parse(dataLines.join("\n")));
    } catch (error) {
      onEvent({ error: "Invalid stream event received." });
    }
  }

  return remainder;
}

async function streamFactCheck(text, port) {
  const selectedText = String(text || "").trim();

  if (!selectedText) {
    port.postMessage({
      type: "VERITAS_STREAM_ERROR",
      error: "No selected text was received.",
    });
    return;
  }

  const { token, backendUrl } = await getAuthContext();

  if (!token) {
    await openVeritasPopup();
    port.postMessage({
      type: "VERITAS_STREAM_ERROR",
      error: "Please log in via the Veritas AI popup first.",
    });
    return;
  }

  const response = await fetch(backendUrl, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: selectedText }),
  });

  if (!response.ok) {
    const payload = await readJsonResponse(response);

    if (response.status === 401) {
      await chrome.storage.local.remove([TOKEN_STORAGE_KEY, LEGACY_TOKEN_STORAGE_KEY]);
      await openVeritasPopup();
      port.postMessage({
        type: "VERITAS_STREAM_ERROR",
        error: "Your session expired. Open Veritas AI and sign in again.",
      });
      return;
    }

    port.postMessage({
      type: "VERITAS_STREAM_ERROR",
      error:
        payload?.error || `Fact check failed with status ${response.status}.`,
    });
    return;
  }

  if (!response.body) {
    port.postMessage({
      type: "VERITAS_STREAM_ERROR",
      error: "Streaming is not available.",
    });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseChunk(buffer, (event) => {
      if (event.status) {
        port.postMessage({
          type: "VERITAS_STREAM_STATUS",
          status: event.status,
        });
      }

      if (event.result) {
        port.postMessage({
          type: "VERITAS_STREAM_RESULT",
          result: event.result,
        });
      }

      if (event.error) {
        port.postMessage({ type: "VERITAS_STREAM_ERROR", error: event.error });
      }
    });
  }

  buffer += decoder.decode();
  parseSseChunk(`${buffer}\n\n`, (event) => {
    if (event.status) {
      port.postMessage({ type: "VERITAS_STREAM_STATUS", status: event.status });
    }

    if (event.result) {
      port.postMessage({ type: "VERITAS_STREAM_RESULT", result: event.result });
    }

    if (event.error) {
      port.postMessage({ type: "VERITAS_STREAM_ERROR", error: event.error });
    }
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === TEXT_MENU_ID && info.selectionText && tab?.id) {
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
    return;
  }

  if (info.menuItemId === IMAGE_MENU_ID && info.srcUrl) {
    chrome.storage.local
      .set({
        [PENDING_IMAGE_STORAGE_KEY]: {
          imageUrl: info.srcUrl,
          autoSubmit: true,
          updatedAt: Date.now(),
        },
      })
      .then(() => openVeritasPopup());
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "VERITAS_RUN_FACT_CHECK") {
    return false;
  }

  runFactCheck(message.text)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) =>
      sendResponse({ ok: false, error: error.message || "Fact check failed." }),
    );

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "veritas-fact-check-stream") {
    return;
  }

  port.onMessage.addListener((message) => {
    if (message?.type !== "VERITAS_STREAM_FACT_CHECK") {
      return;
    }

    streamFactCheck(message.text, port).catch((error) => {
      port.postMessage({
        type: "VERITAS_STREAM_ERROR",
        error: error.message || "Verification error",
      });
    });
  });
});
