/**
 * DOM traversal utilities: visibility checks, child iteration, attribute extraction.
 */

import type {
  SnapshotNode,
  ElementSnapshot,
  TextSnapshot,
  SimpleMatrix,
} from '../types.js';
import { getComputedStyleFor, getNodeDocument, getNodeWindow, isInstanceOfOwner } from './dom.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NODE_TYPES = {
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,
} as const;

/**
 * Set of HTML attributes that are preserved during serialization.
 */
const ALLOWED_ATTRIBUTES = new Set([
  "alt",
  "checked",
  "currentSrc",
  "disabled",
  "for",
  "href",
  "id",
  "multiple",
  "placeholder",
  "poster",
  "readonly",
  "rel",
  "required",
  "role",
  "selected",
  "target",
  "title",
  "type",
  "value",
]);

/** Input types that support placeholder text. */
export const INPUT_TYPES_WITH_PLACEHOLDER = new Set([
  "text",
  "search",
  "tel",
  "url",
  "email",
  "password",
  "number",
]);

/** Viewport width for offscreen detection. */
const OFFSCREEN_MARGIN = 500;

// ---------------------------------------------------------------------------
// Visibility checks
// ---------------------------------------------------------------------------

/**
 * Check whether a DOM element should be serialized.
 *
 * Filters out elements that are completely invisible and would only
 * produce noise in the Figma import (hidden dropdowns, modals, tooltips,
 * off-screen elements, empty zero-size containers, etc.).
 */
export function isNodeVisible(element: Element): boolean {
  if (element.tagName.toUpperCase() === "SCRIPT") return false;
  if (
    element.nodeType === Node.ELEMENT_NODE &&
    element.getAttribute("data-h2d-ignore") === "true"
  ) {
    return false;
  }

  if (isHiddenPopupLayer(element)) return false;

  const computed = getComputedStyleFor(element);

  // display:none — element and all descendants are invisible
  if (computed.display === "none") return false;

  if (isVisuallyHiddenAccessibilityElement(element, computed)) return false;

  // visibility:hidden — element is invisible (children may override, but
  // Figma can't represent that, so skip the subtree)
  if (computed.visibility === "hidden") return false;

  const opacity = Number.parseFloat(computed.opacity || "1");
  if (Number.isFinite(opacity) && opacity <= 0.01) return false;

  return true;
}

function isVisuallyHiddenAccessibilityElement(element: Element, computed: CSSStyleDeclaration): boolean {
  if (element.matches(":focus, :focus-within")) return false;

  const identity = `${String((element as HTMLElement | SVGElement).className || "")} ${element.id || ""}`;
  const hasAccessibilityHiddenClass =
    /(^|[-_\s])(sr-only|visually-hidden|screen-reader|screenreader|a11y-hidden|assistive-text)([-_\s]|$)/i.test(identity);
  const usesClippedHiding =
    /rect\(\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*\)/i.test(computed.clip || "") ||
    /inset\(\s*50%\s*\)/i.test(computed.clipPath || "");

  if (!hasAccessibilityHiddenClass && !usesClippedHiding) return false;

  const rect = element.getBoundingClientRect();
  const isTinyBox =
    rect.width <= 2 ||
    rect.height <= 2 ||
    parseCssPx(computed.width, 0) <= 2 ||
    parseCssPx(computed.height, 0) <= 2;
  const isOutOfFlow = computed.position === "absolute" || computed.position === "fixed";
  const clipsContent = /^(hidden|clip)$/i.test(computed.overflow) ||
    /^(hidden|clip)$/i.test(computed.overflowX) ||
    /^(hidden|clip)$/i.test(computed.overflowY);

  return hasAccessibilityHiddenClass || (usesClippedHiding && (isTinyBox || isOutOfFlow || clipsContent));
}

function parseCssPx(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isHiddenPopupLayer(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "SVG" || tag === "PATH" || tag === "USE") return false;

  const identity = `${String((element as HTMLElement | SVGElement).className || "")} ${element.id || ""} ${element.getAttribute("role") || ""}`;
  if (/(^|[-_\s])(anticon|svg-icon|icon)([-_\s]|$)/i.test(identity)) return false;
  if (isVisibleChromeControl(element, identity)) return false;
  if (isPopupTriggerElement(element, identity)) return false;

  const definitePopup =
    /(^|[-_\s])(popper|popover|select-dropdown|picker-dropdown|menu|listbox)([-_\s]|$)/i.test(identity) ||
    /(^|[-_\s])dropdown[-_\s_]*(menu|popper|panel|content)([-_\s]|$)/i.test(identity);
  const looksLikePopup = definitePopup || /(^|[-_\s])tooltip([-_\s]|$)/i.test(identity);
  if (!looksLikePopup) return false;

  const computed = getComputedStyleFor(element);

  if (
    element.getAttribute("aria-hidden") === "true" ||
    element.getAttribute("data-popper-reference-hidden") === "true" ||
    element.hasAttribute("hidden") ||
    computed.opacity === "0" ||
    computed.pointerEvents === "none"
  ) {
    return true;
  }

  return isEmptyPopupLayer(element);
}

function isPopupTriggerElement(element: Element, identity: string): boolean {
  const role = element.getAttribute("role")?.toLowerCase() || "";
  if (role === "button" || role === "link" || role === "combobox") return true;
  if (/(^|[-_\s])(trigger|reference)([-_\s]|$)/i.test(identity)) return true;

  // Element Plus uses `el-dropdown` for the visible trigger wrapper and
  // `el-dropdown__popper` / menu classes for the detached popup.
  return (
    /(^|[-_\s])el-dropdown([-_\s]|$)/i.test(identity) &&
    !/(popper|menu|panel|content|listbox)/i.test(identity)
  );
}

function isVisibleChromeControl(element: Element, identity: string): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (!/(^|[-_\s])(avatar|right-menu|navbar|breadcrumb|hamburger|user-avatar|hover-effect)([-_\s]|$)/i.test(identity)) {
    const closest = element.closest?.(
      ".avatar-container, .right-menu, .navbar, #breadcrumb-container, #hamburger-container",
    );
    if (!closest) return false;
  }

  const computed = getComputedStyleFor(element);
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;
  return true;
}

function isEmptyPopupLayer(element: Element): boolean {
  const role = element.getAttribute("role")?.toLowerCase() || "";
  if (role === "menu") return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return true;

  const options = Array.from(element.querySelectorAll('[role="option"], [role="menuitem"], li'));
  const hasVisibleOption = options.some((option) => {
    if (!(option instanceof Element) || !isNodeVisible(option)) return false;
    return Boolean((option.textContent || "").trim());
  });
  if (hasVisibleOption) return false;

  const text = (element.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return true;
  return /^(请选择|请选择[\u4e00-\u9fa5A-Za-z0-9_ -]*|Select|Please select)$/i.test(text);
}

/**
 * Check if a serialized element is effectively invisible and should be pruned.
 *
 * Returns true if the node should be removed from the tree. Called after
 * children have been serialized so we can check whether any are visible.
 */
export function shouldPruneNode(
  element: Element,
  rect: { x: number; y: number; width: number; height: number },
  childNodes: SnapshotNode[],
): boolean {
  const hasVisibleChildren = childNodes.length > 0;
  const tag = element.tagName.toUpperCase();

  // Zero-size element with no visible children — prune
  if (rect.width === 0 && rect.height === 0 && !hasVisibleChildren) {
    return true;
  }

  // Zero-size elements that only contain other zero-size elements — prune
  // This catches containers that are collapsed but have invisible children
  if (rect.width === 0 && rect.height === 0 && hasVisibleChildren) {
    // Keep if it's a structural element (HTML, BODY) or has meaningful content
    if (tag === "HTML" || tag === "BODY") return false;

    // Check if any child has a non-zero size
    const hasNonZeroChild = childNodes.some((child) => {
      if (child.nodeType === NODE_TYPES.ELEMENT_NODE) {
        const el = child as ElementSnapshot;
        return el.rect.width > 0 || el.rect.height > 0;
      }
      if (child.nodeType === NODE_TYPES.TEXT_NODE) {
        const text = child as TextSnapshot;
        return text.rect.width > 0 || text.rect.height > 0;
      }
      return false;
    });

    if (!hasNonZeroChild) return true;
  }

  if (
    tag !== "HTML" &&
    tag !== "BODY" &&
    rect.width > 0 &&
    rect.height > 0
  ) {
    const clippingRects = [
      ...getFullyClippingScrollAncestorRects(element, rect),
      ...getFullyClippingOverflowHiddenAncestorRects(element, rect),
    ];
    if (clippingRects.length > 0 && !hasVisibleSnapshotDescendantInAllClips(childNodes, clippingRects)) {
      return true;
    }
  }

  // Offscreen detection: element is entirely outside the full document bounds.
  // Use scrollWidth/scrollHeight (not viewport) so that content below the fold
  // is captured — the previous viewport-based check was clipping everything
  // outside the visible 720px window.
  const doc = getNodeDocument(element);
  const view = getNodeWindow(element);
  const docW = Math.max(
    doc.documentElement.scrollWidth,
    doc.documentElement.clientWidth,
    view.innerWidth,
  );
  const docH = Math.max(
    doc.documentElement.scrollHeight,
    doc.documentElement.clientHeight,
    view.innerHeight,
  );
  if (
    rect.width > 0 && rect.height > 0 &&
    (rect.x + rect.width < -OFFSCREEN_MARGIN ||
     rect.x > docW + OFFSCREEN_MARGIN ||
     rect.y + rect.height < -OFFSCREEN_MARGIN ||
     rect.y > docH + OFFSCREEN_MARGIN)
  ) {
    if (tag !== "HTML" && tag !== "BODY") {
      if (hasVisibleSnapshotDescendantInBounds(childNodes, docW, docH)) {
        return false;
      }
      return true;
    }
  }

  return false;
}

function getFullyClippingScrollAncestorRects(
  element: Element,
  rect: { x: number; y: number; width: number; height: number },
): DOMRect[] {
  if (rect.width <= 0 || rect.height <= 0) return [];

  const elementComputed = getComputedStyleFor(element);
  if (elementComputed.position === "fixed") return [];

  const clippingRects: DOMRect[] = [];
  let ancestor = element.parentElement;
  while (ancestor) {
    if (isHorizontalScrollClipAncestor(ancestor)) {
      const clip = ancestor.getBoundingClientRect();
      if (clip.width > 0 && (rect.x + rect.width <= clip.left || rect.x >= clip.right)) {
        clippingRects.push(clip);
      }
    }

    if (isVerticalOverlayScrollClipAncestor(ancestor)) {
      const clip = ancestor.getBoundingClientRect();
      if (clip.height > 0 && (rect.y + rect.height <= clip.top || rect.y >= clip.bottom)) {
        clippingRects.push(clip);
      }
    }

    ancestor = ancestor.parentElement;
  }

  return clippingRects;
}

/**
 * Collect overflow hidden/clip ancestors that clip `element` fully out of view.
 *
 * Walks the CSS containing-block chain (not the plain parent chain) so that
 * absolutely positioned elements are only tested against ancestors whose
 * overflow actually applies to them. Content lying entirely outside such an
 * ancestor is never painted by the browser (e.g. a sidebar logo title that
 * wraps below its overflow-hidden container), so it must not survive capture.
 */
function getFullyClippingOverflowHiddenAncestorRects(
  element: Element,
  rect: { x: number; y: number; width: number; height: number },
): DOMRect[] {
  if (rect.width <= 0 || rect.height <= 0) return [];

  const clippingRects: DOMRect[] = [];
  let current: Element | null = element;
  let depth = 0;

  while (current && depth < 64) {
    const container = getContainingBlockAncestor(current);
    if (!container) break;

    const computed = getComputedStyleFor(container);
    const clipsX = /^(hidden|clip)$/i.test(computed.overflowX);
    const clipsY = /^(hidden|clip)$/i.test(computed.overflowY);
    if (clipsX || clipsY) {
      const clip = container.getBoundingClientRect();
      const outsideX = clipsX && clip.width > 0 && (rect.x + rect.width <= clip.left || rect.x >= clip.right);
      const outsideY = clipsY && clip.height > 0 && (rect.y + rect.height <= clip.top || rect.y >= clip.bottom);
      if (outsideX || outsideY) clippingRects.push(clip);
    }

    current = container;
    depth += 1;
  }

  return clippingRects;
}

/**
 * Find the element acting as the CSS containing block for `element`.
 *
 * In-flow and relatively positioned elements use their parent; absolutely
 * positioned elements skip to the nearest positioned (or transform-bearing)
 * ancestor; fixed elements skip to the nearest transform-bearing ancestor.
 */
function getContainingBlockAncestor(element: Element): Element | null {
  const position = getComputedStyleFor(element).position;
  let ancestor = element.parentElement;
  if (position !== "fixed" && position !== "absolute") return ancestor;

  while (ancestor) {
    const computed = getComputedStyleFor(ancestor);
    if (position === "absolute" && computed.position !== "static") return ancestor;
    if (createsContainingBlockForPositioned(computed)) return ancestor;
    ancestor = ancestor.parentElement;
  }

  return null;
}

function createsContainingBlockForPositioned(computed: CSSStyleDeclaration): boolean {
  if (computed.transform && computed.transform !== "none") return true;
  if (computed.perspective && computed.perspective !== "none") return true;
  if (computed.filter && computed.filter !== "none") return true;
  if (/(transform|perspective|filter)/i.test(computed.willChange || "")) return true;
  return /(layout|paint|strict|content)/i.test(computed.contain || "");
}

function hasVisibleSnapshotDescendantInAllClips(childNodes: SnapshotNode[], clippingRects: DOMRect[]): boolean {
  for (const child of childNodes) {
    if (
      child.rect.width > 0 &&
      child.rect.height > 0 &&
      clippingRects.every((clipRect) => isRectIntersectingDomRect(child.rect, clipRect))
    ) {
      return true;
    }

    if (
      child.nodeType === NODE_TYPES.ELEMENT_NODE &&
      hasVisibleSnapshotDescendantInAllClips(child.childNodes, clippingRects)
    ) {
      return true;
    }
  }

  return false;
}

function isRectIntersectingDomRect(
  rect: { x: number; y: number; width: number; height: number },
  clipRect: DOMRect,
): boolean {
  return (
    rect.x < clipRect.right &&
    rect.x + rect.width > clipRect.left &&
    rect.y < clipRect.bottom &&
    rect.y + rect.height > clipRect.top
  );
}

function hasVisibleSnapshotDescendantInBounds(
  childNodes: SnapshotNode[],
  docW: number,
  docH: number,
): boolean {
  for (const child of childNodes) {
    if (isSnapshotRectInBounds(child.rect, docW, docH)) return true;

    if (
      child.nodeType === NODE_TYPES.ELEMENT_NODE &&
      hasVisibleSnapshotDescendantInBounds(child.childNodes, docW, docH)
    ) {
      return true;
    }
  }

  return false;
}

function isSnapshotRectInBounds(
  rect: { x: number; y: number; width: number; height: number },
  docW: number,
  docH: number,
): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x + rect.width >= -OFFSCREEN_MARGIN &&
    rect.x <= docW + OFFSCREEN_MARGIN &&
    rect.y + rect.height >= -OFFSCREEN_MARGIN &&
    rect.y <= docH + OFFSCREEN_MARGIN
  );
}

export function isFullyClippedByHorizontalScrollAncestor(
  element: Element,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;

  const elementComputed = getComputedStyleFor(element);
  if (elementComputed.position === "fixed") return false;

  let ancestor = element.parentElement;
  while (ancestor) {
    if (isHorizontalScrollClipAncestor(ancestor)) {
      const clip = ancestor.getBoundingClientRect();
      if (clip.width > 0 && (rect.x + rect.width <= clip.left || rect.x >= clip.right)) {
        return true;
      }
    }
    ancestor = ancestor.parentElement;
  }

  return false;
}

export function isFullyClippedByVerticalOverlayScrollAncestor(
  element: Element,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;

  const elementComputed = getComputedStyleFor(element);
  if (elementComputed.position === "fixed") return false;

  let ancestor = element.parentElement;
  while (ancestor) {
    if (isVerticalOverlayScrollClipAncestor(ancestor)) {
      const clip = ancestor.getBoundingClientRect();
      if (clip.height > 0 && (rect.y + rect.height <= clip.top || rect.y >= clip.bottom)) {
        return true;
      }
    }
    ancestor = ancestor.parentElement;
  }

  return false;
}

export function isVerticalOverlayScrollClipAncestor(element: Element): boolean {
  if (!isInstanceOfOwner<HTMLElement>(element, element, "HTMLElement")) return false;
  if (element.tagName.toUpperCase() === "HTML" || element.tagName.toUpperCase() === "BODY") return false;
  if (element.scrollHeight <= element.clientHeight + 1) return false;

  const computed = getComputedStyleFor(element);
  if (!/^(auto|scroll|hidden|clip)$/i.test(computed.overflowY) && !/^(auto|scroll|hidden|clip)$/i.test(computed.overflow)) {
    return false;
  }

  return isOverlayScrollIdentity(element) || isInsideOverlayShell(element) || isFixedOverlayScrollContainer(element);
}

function isHorizontalScrollClipAncestor(element: Element): boolean {
  if (!isInstanceOfOwner<HTMLElement>(element, element, "HTMLElement")) return false;
  if (element.scrollWidth <= element.clientWidth + 1) return false;

  const computed = getComputedStyleFor(element);
  return /^(auto|scroll|hidden|clip)$/i.test(computed.overflowX) ||
    /^(auto|scroll|hidden|clip)$/i.test(computed.overflow);
}

function isOverlayScrollIdentity(element: Element): boolean {
  const identity = getElementIdentity(element);
  return /(^|[-_\s])(drawer|modal|dialog|sheet|slideover|slide-over|side-panel|side-drawer|overlay|popup)([-_\s]|$)/i.test(identity);
}

function isInsideOverlayShell(element: Element): boolean {
  let ancestor = element.parentElement;
  let depth = 0;
  while (ancestor && depth < 6) {
    if (isOverlayScrollIdentity(ancestor)) return true;
    ancestor = ancestor.parentElement;
    depth += 1;
  }
  return false;
}

function isFixedOverlayScrollContainer(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const view = getNodeWindow(element);
  if (rect.width < 320 || rect.height < view.innerHeight * 0.45) return false;
  if (rect.x < view.innerWidth * 0.25 && rect.width < view.innerWidth * 0.9) return false;

  let current: Element | null = element;
  let depth = 0;
  while (current && depth < 5) {
    const computed = getComputedStyleFor(current);
    const zIndex = parseInt(computed.zIndex || "", 10);
    if (computed.position === "fixed" && (!Number.isFinite(zIndex) || zIndex >= 10)) {
      return true;
    }
    current = current.parentElement;
    depth += 1;
  }

  return false;
}

function getElementIdentity(element: Element): string {
  return `${String((element as HTMLElement | SVGElement).className || "")} ${element.id || ""} ${element.getAttribute("role") || ""}`;
}

// ---------------------------------------------------------------------------
// Text rect measurement
// ---------------------------------------------------------------------------

/**
 * Measure the bounding rect and line count for a text node or group.
 */
export function getTextRect(nodeOrNodes: Node | Node[]): { x: number; y: number; width: number; height: number; lineCount: number } {
  const ownerNode = Array.isArray(nodeOrNodes) ? nodeOrNodes[0] : nodeOrNodes;
  const doc = getNodeDocument(ownerNode);
  const view = getNodeWindow(ownerNode);
  const range = doc.createRange();

  if (Array.isArray(nodeOrNodes)) {
    const first = nodeOrNodes[0];
    const last = nodeOrNodes[nodeOrNodes.length - 1];
    range.setStart(first, 0);
    range.setEnd(last, (last as Text).length);
  } else {
    range.selectNode(nodeOrNodes);
  }

  const { x, y, width, height } = range.getBoundingClientRect();

  const isVertical =
    isInstanceOfOwner<HTMLElement>(range.commonAncestorContainer, ownerNode, "HTMLElement")
      ? view.getComputedStyle(range.commonAncestorContainer).writingMode.startsWith("vertical")
      : false;

  const clientRects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );

  const lineCount = isVertical
    ? new Set(clientRects.map((rect) => Math.round(rect.left))).size
    : new Set(clientRects.map((rect) => Math.round(rect.top))).size;

  range.detach();

  return { x, y, width, height, lineCount };
}

// ---------------------------------------------------------------------------
// Element attributes
// ---------------------------------------------------------------------------

/**
 * Extract allowed HTML attributes from an element.
 */
export function getElementAttributes(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};

  for (const { name, value } of element.attributes) {
    const lowerName = name.toLowerCase();
    if (ALLOWED_ATTRIBUTES.has(lowerName) || lowerName.startsWith("aria-") || lowerName.startsWith("data-")) {
      attrs[name] = value;
    }
  }

  // Always capture poster and currentSrc for media elements.
  if (isInstanceOfOwner<HTMLVideoElement>(element, element, "HTMLVideoElement") && element.poster) {
    attrs.poster = element.poster;
  }
  if (
    (isInstanceOfOwner<HTMLImageElement>(element, element, "HTMLImageElement") ||
      isInstanceOfOwner<HTMLVideoElement>(element, element, "HTMLVideoElement")) &&
    element.currentSrc
  ) {
    attrs.currentSrc = element.currentSrc;
  }

  if (isInstanceOfOwner<HTMLInputElement>(element, element, "HTMLInputElement")) {
    // Ensure input type is always present.
    if (attrs.type == null) {
      attrs.type = element.type;
    }

    // Some component libraries keep the current value only on the DOM property
    // (for example pagination jump inputs), not as a value attribute.
    if (element.type !== "password" && element.value && attrs.value == null) {
      attrs.value = element.value;
    }
  }

  return attrs;
}

// ---------------------------------------------------------------------------
// DOMMatrix to simple object
// ---------------------------------------------------------------------------

/**
 * Convert a DOMMatrix to a simple {a,b,c,d,e,f} object.
 *
 * Translation (e, f) is preserved so that Figma can reconstruct the
 * element's position relative to its parent — zeroing them previously
 * caused all CSS transform translations to be lost.
 */
export function matrixToSimple(matrix: DOMMatrix): SimpleMatrix {
  return {
    a: matrix.a,
    b: matrix.b,
    c: matrix.c,
    d: matrix.d,
    e: matrix.e,
    f: matrix.f,
  };
}

// ---------------------------------------------------------------------------
// Child node iteration (groups adjacent text nodes)
// ---------------------------------------------------------------------------

/**
 * Generator that yields child nodes, grouping adjacent text nodes together.
 */
export function* iterateChildNodes(parent: Node): Generator<Node | Node[]> {
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];

    if (child.nodeType === Node.TEXT_NODE) {
      const textGroup: Node[] = [child];
      let nextIndex = i + 1;

      while (
        nextIndex < parent.childNodes.length &&
        parent.childNodes[nextIndex].nodeType === Node.TEXT_NODE
      ) {
        textGroup.push(parent.childNodes[nextIndex]);
        nextIndex += 1;
      }

      yield textGroup;
      i = nextIndex - 1;
    } else {
      yield child;
    }
  }
}
