/**
 * Asset collection utilities for images, videos, and canvases.
 *
 * Handles fetching, converting, and cataloguing visual assets
 * encountered during DOM capture.
 */

import type { AssetEntry, AssetCollectorOptions } from '../types.js';
import { getNodeDocument, isInstanceOfOwner } from '../core/dom.js';
import type { Rect } from '../types.js';

/** Image MIME types that browsers may decode but Figma cannot consume directly. */
const UNSUPPORTED_IMAGE_TYPES = new Set(["image/avif", "image/heif", "image/heic"]);

/** Cache: once the extension bridge times out, skip it for all subsequent images. */
let bridgeUnavailable = false;

// ---------------------------------------------------------------------------
// CaptureError
// ---------------------------------------------------------------------------

/**
 * Custom error with an associated machine-readable code.
 */
export class CaptureError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = "CaptureError";
  }
}

// ---------------------------------------------------------------------------
// ResourceResolver
// ---------------------------------------------------------------------------

/**
 * Accumulates promises that resolve to `{ url, blob, error? }` entries.
 *
 * Each unique URL is fetched at most once.  After the capture walk is
 * complete, call getBlobMap to await every outstanding fetch and
 * obtain a `Map<string, AssetEntry>`.
 */
export class ResourceResolver {
  promises = new Map<string, Promise<AssetEntry>>();

  /** Auto-incrementing counter used to mint `rasterized:N` pseudo-URLs. */
  rasterizedId = 0;

  options: AssetCollectorOptions;

  constructor(options: AssetCollectorOptions) {
    this.options = options;
  }

  /**
   * Register an in-flight promise under `url`.
   *
   * If the promise rejects the rejection is caught and turned into
   * `{ url, blob: null, error }` so that `getBlobMap` never throws.
   */
  addPromise(url: string, promise: Promise<AssetEntry>): void {
    this.promises.set(
      url,
      promise.catch((error: unknown) => ({
        url,
        blob: null,
        error: String(error),
      })),
    );
  }

  /**
   * Enqueue an image URL for fetching.
   *
   * Duplicate URLs and empty strings are silently ignored.  When
   * `skipRemoteAssetSerialization` is set and the URL points to a
   * remote host, the blob is skipped (only the URL is recorded).
   *
   * If a source `<img>` element is provided, it will be used for direct
   * canvas rasterization — bypassing CORS entirely since the browser has
   * already loaded and decoded the image.
   */
  addImage(url: string, sourceElement?: HTMLImageElement): void {
    if (!url || this.promises.has(url)) return;

    const promise =
      this.options.skipRemoteAssetSerialization && isRemoteUrl(url)
        ? Promise.resolve({ url, blob: null })
        : fetchImageAsBlob(url, sourceElement);

    this.addPromise(url, promise);
  }

  /**
   * Rasterize a `<canvas>` element to PNG and register it under a
   * synthetic `rasterized:N` URL.
   */
  addCanvas(canvas: HTMLCanvasElement): string {
    const url = this.getRasterizedImageUrl();
    const promise = canvasToBlob(canvas).then((blob) => ({ url, blob }));
    this.addPromise(url, promise);
    return url;
  }

  /**
   * Capture and crop the currently visible browser viewport.
   *
   * This is a last-resort fallback for large iframe/document preview regions
   * whose DOM is empty or inaccessible even though the browser visibly renders
   * them. The crop rect is expressed in top-level viewport CSS pixels.
   */
  addViewportCrop(rect: Rect): string {
    const url = this.getRasterizedImageUrl();
    const promise = captureViewportCrop(rect).then((blob) => ({ url, blob }));
    this.addPromise(url, promise);
    return url;
  }

  /**
   * Capture the current frame of a `<video>` element.
   */
  addVideo(video: HTMLVideoElement): void {
    const currentSrc = video.currentSrc;
    if (!currentSrc || this.promises.has(currentSrc)) return;

    const promise = captureVideoFrame(video).then((blob) => ({
      url: currentSrc,
      blob,
    }));
    this.addPromise(currentSrc, promise);
  }

  /**
   * Mint a new `rasterized:N` pseudo-URL.
   */
  getRasterizedImageUrl(): string {
    return `rasterized:${this.rasterizedId++}`;
  }

  /**
   * Await every registered promise and return the results as a Map.
   */
  async getBlobMap(): Promise<Map<string, AssetEntry>> {
    const blobMap = new Map<string, AssetEntry>();
    for (const [url, promise] of this.promises.entries()) {
      const result = await promise;
      blobMap.set(url, result);
    }
    return blobMap;
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Walk an element and collect any image / video / background-image assets.
 */
export function resolveResources(element: Element, computedStyle: CSSStyleDeclaration, assetCollector: ResourceResolver): void {
  collectImageElement(element, assetCollector);
  collectVideoElement(element, assetCollector);
  collectBackgroundImages(assetCollector, computedStyle);
}

/**
 * Return `true` when `url` points to a genuinely remote host
 * (i.e. not localhost / 127.x / ::1 / .local, and not a data/blob URL).
 */
export function isRemoteUrl(url: string): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return false;

  // Relative URLs inherit the page origin - check that instead.
  if (
    !url.startsWith("http://") &&
    !url.startsWith("https://") &&
    !url.startsWith("//")
  ) {
    return isRemoteUrl(window.location.href);
  }

  try {
    const hostname = new URL(url, window.location.href).hostname;
    return !(
      hostname === "0.0.0.0" ||
      hostname === "localhost" ||
      hostname.startsWith("127.") ||
      hostname === "[::1]" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

/**
 * Convert a `<canvas>` to a PNG Blob.
 */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      blob
        ? resolve(blob)
        : reject(new Error("Failed to create blob from canvas"));
    }, "image/png");
  });
}

// ---------------------------------------------------------------------------
// Private: image fetching / conversion
// ---------------------------------------------------------------------------

/**
 * Extract `url(...)` values from `background-image` and register each.
 */
function collectBackgroundImages(assetCollector: ResourceResolver, computedStyle: CSSStyleDeclaration): void {
  const matches = computedStyle.backgroundImage?.matchAll(
    /url\("(.*?)"\)/g,
  );
  if (!matches) return;

  for (const [, url] of matches) {
    assetCollector.addImage(url);
  }
}

/**
 * If `element` is an `<img>`, register its `currentSrc`.
 */
function collectImageElement(element: Element, assetCollector: ResourceResolver): void {
  if (isInstanceOfOwner<HTMLImageElement>(element, element, "HTMLImageElement")) {
    assetCollector.addImage(element.currentSrc, element);
  }
}

/**
 * If `element` is a `<video>`, register its poster and/or current frame.
 */
function collectVideoElement(element: Element, assetCollector: ResourceResolver): void {
  if (!isInstanceOfOwner<HTMLVideoElement>(element, element, "HTMLVideoElement")) return;

  if (element.poster) {
    assetCollector.addImage(element.poster);
  }
  if (element.currentSrc && !shouldSkipVideo(element)) {
    assetCollector.addVideo(element);
  }
}

/**
 * Decide whether a video should be skipped.
 *
 * When a poster exists we skip if the video hasn't loaded enough data,
 * has zero dimensions, or is paused at time zero (nothing to capture).
 */
function shouldSkipVideo(video: HTMLVideoElement): boolean {
  if (!video.poster) return false;

  return (
    video.readyState < 2 ||
    video.videoWidth === 0 ||
    (video.currentTime === 0 && video.paused)
  );
}

/**
 * Fetch an image URL and return `{ url, blob }`.
 *
 * Tries multiple strategies in order:
 * 1. Direct canvas rasterization of the source `<img>` element — the browser
 *    has already loaded it, no network request needed, CORS irrelevant.
 * 2. Standard `fetch()` — works for same-origin and CORS-enabled resources.
 * 3. Find any `<img>` on the page with the same src and rasterize it.
 * 4. Load a new `<img>` without crossorigin (uses browser disk cache).
 *
 * Strategy 1 is the key fix: when the page displays a cross-origin image,
 * the browser already decoded it. Drawing it to a canvas without ever setting
 * `crossorigin` does NOT taint the canvas in most browsers because the image
 * was loaded in "no-cors" mode (the default for `<img>`). The canvas becomes
 * tainted only when we try to *read* pixels — but `toBlob()` works fine as
 * long as the canvas hasn't been tainted by a crossorigin-flagged load.
 *
 * Important: setting `crossorigin="anonymous"` on a *new* `<img>` forces a
 * fresh CORS-mode request which fails if the server doesn't send headers.
 * That's why Strategy 1 (reuse existing element) is preferred.
 */
async function fetchImageAsBlob(url: string, sourceElement?: HTMLImageElement): Promise<AssetEntry> {
  const sameOrigin = isSameOrigin(url);

  // === Same-origin fast path ===
  if (sameOrigin) {
    // Canvas rasterization works for same-origin without taint
    if (sourceElement && sourceElement.naturalWidth > 0 && sourceElement.complete) {
      try {
        const blob = await rasterizeLoadedImage(sourceElement);
        return { url, blob };
      } catch { /* fall through */ }
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        let blob = await response.blob();
        if (UNSUPPORTED_IMAGE_TYPES.has(blob.type)) {
          blob = await convertUnsupportedImage(blob);
        }
        blob = await maybeRasterizeSmallSvgIcon(url, blob, sourceElement);
        return { url, blob };
      }
    } catch { /* fall through */ }

    return { url, blob: null, error: `Failed to fetch same-origin image: ${url}` };
  }

  // === Cross-origin path (no fetch, no console errors) ===

  // Strategy 1: extension CORS bridge — the only reliable way for cross-origin.
  // Skip if bridge was already detected as unavailable (avoid 3s timeout per image).
  if (!bridgeUnavailable) {
    try {
      const blob = await fetchViaExtensionBridge(url);
      if (blob) {
        return { url, blob: await maybeRasterizeSmallSvgIcon(url, blob, sourceElement) };
      }
      // null result means timeout — bridge not installed
      bridgeUnavailable = true;
    } catch {
      bridgeUnavailable = true;
    }
  }

  // Strategy 2: try rasterizing the already-loaded <img> element.
  // Cross-origin images loaded without crossorigin attribute taint the canvas,
  // but some browser/extension contexts allow it.
  if (sourceElement && sourceElement.naturalWidth > 0 && sourceElement.complete) {
    try {
      const blob = await rasterizeLoadedImage(sourceElement);
      return { url, blob };
    } catch { /* tainted canvas — expected */ }
  }

  // Strategy 3: find any loaded <img> on the page with the same src
  const existingImg = findLoadedImageOnPage(url, sourceElement?.ownerDocument);
  if (existingImg) {
    try {
      const blob = await rasterizeLoadedImage(existingImg);
      return { url, blob };
    } catch { /* tainted — expected */ }
  }

  // Final fallback: preserve URL, no blob. Do NOT create new <img> or fetch()
  // for cross-origin URLs — it would only produce console CORS errors.
  return { url, blob: null, error: `Cross-origin image, bridge unavailable: ${url}` };
}

/**
 * Fetch an image via the extension's CORS bridge.
 *
 * Sends a custom event to the ISOLATED world content script, which relays
 * it to the background service worker. The background fetches the image
 * without CORS restrictions and returns a base64 data URL.
 *
 * Returns null if the bridge is not available (e.g. not running as extension).
 */
function fetchViaExtensionBridge(url: string): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve, reject) => {
    const callbackId = `figma-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null); // Timeout = bridge not available, don't reject
    }, 1_500);

    function onResult(event: Event): void {
      const detail = (event as CustomEvent).detail;
      if (detail?.callbackId !== callbackId) return;

      cleanup();

      if (detail.result?.error) {
        reject(new Error(detail.result.error));
        return;
      }

      if (detail.result?.dataUrl) {
        // Convert data URL to blob
        fetch(detail.result.dataUrl)
          .then((r) => r.blob())
          .then(resolve)
          .catch(reject);
      } else {
        resolve(null);
      }
    }

    function cleanup(): void {
      clearTimeout(timeout);
      window.removeEventListener("figma-capture-fetch-result", onResult);
    }

    window.addEventListener("figma-capture-fetch-result", onResult);

    // Dispatch request to ISOLATED world bridge
    window.dispatchEvent(
      new CustomEvent("figma-capture-fetch", {
        detail: { url, callbackId },
      }),
    );
  });
}

function captureVisibleTabViaExtensionBridge(): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve, reject) => {
    const callbackId = `figma-visible-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 2_000);

    function onResult(event: Event): void {
      const detail = (event as CustomEvent).detail;
      if (detail?.callbackId !== callbackId) return;

      cleanup();

      if (detail.result?.error) {
        reject(new Error(detail.result.error));
        return;
      }

      if (detail.result?.dataUrl) {
        fetch(detail.result.dataUrl)
          .then((r) => r.blob())
          .then(resolve)
          .catch(reject);
      } else {
        resolve(null);
      }
    }

    function cleanup(): void {
      clearTimeout(timeout);
      window.removeEventListener("figma-capture-visible-tab-result", onResult);
    }

    window.addEventListener("figma-capture-visible-tab-result", onResult);

    window.dispatchEvent(
      new CustomEvent("figma-capture-visible-tab", {
        detail: { callbackId },
      }),
    );
  });
}

async function captureViewportCrop(rect: Rect): Promise<Blob> {
  const screenshot = await captureVisibleTabViaExtensionBridge();
  if (!screenshot) {
    throw new Error("Visible tab screenshot bridge is unavailable");
  }

  const objectUrl = URL.createObjectURL(screenshot);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();

    const scaleX = image.naturalWidth / window.innerWidth;
    const scaleY = image.naturalHeight / window.innerHeight;
    const sourceX = Math.max(0, Math.round(rect.x * scaleX));
    const sourceY = Math.max(0, Math.round(rect.y * scaleY));
    const sourceWidth = Math.max(1, Math.round(rect.width * scaleX));
    const sourceHeight = Math.max(1, Math.round(rect.height * scaleY));

    const canvas = document.createElement("canvas");
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas context for viewport crop");
    }

    ctx.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight,
    );

    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Draw an already-loaded `<img>` element onto a canvas and extract a PNG blob.
 *
 * This works without CORS because the image was loaded in "no-cors" mode
 * (the browser default for `<img>` tags). The canvas is not tainted as long
 * as no `crossorigin` attribute was set on the source element.
 */
function rasterizeLoadedImage(img: HTMLImageElement): Promise<Blob> {
  const canvas = getNodeDocument(img).createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return Promise.reject(new Error("Failed to get canvas context"));
  }

  ctx.drawImage(img, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        blob ? resolve(blob) : reject(new Error("toBlob returned null"));
      }, "image/png");
    } catch (e) {
      // SecurityError if canvas is tainted
      reject(e);
    }
  });
}

/**
 * Search the page for an already-loaded `<img>` element with the given src.
 */
function findLoadedImageOnPage(url: string, doc: Document = document): HTMLImageElement | null {
  const images = doc.querySelectorAll<HTMLImageElement>("img");
  for (const img of images) {
    if (
      (img.currentSrc === url || img.src === url) &&
      img.complete &&
      img.naturalWidth > 0
    ) {
      return img;
    }
  }
  return null;
}

/**
 * Load a new `<img>` (without crossorigin) and rasterize via canvas.
 * Uses the browser's disk cache — no CORS preflight is sent.
 */
function rasterizeImageUrl(url: string): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const img = new Image();

    const timeout = setTimeout(() => {
      reject(new Error(`Image load timeout: ${url}`));
    }, 10_000);

    img.onload = () => {
      clearTimeout(timeout);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Failed to get canvas context"));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          blob ? resolve(blob) : reject(new Error("toBlob returned null"));
        }, "image/png");
      } catch (e) {
        reject(e);
      }
    };

    img.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`Failed to load image: ${url}`));
    };

    img.src = url;
  });
}

/**
 * Re-encode an unsupported image blob to PNG using an off-screen canvas.
 */
async function convertUnsupportedImage(blob: Blob): Promise<Blob> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas context for image conversion");
    }

    ctx.drawImage(image, 0, 0);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function maybeRasterizeSmallSvgIcon(
  url: string,
  blob: Blob,
  sourceElement?: HTMLImageElement,
): Promise<Blob> {
  if (!sourceElement || !isSvgImage(url, blob) || !isSmallIconImage(sourceElement)) {
    return blob;
  }

  try {
    return await rasterizeImageBlob(blob);
  } catch {
    return blob;
  }
}

function isSvgImage(url: string, blob: Blob): boolean {
  return blob.type === "image/svg+xml" || /\.svg(?:$|[?#])/i.test(url);
}

function isSmallIconImage(img: HTMLImageElement): boolean {
  const rect = img.getBoundingClientRect();
  const view = img.ownerDocument.defaultView;
  const computedWidth = view ? parseFloat(view.getComputedStyle(img).width || "") : NaN;
  const width = firstFinitePositive(rect.width, computedWidth, img.width, img.naturalWidth);
  const naturalWidth = firstFinitePositive(img.naturalWidth, width);

  return width > 0 && width <= 32 && naturalWidth <= 96;
}

function firstFinitePositive(...values: number[]): number {
  return values.find((value) => Number.isFinite(value) && value > 0) ?? 0;
}

async function rasterizeImageBlob(blob: Blob): Promise<Blob> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width || 32;
    canvas.height = image.naturalHeight || image.height || canvas.width;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas context for SVG icon rasterization");
    }

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// ---------------------------------------------------------------------------
// Private: same-origin / cross-origin helpers
// ---------------------------------------------------------------------------

/**
 * Return `true` if `url` resolves to the same origin as the current page.
 */
function isSameOrigin(url: string): boolean {
  try {
    return (
      new URL(url, window.location.href).origin === window.location.origin
    );
  } catch {
    return false;
  }
}

/**
 * Attempt to load a cross-origin copy of a `<video>` so that we can
 * draw it to a canvas without tainting the context.
 *
 * Returns `null` if the video is already same-origin or already has
 * `crossOrigin` set (meaning the original element is usable directly).
 */
async function loadCrossOriginVideo(video: HTMLVideoElement): Promise<HTMLVideoElement | null> {
  const src = video.currentSrc ?? video.src;

  // Nothing to do if the video is already usable.
  if (isSameOrigin(src) || video.crossOrigin !== null) return null;

  const clonedVideo = getNodeDocument(video).createElement("video");
  clonedVideo.crossOrigin = "anonymous";
  clonedVideo.src = src;
  clonedVideo.muted = true;
  clonedVideo.preload = "auto";
  clonedVideo.style.position = "absolute";
  clonedVideo.style.visibility = "hidden";
  clonedVideo.style.pointerEvents = "none";

  return new Promise<HTMLVideoElement>((resolve, reject) => {
    const targetTime = video.currentTime;
    let seeked = false;
    let frameReady = false;
    let frameCallbackId: number | null = null;
    const timeout = setTimeout(onTimeout, 10_000);

    clonedVideo.addEventListener("error", onError);

    if (targetTime === 0) {
      // No seeking needed - just wait for the first frame.
      seeked = true;
      frameCallbackId = clonedVideo.requestVideoFrameCallback(onFrameReady);
      clonedVideo
        .play()
        .then(() => clonedVideo.pause())
        .catch(onError);
    } else if (clonedVideo.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seekToTarget();
    } else {
      clonedVideo.addEventListener("loadedmetadata", seekToTarget, {
        once: true,
      });
    }

    function seekToTarget(): void {
      clonedVideo.currentTime = targetTime;
      clonedVideo.addEventListener("seeked", onSeeked, { once: true });
      frameCallbackId = clonedVideo.requestVideoFrameCallback(onFrameReady);
    }

    function onFrameReady(): void {
      frameReady = true;
      maybeResolve();
    }

    function onSeeked(): void {
      seeked = true;
      maybeResolve();
    }

    function maybeResolve(): void {
      if (seeked && frameReady) {
        cleanup();
        resolve(clonedVideo);
      }
    }

    function cleanup(): void {
      clearTimeout(timeout);
      clonedVideo.removeEventListener("error", onError);
      clonedVideo.removeEventListener("loadedmetadata", seekToTarget);
      clonedVideo.removeEventListener("seeked", onSeeked);
      if (frameCallbackId !== null) {
        clonedVideo.cancelVideoFrameCallback(frameCallbackId);
      }
    }

    function onError(): void {
      const errorCode = clonedVideo.error?.code;
      const errorMessage = clonedVideo.error?.message;
      const err = new Error(
        `Video error: code: ${errorCode}, message: ${errorMessage} (readyState: ${clonedVideo.readyState})`,
      );
      cleanup();
      cleanupVideo(clonedVideo);
      reject(err);
    }

    function onTimeout(): void {
      cleanup();
      cleanupVideo(clonedVideo);
      reject(new CaptureError("Video loading timeout", "VIDEO_TIMEOUT"));
    }
  });
}

/**
 * Release a video element's resources by clearing its source.
 */
function cleanupVideo(video: HTMLVideoElement): void {
  video.src = "";
}

/**
 * Capture the current frame of a video element as a PNG Blob.
 *
 * If the video is cross-origin a temporary clone with
 * `crossOrigin="anonymous"` is created so the canvas remains untainted.
 */
async function captureVideoFrame(video: HTMLVideoElement): Promise<Blob> {
  const crossOriginVideo = await loadCrossOriginVideo(video);
  const sourceVideo = crossOriginVideo ?? video;

  try {
    if (sourceVideo.videoWidth === 0 || sourceVideo.videoHeight === 0) {
      throw new Error("Video has invalid dimensions");
    }

    const canvas = getNodeDocument(sourceVideo).createElement("canvas");
    canvas.width = sourceVideo.videoWidth;
    canvas.height = sourceVideo.videoHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }

    ctx.drawImage(sourceVideo, 0, 0);
    return canvasToBlob(canvas);
  } finally {
    if (crossOriginVideo) {
      cleanupVideo(crossOriginVideo);
    }
  }
}
