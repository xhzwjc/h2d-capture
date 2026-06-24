/**
 * CSS style diffing and flex/grid property augmentation.
 *
 * Diffs an element's computed styles against browser defaults and ensures
 * flex/grid layout properties are always present for Auto Layout consumption.
 */

import { BASELINE_STYLES } from './css-defaults.js';
import { getComputedStyleFor } from './dom.js';

export { BASELINE_STYLES };

// ---------------------------------------------------------------------------
// Border property groups
// ---------------------------------------------------------------------------

/** Border property groups for pruning zero-width borders. */
export const BORDER_GROUPS = [
  { style: "borderTopStyle", width: "borderTopWidth", color: "borderTopColor" },
  { style: "borderRightStyle", width: "borderRightWidth", color: "borderRightColor" },
  { style: "borderBottomStyle", width: "borderBottomWidth", color: "borderBottomColor" },
  { style: "borderLeftStyle", width: "borderLeftWidth", color: "borderLeftColor" },
] as const;

// ---------------------------------------------------------------------------
// Style diffing
// ---------------------------------------------------------------------------

/**
 * Compute the diff between an element's computed style and BASELINE_STYLES.
 *
 * Only properties whose value differs from the default are included. For
 * `width` and `height`, the computedStyleMap is consulted to avoid false
 * diffs when the computed value resolves to "auto".
 */
export function diffStyles(element: Element, pseudo?: string): Record<string, string> {
  const diff: Record<string, string> = {};
  const computed = getComputedStyleFor(element, pseudo);
  const styleMap =
    "computedStyleMap" in element && !pseudo ? (element as HTMLElement & { computedStyleMap(): StylePropertyMapReadOnly }).computedStyleMap() : null;

  // Compare each tracked property against its default.
  for (const [property, defaultValue] of Object.entries(BASELINE_STYLES)) {
    const value = computed.getPropertyValue(property) || (computed as unknown as Record<string, string>)[property];
    const normalizedValue = normalizeCssColorFunctions(value);
    const normalizedDefault = normalizeCssColorFunctions(defaultValue);
    if (normalizedValue !== normalizedDefault) {
      diff[property] = normalizedValue;
    }
  }

  // For width/height, use computedStyleMap to check if the value is actually "auto".
  for (const dimension of ["width", "height"]) {
    const mapped = styleMap?.get(dimension)?.toString();
    if (mapped && mapped === BASELINE_STYLES[dimension]) {
      delete diff[dimension];
    }
  }

  // Strip border style/color when the border width is zero (no visible border).
  for (const group of BORDER_GROUPS) {
    if (diff[group.width] == null) {
      delete diff[group.style];
      delete diff[group.color];
    }
  }

  // Same for outline.
  if (diff.outlineWidth == null) {
    delete diff.outlineStyle;
    delete diff.outlineColor;
  }

  return diff;
}

export function normalizeCssColorFunctions(value: string): string {
  if (!value || !value.includes("color(")) return value;

  return value.replace(
    /color\(\s*srgb\s+([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?%?)\s+([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?%?)\s+([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?%?)(?:\s*\/\s*([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?%?))?\s*\)/gi,
    (_match, red: string, green: string, blue: string, alpha: string | undefined) => {
      const r = Math.round(clampCssColorComponent(red) * 255);
      const g = Math.round(clampCssColorComponent(green) * 255);
      const b = Math.round(clampCssColorComponent(blue) * 255);
      const a = alpha == null ? 1 : clampCssAlpha(alpha);
      return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${roundCssAlpha(a)})`;
    },
  );
}

function clampCssColorComponent(value: string): number {
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  const normalized = value.trim().endsWith("%") ? parsed / 100 : parsed;
  return Math.min(1, Math.max(0, normalized));
}

function clampCssAlpha(value: string): number {
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return 1;
  const normalized = value.trim().endsWith("%") ? parsed / 100 : parsed;
  return Math.min(1, Math.max(0, normalized));
}

function roundCssAlpha(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Flex/Grid style augmentation
// ---------------------------------------------------------------------------

/** Properties that must always be present on flex containers for Figma. */
export const FLEX_CONTAINER_PROPS = [
  "flexDirection", "flexWrap", "justifyContent", "alignItems",
  "alignContent", "columnGap", "rowGap", "gap",
] as const;

/** Properties that must always be present on flex/grid children for Figma. */
export const FLEX_ITEM_PROPS = [
  "flexGrow", "flexShrink", "flexBasis", "alignSelf", "order",
] as const;

/** Properties that must always be present on grid containers for Figma. */
export const GRID_CONTAINER_PROPS = [
  "gridTemplateColumns", "gridTemplateRows", "gridAutoFlow",
  "gridAutoColumns", "gridAutoRows", "gridTemplateAreas",
  "columnGap", "rowGap", "gap",
] as const;

/**
 * Ensure all flex container properties are present in the style diff,
 * even if they match browser defaults. Figma needs these to know
 * the element is a flex container and how it lays out children.
 */
export function ensureFlexProps(element: Element, styles: Record<string, string>): void {
  const computed = getComputedStyleFor(element);
  for (const prop of FLEX_CONTAINER_PROPS) {
    if (!(prop in styles)) {
      styles[prop] = computed.getPropertyValue(
        prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
      ) || BASELINE_STYLES[prop] || "";
    }
  }
}

/**
 * Ensure all grid container properties are present in the style diff.
 */
export function ensureGridProps(element: Element, styles: Record<string, string>): void {
  const computed = getComputedStyleFor(element);
  for (const prop of GRID_CONTAINER_PROPS) {
    if (!(prop in styles)) {
      styles[prop] = computed.getPropertyValue(
        prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
      ) || BASELINE_STYLES[prop] || "";
    }
  }
}

/**
 * Ensure flex/grid item properties are present for children of flex/grid containers.
 */
export function ensureFlexItemProps(element: Element, styles: Record<string, string>): void {
  const computed = getComputedStyleFor(element);
  for (const prop of FLEX_ITEM_PROPS) {
    if (!(prop in styles)) {
      styles[prop] = computed.getPropertyValue(
        prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
      ) || BASELINE_STYLES[prop] || "";
    }
  }
}
