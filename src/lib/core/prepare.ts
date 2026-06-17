/**
 * Pre-capture preparation: lazy image loading, scrollbar hiding, layout validation.
 */

// ---------------------------------------------------------------------------
// Layout validation
// ---------------------------------------------------------------------------

/**
 * Assert that the document has a valid layout (non-zero body rect).
 */
export function assertLayoutValid(options: { assertLayoutValid?: boolean }): void {
  if (!options.assertLayoutValid) return;

  const rect = document.body.getBoundingClientRect();
  if (
    rect.x === 0 &&
    rect.y === 0 &&
    rect.width === 0 &&
    rect.height === 0 &&
    rect.top === 0 &&
    rect.right === 0 &&
    rect.bottom === 0 &&
    rect.left === 0
  ) {
    throw new Error("Document does not have valid layout");
  }
}

// ---------------------------------------------------------------------------
// Image decoding
// ---------------------------------------------------------------------------

/**
 * Wait for all images to finish decoding.
 *
 * Called after `forceLazyImages` has already rewritten src attributes.
 * Sets `decoding="sync"` to prioritize decode and waits for all to finish.
 */
export function decodeImages(images: HTMLImageElement[]): Promise<void> {
  for (const img of images) {
    if (img.decoding !== "sync") img.decoding = "sync";
  }

  return Promise.allSettled(
    images
      .filter((img) => img.src && img.src !== "")
      .map((img) =>
        img.decode().catch((err) => {
          console.debug("Error decoding image", err, img.src);
        }),
      ),
  ).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Scrollbar hiding
// ---------------------------------------------------------------------------

/** Stores cleanup function for scrollbar hiding, called after capture. */
let restoreScrollbar: (() => void) | null = null;

export function resetScrollbarState(): void {
  restoreScrollbar = null;
}

export function cleanupScrollbar(): void {
  if (restoreScrollbar !== null) {
    restoreScrollbar();
    restoreScrollbar = null;
  }
}

/**
 * Install temporary capture styles: hide scrollbars and force immediate
 * scrolling so capture does not sample during a smooth-scroll transition.
 * Returns a cleanup function to restore the original state.
 */
function installCapturePreparationStyles(): () => void {
  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-h2d-capture", "scrollbar-hide");
  styleEl.textContent = `
    html, body, * {
      scroll-behavior: auto !important;
    }
    html, body {
      scrollbar-width: none !important;
    }
    html::-webkit-scrollbar, body::-webkit-scrollbar {
      display: none !important;
    }
  `;
  document.head.appendChild(styleEl);

  return () => {
    styleEl.remove();
  };
}

// ---------------------------------------------------------------------------
// Lazy image loading
// ---------------------------------------------------------------------------

/** Max scroll height to prevent infinite scroll loops (LinkedIn, Twitter, etc.) */
const MAX_SCROLL_HEIGHT = 15000;
/** Max number of scroll steps to keep capture time reasonable */
const MAX_SCROLL_STEPS = 25;

interface ElementScrollPosition {
  element: Element;
  left: number;
  top: number;
}

/**
 * Scroll through the entire page top-to-bottom to trigger
 * IntersectionObserver-based lazy loading.
 *
 * Many sites (Apple, Netflix, etc.) use JS observers instead of data-src
 * attributes. The only way to trigger them is to actually scroll the element
 * into the viewport intersection zone.
 */
async function scrollToTriggerLazyLoad(container: Element): Promise<void> {
  const isRoot =
    container === document.documentElement || container === document.body;

  // Do not scroll the top-level page during interactive extension captures.
  // Admin shells often hide or animate top chrome while the window scrolls;
  // sampling during or just after that transition drops navbar content.
  if (isRoot) return;

  // Snapshot height ONCE — do not re-read, as infinite scroll sites grow it
  const rawHeight = container.scrollHeight;
  const viewportHeight = (container as HTMLElement).clientHeight;

  if (rawHeight <= viewportHeight) return;

  const totalHeight = Math.min(rawHeight, MAX_SCROLL_HEIGHT);
  const stepSize = Math.floor(viewportHeight * 0.7);
  const steps = Math.min(Math.ceil(totalHeight / stepSize), MAX_SCROLL_STEPS);

  for (let i = 0; i <= steps; i++) {
    const scrollTo = Math.min(i * stepSize, totalHeight);
    if (isRoot) {
      setRootScroll(0, scrollTo);
    } else {
      setElementScroll(container, 0, scrollTo);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  // Brief wait for final images to start loading
  await new Promise((r) => setTimeout(r, 300));
}

function setRootScroll(left: number, top: number): void {
  window.scrollTo({ left, top, behavior: "auto" });
  document.documentElement.scrollLeft = left;
  document.documentElement.scrollTop = top;
  document.body.scrollLeft = left;
  document.body.scrollTop = top;
}

function setElementScroll(container: Element, left: number, top: number): void {
  container.scrollLeft = left;
  container.scrollTop = top;
}

function getScrollPosition(container: Element, isRoot: boolean): { left: number; top: number } {
  return {
    left: isRoot
      ? window.scrollX || document.documentElement.scrollLeft || document.body.scrollLeft
      : container.scrollLeft,
    top: isRoot
      ? window.scrollY || document.documentElement.scrollTop || document.body.scrollTop
      : container.scrollTop,
  };
}

async function waitForScrollPosition(container: Element, isRoot: boolean, left: number, top: number): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const { left: currentLeft, top: currentTop } = getScrollPosition(container, isRoot);

    if (Math.abs(currentLeft - left) <= 1 && Math.abs(currentTop - top) <= 1) {
      return;
    }

    if (isRoot) {
      setRootScroll(left, top);
    } else {
      setElementScroll(container, left, top);
    }
  }
}

/**
 * Find all images with lazy-loading attributes and force them to load.
 *
 * Covers common lazy-loading patterns:
 * - Native: `loading="lazy"` → remove attribute, reassign src
 * - data-src / data-lazy-src / data-original / data-actualsrc → copy to src
 * - `<source data-srcset>` inside `<picture>` → copy to srcset
 * - Background lazy: `data-bg` / `data-background-image` → set inline style
 */
function forceLazyImages(container: Element): void {
  // --- <img> elements ---
  const images = container.querySelectorAll<HTMLImageElement>("img");
  for (const img of images) {
    // Remove native lazy loading
    if (img.loading === "lazy") {
      img.loading = "eager";
      img.removeAttribute("loading");
    }

    // Common JS lazy-load libraries (lazysizes, lozad, vanilla-lazyload, etc.)
    const lazySrc =
      img.dataset.src ||
      img.dataset.lazySrc ||
      img.dataset.original ||
      img.dataset.actualsrc ||
      img.dataset.deferred ||
      img.getAttribute("data-lazy");

    if (lazySrc && (!img.src || img.src.includes("placeholder") || img.src.startsWith("data:") || img.naturalWidth === 0)) {
      img.src = lazySrc;
    }

    // data-srcset → srcset
    const lazySrcset = img.dataset.srcset || img.dataset.lazySrcset;
    if (lazySrcset && !img.srcset) {
      img.srcset = lazySrcset;
    }

    // If image still hasn't loaded, force re-request
    if (img.src && !img.complete && img.naturalWidth === 0) {
      const src = img.src;
      img.src = "";
      img.src = src;
    }
  }

  // --- <source> inside <picture> ---
  const sources = container.querySelectorAll<HTMLSourceElement>("picture > source");
  for (const source of sources) {
    const lazySrcset = source.dataset.srcset || source.dataset.lazySrcset;
    if (lazySrcset && !source.srcset) {
      source.srcset = lazySrcset;
    }
  }

  // --- Background images via data attributes ---
  const bgLazy = container.querySelectorAll<HTMLElement>("[data-bg], [data-background-image]");
  for (const el of bgLazy) {
    const bgUrl = el.dataset.bg || el.dataset.backgroundImage;
    if (bgUrl && !el.style.backgroundImage) {
      el.style.backgroundImage = `url("${bgUrl}")`;
    }
  }
}

// ---------------------------------------------------------------------------
// Main preparation entry point
// ---------------------------------------------------------------------------

/**
 * Prepare the page for full-page capture.
 *
 * 1. Force lazy images via data-src attribute rewriting.
 * 2. Scroll through the entire page to trigger IntersectionObserver-based
 *    lazy loaders (common on Apple, etc.) that don't use data-src.
 * 3. Restore the user's current scroll position before measuring layout.
 */
export async function prepareForCapture(container: Element): Promise<void> {
  const isRoot =
    container === document.documentElement || container === document.body;
  const originalScroll = getScrollPosition(container, isRoot);
  const nestedScrollPositions = collectNestedScrollPositions(container);

  // Install before any scrolling so pages with `scroll-behavior: smooth` do
  // not leave sticky headers mid-transition when snapshotting starts.
  restoreScrollbar = installCapturePreparationStyles();

  // Step 1: rewrite data-src / data-srcset attributes directly
  forceLazyImages(container);

  // Step 2: scroll through the page to trigger IntersectionObserver lazy loaders
  await scrollToTriggerLazyLoad(container);

  // Step 3: keep the current viewport stable. Capturing enterprise back-office
  // pages must preserve the user's visible scrolled region instead of jumping
  // to the top of the document.
  if (isRoot) {
    setRootScroll(originalScroll.left, originalScroll.top);
  } else {
    setElementScroll(container, originalScroll.left, originalScroll.top);
  }
  restoreNestedScrollPositions(nestedScrollPositions);
  await waitForScrollPosition(container, isRoot, originalScroll.left, originalScroll.top);
  restoreNestedScrollPositions(nestedScrollPositions);

  // Wait for layout to settle
  await new Promise((r) => setTimeout(r, 100));
  restoreNestedScrollPositions(nestedScrollPositions);
}

function collectNestedScrollPositions(container: Element): ElementScrollPosition[] {
  const positions: ElementScrollPosition[] = [];
  const elements = [container, ...Array.from(container.querySelectorAll("*"))];

  for (const element of elements) {
    if (element === document.documentElement || element === document.body) continue;
    if (!(element instanceof HTMLElement)) continue;

    const left = element.scrollLeft;
    const top = element.scrollTop;
    if (Math.abs(left) <= 1 && Math.abs(top) <= 1) continue;

    positions.push({ element, left, top });
  }

  return positions;
}

function restoreNestedScrollPositions(positions: ElementScrollPosition[]): void {
  for (const { element, left, top } of positions) {
    if (!element.isConnected) continue;
    element.scrollLeft = left;
    element.scrollTop = top;
  }
}
