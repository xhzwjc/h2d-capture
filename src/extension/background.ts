const isFirefox =
  typeof browser !== "undefined" &&
  typeof browser.runtime !== "undefined" &&
  typeof (browser.runtime as unknown as Record<string, unknown>).getBrowserInfo === "function";
const api = typeof browser !== "undefined" ? browser : chrome;

const FRAME_CONTEXT_MENU_ID = "h2d-open-toolbar-in-frame";

api.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  // Check for unsupported pages (chrome://, file:// without permission, etc.)
  const url = tab.url || "";
  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("moz-extension://")
  ) {
    // Can't inject into browser internal pages
    return;
  }

  if (url.startsWith("file://")) {
    // chrome.extension.isAllowedFileSchemeAccess is Chrome-only
    if (!isFirefox) {
      const hasFileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      if (!hasFileAccess) {
        await api.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            alert(
              "H2D Capture: To use on local files, enable \"Allow access to file URLs\" in extension settings.\n\n" +
              "Go to chrome://extensions → H2D Capture → Details → toggle \"Allow access to file URLs\"",
            );
          },
        }).catch(() => {
          // Even the alert might fail — nothing we can do
        });
        return;
      }
    }
  }

  try {
    await injectIntoTargetFrame(tab.id);
  } catch (e) {
    console.error("H2D Capture: cannot inject on this page", e);
  }
});

if (!isFirefox) {
  api.runtime.onInstalled.addListener(() => {
    api.contextMenus.create(
      {
        id: FRAME_CONTEXT_MENU_ID,
        title: "H2D Capture: Open toolbar in this frame",
        contexts: ["frame"],
      },
      () => {
        if (chrome.runtime.lastError) {
          console.debug("H2D Capture: context menu setup skipped", chrome.runtime.lastError.message);
        }
      },
    );
  });

  api.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== FRAME_CONTEXT_MENU_ID) return;

    if (!tab?.id) {
      console.error("H2D Capture: cannot inject into frame because tab id is missing", { info });
      return;
    }

    if (typeof info.frameId !== "number") {
      console.error("H2D Capture: cannot inject into frame because frameId is missing", { info });
      return;
    }

    if (isUnsupportedUrl(info.frameUrl || "")) {
      console.error("H2D Capture: cannot inject into unsupported frame URL", {
        frameUrl: info.frameUrl,
        frameId: info.frameId,
      });
      return;
    }

    try {
      await injectIntoTargetFrame(tab.id, info.frameId);
    } catch (e) {
      // Chrome frame injection may require explicit host_permissions for the
      // iframe origin, even when the parent page is accessible via activeTab.
      console.error(
        "H2D Capture: cannot inject toolbar into this frame. Check manifest host_permissions for the iframe origin.",
        {
          tabId: tab.id,
          frameId: info.frameId,
          frameUrl: info.frameUrl,
          error: e,
        },
      );
    }
  });
}

function isUnsupportedUrl(url: string): boolean {
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("moz-extension://")
  );
}

async function injectIntoTargetFrame(tabId: number, frameId?: number): Promise<void> {
  const target = frameId == null ? { tabId } : { tabId, frameIds: [frameId] };

  // Inject the CORS-bypass bridge into the ISOLATED world first,
  // so the content script can relay fetch requests from MAIN world.
  // ISOLATED is the default world — omitting `world` works on both browsers.
  await api.scripting.executeScript({
    target,
    func: installCorsBridge,
  });

  if (isFirefox) {
    // Firefox: inject injector.js (ISOLATED world) which creates <script>
    // tags to load capture.js + toolbar.js into MAIN world.
    await api.scripting.executeScript({
      target,
      files: ["injector.js"],
    });
    return;
  }

  // Chrome: direct MAIN world injection
  await api.scripting.executeScript({
    target,
    world: "MAIN" as chrome.scripting.ExecutionWorld,
    files: ["capture.js"],
  });

  await api.scripting.executeScript({
    target,
    world: "MAIN" as chrome.scripting.ExecutionWorld,
    files: ["toolbar.js"],
  });
}

// ---------------------------------------------------------------------------
// Cross-origin image fetch (background has no CORS limits)
// ---------------------------------------------------------------------------

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "figma-capture-fetch-image") {
    fetchImageAsBase64(message.url)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }

  if (message.type === "figma-capture-visible-tab") {
    captureVisibleTabAsBase64(_sender.tab?.windowId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }

  return false;
});

/**
 * Fetch an image URL from the background (no CORS restrictions) and return
 * it as a base64 data URL.
 */
async function fetchImageAsBase64(url: string): Promise<{ dataUrl: string } | { error: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const dataUrl = `data:${blob.type || "image/png"};base64,${base64}`;
    return { dataUrl };
  } catch (err) {
    return { error: String(err) };
  }
}

async function captureVisibleTabAsBase64(windowId?: number): Promise<{ dataUrl: string } | { error: string }> {
  if (isFirefox || typeof chrome === "undefined" || !chrome.tabs?.captureVisibleTab) {
    return { error: "captureVisibleTab is only available in Chrome extension context" };
  }

  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: "png" }, (dataUrl) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve({ error: lastError.message ?? "captureVisibleTab failed" });
        return;
      }

      const capturedDataUrl = dataUrl ?? "";
      if (!capturedDataUrl) {
        resolve({ error: "captureVisibleTab returned an empty image" });
        return;
      }

      resolve({ dataUrl: capturedDataUrl });
    });
  });
}

// ---------------------------------------------------------------------------
// CORS bridge (injected into ISOLATED world of the content page)
// ---------------------------------------------------------------------------

/**
 * This function runs in the ISOLATED content script world. It listens for
 * custom events from the MAIN world (where capture.js runs) and relays
 * them to the background via chrome.runtime.sendMessage.
 *
 * Flow: MAIN world → CustomEvent → ISOLATED world → chrome.runtime.sendMessage → background fetch
 */
function installCorsBridge(): void {
  if ((window as unknown as Record<string, boolean>).__figmaCorsBridge) return;
  (window as unknown as Record<string, boolean>).__figmaCorsBridge = true;

  // Use whichever API is available (Firefox: browser.*, Chrome: chrome.*)
  const rt = typeof browser !== "undefined" ? browser.runtime : chrome.runtime;

  // CORS image fetch bridge
  window.addEventListener("figma-capture-fetch", async (event) => {
    const detail = (event as CustomEvent).detail;
    if (!detail?.url || !detail?.callbackId) return;

    try {
      const result = await rt.sendMessage({
        type: "figma-capture-fetch-image",
        url: detail.url,
      });

      window.dispatchEvent(
        new CustomEvent("figma-capture-fetch-result", {
          detail: { callbackId: detail.callbackId, result },
        }),
      );
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent("figma-capture-fetch-result", {
          detail: {
            callbackId: detail.callbackId,
            result: { error: String(err) },
          },
        }),
      );
    }
  });

  window.addEventListener("figma-capture-visible-tab", async (event) => {
    const detail = (event as CustomEvent).detail;
    if (!detail?.callbackId) return;

    try {
      const result = await rt.sendMessage({
        type: "figma-capture-visible-tab",
      });

      window.dispatchEvent(
        new CustomEvent("figma-capture-visible-tab-result", {
          detail: { callbackId: detail.callbackId, result },
        }),
      );
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent("figma-capture-visible-tab-result", {
          detail: {
            callbackId: detail.callbackId,
            result: { error: String(err) },
          },
        }),
      );
    }
  });

}
