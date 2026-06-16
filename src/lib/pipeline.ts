import { CaptureError } from './media/resolver.js';
import { treeToJson, wrapForClipboard } from './encoding.js';
import { captureDOM } from './core/snapshot.js';
import type { SubmitResult } from './types.js';

const LOG_PREFIX = '[H2D Capture]';
const SUBMIT_TIMEOUT = 60000;

const ERROR_MESSAGES: Record<string, string> = {
  CAPTURE_EXPIRED: 'Capture expired. Please start a new capture.',
  CAPTURE_NOT_FOUND: 'Capture not found. Please start a new capture.',
  ACCESS_DENIED: 'Access denied. Please try again.',
  CAPTURE_ID_ALREADY_SUBMITTED: 'Capture already submitted. Please start a new capture.',
  PAGE_NOT_RESPONDING: 'Capture timed out. Try keeping this tab in the foreground.',
  VIDEO_TIMEOUT: 'Request timed out. Please try again.',
};

export const logger = {
  verbose: false,
  log: (...args: unknown[]): void => {
    if (logger.verbose) console.log(LOG_PREFIX, ...args);
  },
  error: (...args: unknown[]): void => {
    if (logger.verbose) console.error(LOG_PREFIX, ...args);
  },
};

/**
 * Waits for the DOM to finish loading if it has not already.
 */
async function waitForDOMReady(): Promise<void> {
  if (document.readyState === 'loading') {
    logger.log('Waiting for DOM to be ready...');
    await new Promise<void>((resolve) =>
      document.addEventListener('DOMContentLoaded', () => resolve())
    );
  }
}

/**
 * Creates an AbortSignal that respects page visibility.
 * The timeout pauses while the tab is hidden and resumes when visible again.
 */
function createVisibilityAwareSignal(timeout: number): AbortSignal {
  const controller = new AbortController();
  let remaining = timeout;
  let visibleSince: number | null = document.hidden ? null : Date.now();
  let timer: ReturnType<typeof setTimeout> | null = visibleSince ? scheduleAbort() : null;

  function cleanup(): void {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleAbort(): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      cleanup();
      controller.abort();
    }, remaining);
  }

  function onVisibilityChange(): void {
    if (document.hidden) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        remaining -= Date.now() - (visibleSince ?? Date.now());
        visibleSince = null;
      }
    } else {
      if (timer === null && remaining > 0) {
        visibleSince = Date.now();
        timer = scheduleAbort();
      }
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  controller.signal.addEventListener('abort', cleanup, { once: true });

  return controller.signal;
}

/**
 * Full capture pipeline: wait for DOM, serialize the target element, and
 * convert the result to a JSON payload string.
 */
export async function capturePage(selector: string = 'body'): Promise<string> {
  await waitForDOMReady();

  const root =
    selector === 'body' || selector === 'html'
      ? document
      : document.querySelector(selector);

  if (!root) throw new Error(`Element not found: ${selector}`);

  logger.log('Serializing DOM...');

  let tree;
  try {
    const timeoutSignal = createVisibilityAwareSignal(10000);
    tree = await captureDOM(root, { timeoutSignal });
  } catch (err) {
    if (err instanceof CaptureError) {
      throw new Error(ERROR_MESSAGES[err.code] || err.message);
    }
    throw err;
  }

  logger.log('Converting to JSON...');
  const json = await treeToJson(tree);
  const sizeKB = Math.round(json.length / 1024);
  logger.log(`Payload size: ${sizeKB} KB`);

  return json;
}

/**
 * POSTs a captured JSON payload to the Figma submit endpoint.
 * Returns `{ claimUrl, nextCaptureId }` on success.
 */
export async function submitCapture(json: string, captureId: string, endpoint: string, captureIndex: number = 0): Promise<SubmitResult> {
  logger.log('Sending captures to Figma...');
  const sizeKB = Math.round(json.length / 1024);
  logger.log(`Sending capture, total size: ${sizeKB} KB`);

  const url = endpoint.replace(
    /\/capture\/[^/]+\/submit/,
    `/capture/${captureId}/submit`
  );

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), SUBMIT_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        captureId,
        payload: json,
        captureIndex,
      }),
      signal: abortController.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      let message: string;

      try {
        const body = await response.json();
        if (body.errorCode) {
          message = ERROR_MESSAGES[body.errorCode] || body.errorCode;
        } else {
          message = body.error || response.statusText;
        }
      } catch (_parseErr) {
        message = await response.text().catch(() => response.statusText);
      }

      logger.error(`Server error (${response.status}): ${message}`);
      throw new Error(message);
    }

    const data = await response.json();
    if (data.error) {
      logger.error('Capture failed:', data.error);
      throw new Error(data.error);
    }

    logger.log('Success! Page has been captured and sent to Figma.');
    const claimUrl = data.claimUrl || data.fileUrl;
    if (claimUrl) logger.log(`Open your file: ${claimUrl}`);

    return { claimUrl, nextCaptureId: data.nextCaptureId };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${SUBMIT_TIMEOUT / 1000} seconds`);
    }
    throw err;
  }
}

/**
 * Waits until the document has focus (needed before clipboard operations).
 */
async function waitForFocus(): Promise<void> {
  if (!document.hasFocus()) {
    logger.log('Document not focused, waiting for focus...');
    await new Promise<void>((resolve) => {
      window.addEventListener('focus', () => resolve(), { once: true });
    });
    logger.log('Document focused, proceeding with clipboard copy');
  }
}

/**
 * Writes a captured JSON payload to the clipboard as an HTML blob
 * (or plain text if `window.figma.useHtmlClipboardEncoding` is false).
 */
export async function writeToClipboard(json: string): Promise<void> {
  if (window.figma?.useHtmlClipboardEncoding !== false) {
    const html = await wrapForClipboard(json);
    await waitForFocus();
    if (typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function") {
      const item = new ClipboardItem({ 'text/html': html });
      await navigator.clipboard.write([item]);
    } else {
      await copyHtmlWithExecCommand(await html.text(), json);
    }
  } else {
    await waitForFocus();
    await navigator.clipboard.writeText(json);
  }
}

async function copyHtmlWithExecCommand(html: string, plainText: string): Promise<void> {
  await waitForFocus();

  const marker = document.createElement("span");
  marker.style.position = "fixed";
  marker.style.left = "-9999px";
  marker.style.top = "0";
  marker.style.width = "1px";
  marker.style.height = "1px";
  marker.setAttribute("aria-hidden", "true");
  marker.textContent = "H2D Capture clipboard payload";

  const selection = window.getSelection();
  const previousRanges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      previousRanges.push(selection.getRangeAt(index).cloneRange());
    }
  }

  const onCopy = (event: ClipboardEvent): void => {
    event.preventDefault();
    event.clipboardData?.setData("text/html", html);
    event.clipboardData?.setData("text/plain", plainText);
  };

  try {
    document.body.appendChild(marker);
    const range = document.createRange();
    range.selectNodeContents(marker);
    selection?.removeAllRanges();
    selection?.addRange(range);

    document.addEventListener("copy", onCopy, true);
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("document.execCommand('copy') returned false");
    }
  } catch (err) {
    throw new Error(
      `ClipboardItem is not available in this page, and the fallback copy path failed: ${
        (err as Error).message || String(err)
      }`,
    );
  } finally {
    document.removeEventListener("copy", onCopy, true);
    marker.remove();
    if (selection) {
      selection.removeAllRanges();
      for (const range of previousRanges) selection.addRange(range);
    }
  }
}
