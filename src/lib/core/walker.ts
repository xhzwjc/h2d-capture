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

  const computed = getComputedStyleFor(element);

  // display:none — element and all descendants are invisible
  if (computed.display === "none") return false;

  // visibility:hidden — element is invisible (children may override, but
  // Figma can't represent that, so skip the subtree)
  if (computed.visibility === "hidden") return false;

  return true;
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
      return true;
    }
  }

  return false;
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

  // Ensure input type is always present.
  if (isInstanceOfOwner<HTMLInputElement>(element, element, "HTMLInputElement") && attrs.type == null) {
    attrs.type = element.type;
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
