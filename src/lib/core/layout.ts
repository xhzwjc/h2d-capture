/**
 * Layout sizing inference for Auto Layout hints.
 *
 * Determines FILL / HUG / FIXED sizing for each axis of an element,
 * used by the serializer to emit `layoutSizingHorizontal` and
 * `layoutSizingVertical` properties that Figma consumes.
 */

import type { LayoutSizing } from "../types.js";
import { getComputedStyleFor } from "./dom.js";

/**
 * Infer Figma Auto Layout sizing for a flex/grid child.
 *
 * Determines whether each axis should be FILL (stretch to parent),
 * HUG (shrink to content), or FIXED (explicit size).
 *
 * Heuristics (in priority order):
 * 1. flexGrow > 0 on main axis → FILL
 * 2. Declared width/height is percentage → FILL
 * 3. Wrapper detection: element has max-width + fills ≥95% of parent → FILL
 * 4. Centered wrapper: margin-left:auto + margin-right:auto → FILL
 * 5. align-items/self: stretch on cross axis → FILL
 * 6. Explicit pixel width/height → FIXED
 * 7. Otherwise → HUG
 */
export function inferLayoutSizing(
  element: Element,
  styles: Record<string, string>,
  parentElement: Element | null,
): { horizontal: LayoutSizing; vertical: LayoutSizing } {
  if (!parentElement) {
    return { horizontal: "HUG", vertical: "HUG" };
  }

  const parentComputed = getComputedStyleFor(parentElement);
  const parentDisplay = parentComputed.display;

  const isFlexChild =
    parentDisplay === "flex" || parentDisplay === "inline-flex";
  const isGridChild =
    parentDisplay === "grid" || parentDisplay === "inline-grid";

  if (!isFlexChild && !isGridChild) {
    // Block-level children: detect centered wrappers and full-width blocks
    return inferBlockLayoutSizing(element, styles, parentElement);
  }

  const computed = getComputedStyleFor(element);
  const styleMap =
    "computedStyleMap" in element
      ? (element as HTMLElement & { computedStyleMap(): StylePropertyMapReadOnly }).computedStyleMap()
      : null;

  // Determine parent flex direction
  const parentDirection = parentComputed.flexDirection || "row";
  const isRow = parentDirection === "row" || parentDirection === "row-reverse";

  // Read flex properties
  const flexGrow = parseFloat(styles.flexGrow || computed.flexGrow || "0");
  const alignSelf = styles.alignSelf || computed.alignSelf || "auto";
  const parentAlignItems = parentComputed.alignItems || "normal";

  // Effective cross-axis alignment
  const effectiveAlign =
    alignSelf !== "auto" ? alignSelf : parentAlignItems;
  const isStretch =
    effectiveAlign === "stretch" || effectiveAlign === "normal";

  // Check if width/height are declared as percentage or auto via computedStyleMap
  const widthRaw = styleMap?.get("width")?.toString() || "";
  const heightRaw = styleMap?.get("height")?.toString() || "";

  // Parent rect for ratio-based detection
  const parentRect = parentElement.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  // Wrapper detection helpers
  // Use computedStyleMap for margins to detect "auto" before it resolves to px
  const maxWidth = computed.maxWidth;
  const maxHeight = computed.maxHeight;
  const marginLeftRaw = styleMap?.get("margin-left")?.toString() || computed.marginLeft;
  const marginRightRaw = styleMap?.get("margin-right")?.toString() || computed.marginRight;
  const marginTopRaw = styleMap?.get("margin-top")?.toString() || computed.marginTop;
  const marginBottomRaw = styleMap?.get("margin-bottom")?.toString() || computed.marginBottom;

  // Main axis sizing
  let mainSizing: LayoutSizing;
  if (flexGrow > 0) {
    // Explicit flex-grow → always FILL
    mainSizing = "FILL";
  } else if (isRow && (widthRaw.endsWith("%"))) {
    mainSizing = "FILL";
  } else if (!isRow && (heightRaw.endsWith("%"))) {
    mainSizing = "FILL";
  } else if (isRow && isAdaptiveWrapper(elementRect.width, parentRect.width, maxWidth, marginLeftRaw, marginRightRaw)) {
    // Wrapper pattern: fills parent or is centered with max-width constraint
    mainSizing = "FILL";
  } else if (!isRow && isAdaptiveWrapper(elementRect.height, parentRect.height, maxHeight, marginTopRaw, marginBottomRaw)) {
    mainSizing = "FILL";
  } else if (isRow && widthRaw === "auto") {
    mainSizing = "HUG";
  } else if (!isRow && heightRaw === "auto") {
    mainSizing = "HUG";
  } else if (isRow && widthRaw && widthRaw !== "auto") {
    mainSizing = "FIXED";
  } else if (!isRow && heightRaw && heightRaw !== "auto") {
    mainSizing = "FIXED";
  } else {
    mainSizing = "HUG";
  }

  // Cross axis sizing
  let crossSizing: LayoutSizing;
  if (isStretch) {
    const crossRaw = isRow ? heightRaw : widthRaw;
    const crossElementSize = isRow ? elementRect.height : elementRect.width;
    const crossParentSize = isRow ? parentRect.height : parentRect.width;
    const crossMaxSize = isRow ? maxHeight : maxWidth;
    const crossMarginStart = isRow ? marginTopRaw : marginLeftRaw;
    const crossMarginEnd = isRow ? marginBottomRaw : marginRightRaw;

    if (!crossRaw || crossRaw === "auto" || crossRaw.endsWith("%")) {
      crossSizing = "FILL";
    } else if (isAdaptiveWrapper(crossElementSize, crossParentSize, crossMaxSize, crossMarginStart, crossMarginEnd)) {
      // Stretch + wrapper pattern (fills parent with constraints) → FILL
      crossSizing = "FILL";
    } else {
      crossSizing = "FIXED";
    }
  } else {
    const crossRaw = isRow ? heightRaw : widthRaw;
    // Check for wrapper pattern on cross axis too
    const crossMaxSize = isRow ? maxHeight : maxWidth;
    const crossMarginStart = isRow ? marginTopRaw : marginLeftRaw;
    const crossMarginEnd = isRow ? marginBottomRaw : marginRightRaw;
    const crossElementSize = isRow ? elementRect.height : elementRect.width;
    const crossParentSize = isRow ? parentRect.height : parentRect.width;

    if (crossRaw && crossRaw.endsWith("%")) {
      crossSizing = "FILL";
    } else if (isAdaptiveWrapper(crossElementSize, crossParentSize, crossMaxSize, crossMarginStart, crossMarginEnd)) {
      crossSizing = "FILL";
    } else if (crossRaw && crossRaw !== "auto") {
      crossSizing = "FIXED";
    } else {
      crossSizing = "HUG";
    }
  }

  // Map main/cross to horizontal/vertical
  if (isRow) {
    return { horizontal: mainSizing, vertical: crossSizing };
  } else {
    return { horizontal: crossSizing, vertical: mainSizing };
  }
}

/**
 * Detect "adaptive wrapper" pattern: an element that has a fixed pixel size
 * but is effectively adaptive because of max-width constraints, auto margins
 * (centering), or because it fills ≥95% of its parent.
 *
 * Common patterns this catches:
 * - `.container { width: 1200px; max-width: 100%; margin: 0 auto; }`
 * - `.wrapper { width: 1200px; max-width: 1920px; }` inside a full-width flex
 * - Single child that fills the parent (width ≈ parent width)
 */
function isAdaptiveWrapper(
  elementSize: number,
  parentSize: number,
  maxSize: string,
  marginStart: string,
  marginEnd: string,
): boolean {
  if (parentSize <= 0) return false;

  const ratio = elementSize / parentSize;
  const isCentered = marginStart === "auto" || marginEnd === "auto";
  const hasMaxConstraint =
    maxSize && maxSize !== "none" && maxSize !== "0px";

  // Pattern 1: centered wrapper (margin: 0 auto) — always adaptive
  if (isCentered) return true;

  // Pattern 2: element with max-width that fills ≥90% of parent
  if (hasMaxConstraint && ratio >= 0.9) return true;

  // Pattern 3: element fills ≥95% of parent (no matter what CSS says,
  // it's behaving as fill). But only if parent is reasonably large.
  if (ratio >= 0.95 && parentSize >= 200) return true;

  return false;
}

/**
 * Infer sizing for block-level children (not inside flex/grid).
 *
 * Block-level elements have different sizing semantics:
 * - `display: block` without explicit width → fills parent width (FILL)
 * - `margin: 0 auto` with explicit width → centered wrapper (FILL)
 * - Explicit pixel width without centering → FIXED
 * - Height is almost always HUG (content-driven) in block flow
 */
function inferBlockLayoutSizing(
  element: Element,
  styles: Record<string, string>,
  parentElement: Element,
): { horizontal: LayoutSizing; vertical: LayoutSizing } {
  const computed = getComputedStyleFor(element);
  const styleMap =
    "computedStyleMap" in element
      ? (element as HTMLElement & { computedStyleMap(): StylePropertyMapReadOnly }).computedStyleMap()
      : null;

  const widthRaw = styleMap?.get("width")?.toString() || "";
  const marginLeftRaw = styleMap?.get("margin-left")?.toString() || computed.marginLeft;
  const marginRightRaw = styleMap?.get("margin-right")?.toString() || computed.marginRight;
  const maxWidth = computed.maxWidth;
  const display = computed.display;

  const parentRect = parentElement.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  let horizontal: LayoutSizing;

  // Block elements without explicit width fill their parent by default
  if (display === "block" || display === "list-item" || display === "table") {
    if (widthRaw === "auto" || !widthRaw) {
      horizontal = "FILL";
    } else if (widthRaw.endsWith("%")) {
      horizontal = "FILL";
    } else if (isAdaptiveWrapper(elementRect.width, parentRect.width, maxWidth, marginLeftRaw, marginRightRaw)) {
      horizontal = "FILL";
    } else {
      horizontal = "FIXED";
    }
  } else {
    // Inline, inline-block, etc.
    horizontal = "HUG";
  }

  // In block flow, height is almost always content-driven
  return { horizontal, vertical: "HUG" };
}
