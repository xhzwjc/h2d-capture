import { getComputedStyleFor, isElementNode } from '../core/dom.js';

/**
 * SVG serialization utilities.
 *
 * Clones an SVG element and inlines all computed styles that differ from
 * browser defaults so the serialized markup is self-contained.
 */

// ---------------------------------------------------------------------------
// Style defaults & camelCase-to-kebab mapping
// ---------------------------------------------------------------------------

/**
 * Default values for SVG-relevant CSS properties.
 *
 * Only properties whose computed value differs from these defaults will
 * be inlined as attributes on the cloned SVG elements.
 */
export const SVG_STYLE_DEFAULTS: Record<string, string> = {
  alignmentBaseline: "baseline",
  clip: "auto",
  clipPath: "none",
  clipRule: "nonzero",
  color: "rgb(0, 0, 0)",
  colorInterpolation: "sRGB",
  colorRendering: "auto",
  cursor: "auto",
  direction: "ltr",
  display: "inline",
  dominantBaseline: "auto",
  fill: "rgb(0, 0, 0)",
  fillOpacity: "1",
  fillRule: "nonzero",
  filter: "none",
  floodColor: "rgb(0, 0, 0)",
  floodOpacity: "1",
  imageRendering: "auto",
  letterSpacing: "normal",
  lightingColor: "rgb(255, 255, 255)",
  lineHeight: "normal",
  markerEnd: "none",
  markerMid: "none",
  markerStart: "none",
  mask: "none",
  opacity: "1",
  overflow: "visible",
  paintOrder: "normal",
  shapeRendering: "auto",
  stopColor: "rgb(0, 0, 0)",
  stopOpacity: "1",
  stroke: "none",
  strokeDasharray: "none",
  strokeDashoffset: "0px",
  strokeLinecap: "butt",
  strokeLinejoin: "miter",
  strokeMiterlimit: "4",
  strokeOpacity: "1",
  strokeWidth: "1px",
  textAnchor: "start",
  textDecoration: "none solid rgb(0, 0, 0)",
  textRendering: "auto",
  unicodeBidi: "normal",
  vectorEffect: "none",
  visibility: "visible",
  whiteSpace: "normal",
  writingMode: "horizontal-tb",
};

/**
 * Build a map from camelCase property names to their kebab-case equivalents.
 */
function camelToKebabMap(keys: string[]): Record<string, string> {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      key.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase(),
    ]),
  );
}

/** Pre-computed kebab-case attribute names for every key in SVG_STYLE_DEFAULTS. */
const kebabNames = camelToKebabMap(Object.keys(SVG_STYLE_DEFAULTS));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deep-clone an SVG element and inline all computed styles that differ
 * from browser defaults, returning the resulting outer HTML string.
 *
 * If the SVG has explicit pixel dimensions in the computed style those
 * are also propagated to the `width` / `height` attributes of the clone
 * so that the serialized SVG renders at the correct intrinsic size.
 */
export function bakeSvgStyles(svgElement: SVGElement): string {
  const clone = svgElement.cloneNode(true) as SVGElement;

  copySvgComputedStyles(svgElement, clone);

  const { width, height } = getComputedStyleFor(svgElement);
  if (width.endsWith("px") && height.endsWith("px")) {
    clone.setAttribute("width", width);
    clone.setAttribute("height", height);
  }

  return clone.outerHTML;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Recursively copy non-default computed style values from `source` to
 * `target` as presentation attributes.
 *
 * Only SVG_STYLE_DEFAULTS properties are considered.
 */
function copySvgComputedStyles(source: Node, target: Node): void {
  if (!isElementNode(source) || !isElementNode(target)) return;

  const computedStyle = getComputedStyleFor(source);

  for (const [property, defaultValue] of Object.entries(SVG_STYLE_DEFAULTS)) {
    const value = computedStyle.getPropertyValue(property);
    if (value && value.toLowerCase() !== defaultValue.toLowerCase()) {
      target.setAttribute(kebabNames[property], value);
    }
  }

  for (let i = 0; i < source.childNodes.length; i++) {
    copySvgComputedStyles(source.childNodes[i], target.childNodes[i]);
  }
}
