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
export type SvgSpriteCache = Map<string, Document>;

export async function preloadExternalSvgSprites(root: ParentNode): Promise<SvgSpriteCache> {
  const urls = getExternalSvgSpriteUrls(root);
  const cache: SvgSpriteCache = new Map();

  await Promise.all(
    urls.map(async (url) => {
      const doc = await fetchSvgSpriteDocument(url);
      if (doc) cache.set(url, doc);
    }),
  );

  return cache;
}

export function bakeSvgStyles(svgElement: SVGElement, spriteCache?: SvgSpriteCache): string {
  const clone = svgElement.cloneNode(true) as SVGElement;

  copySvgComputedStyles(svgElement, clone);
  inlineSvgUseReferences(svgElement, clone, spriteCache);
  replaceCurrentColorReferences(clone);

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

const SVG_NS = "http://www.w3.org/2000/svg";
const HREF_ATTRS = new Set(["href", "xlink:href"]);
const CURRENT_COLOR_ATTRS = ["fill", "stroke", "stop-color", "flood-color", "lighting-color"];
const SPRITE_FETCH_TIMEOUT_MS = 1_500;

function getExternalSvgSpriteUrls(root: ParentNode): string[] {
  if (!("querySelectorAll" in root)) return [];

  const urls = new Set<string>();
  for (const use of Array.from(root.querySelectorAll("svg use, use"))) {
    const href = getRawUseHref(use);
    const reference = href ? parseExternalUseReference(href, use.ownerDocument) : null;
    if (reference) urls.add(reference.url);
  }

  return Array.from(urls).slice(0, 24);
}

async function fetchSvgSpriteDocument(url: string): Promise<Document | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPRITE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      credentials: "include",
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") return null;
    return doc;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function replaceCurrentColorReferences(element: Element, inheritedColor?: string): void {
  const color = getInlineSvgColor(element) || inheritedColor;

  for (const attr of CURRENT_COLOR_ATTRS) {
    if (element.getAttribute(attr)?.trim().toLowerCase() === "currentcolor" && color) {
      element.setAttribute(attr, color);
    }
  }

  const style = element.getAttribute("style");
  if (style && /currentColor/i.test(style) && color) {
    element.setAttribute("style", style.replace(/currentColor/gi, color));
  }

  for (const child of Array.from(element.children)) {
    replaceCurrentColorReferences(child, color);
  }
}

function getInlineSvgColor(element: Element): string | undefined {
  const colorAttr = element.getAttribute("color");
  if (colorAttr && colorAttr.trim().toLowerCase() !== "currentcolor") {
    return colorAttr.trim();
  }

  const styleColor = (element as HTMLElement | SVGElement).style?.color;
  if (styleColor && styleColor.trim().toLowerCase() !== "currentcolor") {
    return styleColor.trim();
  }

  return undefined;
}

function inlineSvgUseReferences(sourceSvg: SVGElement, cloneSvg: SVGElement, spriteCache?: SvgSpriteCache): void {
  const sourceUses = Array.from(sourceSvg.querySelectorAll("use"));
  const cloneUses = Array.from(cloneSvg.querySelectorAll("use"));

  for (let index = 0; index < sourceUses.length; index += 1) {
    const sourceUse = sourceUses[index];
    const cloneUse = cloneUses[index];
    if (!sourceUse || !cloneUse) continue;

    inlineSingleUseReference(sourceUse, cloneUse, cloneSvg, spriteCache);
  }
}

function inlineSingleUseReference(
  sourceUse: SVGUseElement,
  cloneUse: SVGUseElement,
  cloneSvg: SVGElement,
  spriteCache?: SvgSpriteCache,
): void {
  const href = getUseHref(sourceUse);
  if (!href) return;

  const referenced = resolveUseReference(sourceUse, href, spriteCache);
  if (!referenced || !isElementNode(referenced)) return;

  const group = cloneUse.ownerDocument.createElementNS(SVG_NS, "g");
  copyUseAttributes(cloneUse, group);
  applyUseTranslation(sourceUse, group);
  copyReferencedContent(referenced, group);

  if (!cloneSvg.hasAttribute("viewBox")) {
    const viewBox = referenced.getAttribute("viewBox");
    if (viewBox) cloneSvg.setAttribute("viewBox", viewBox);
  }

  cloneUse.replaceWith(group);
}

function resolveUseReference(
  sourceUse: SVGUseElement,
  href: string,
  spriteCache?: SvgSpriteCache,
): Element | null {
  if (href.startsWith("#")) {
    return sourceUse.ownerDocument.getElementById(href.slice(1));
  }

  const reference = parseExternalUseReference(href, sourceUse.ownerDocument);
  if (!reference) return null;

  return spriteCache?.get(reference.url)?.getElementById(reference.id) ?? null;
}

function parseExternalUseReference(href: string, doc: Document): { url: string; id: string } | null {
  const hashIndex = href.indexOf("#");
  if (hashIndex <= 0 || hashIndex === href.length - 1) return null;

  const urlPart = href.slice(0, hashIndex);
  const id = href.slice(hashIndex + 1);
  if (!urlPart || !id) return null;

  try {
    return {
      url: new URL(urlPart, doc.baseURI || doc.location?.href || window.location.href).href,
      id: decodeURIComponent(id),
    };
  } catch {
    return null;
  }
}

function getUseHref(use: SVGUseElement): string | null {
  return (
    use.getAttribute("href") ||
    use.getAttribute("xlink:href") ||
    use.href?.baseVal ||
    null
  );
}

function getRawUseHref(use: Element): string | null {
  return (
    use.getAttribute("href") ||
    use.getAttribute("xlink:href") ||
    null
  );
}

function copyUseAttributes(source: SVGUseElement, target: SVGElement): void {
  for (const attr of Array.from(source.attributes)) {
    if (HREF_ATTRS.has(attr.name)) continue;
    if (attr.name === "x" || attr.name === "y" || attr.name === "width" || attr.name === "height") continue;
    target.setAttribute(attr.name, attr.value);
  }
}

function applyUseTranslation(sourceUse: SVGUseElement, group: SVGElement): void {
  const x = parseFloat(sourceUse.getAttribute("x") || "0");
  const y = parseFloat(sourceUse.getAttribute("y") || "0");
  if ((!Number.isFinite(x) || x === 0) && (!Number.isFinite(y) || y === 0)) return;

  const existing = group.getAttribute("transform");
  const translate = `translate(${Number.isFinite(x) ? x : 0} ${Number.isFinite(y) ? y : 0})`;
  group.setAttribute("transform", existing ? `${translate} ${existing}` : translate);
}

function copyReferencedContent(referenced: Element, group: SVGElement): void {
  const tag = referenced.tagName.toLowerCase();
  const sourceNodes = tag === "symbol" || tag === "svg" || tag === "g"
    ? Array.from(referenced.childNodes)
    : [referenced];

  for (const node of sourceNodes) {
    group.appendChild(node.cloneNode(true));
  }
}

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
    const cssProperty = kebabNames[property];
    const value =
      computedStyle.getPropertyValue(cssProperty) ||
      computedStyle.getPropertyValue(property) ||
      String((computedStyle as unknown as Record<string, string>)[property] || "");
    if (value && value.toLowerCase() !== defaultValue.toLowerCase()) {
      target.setAttribute(cssProperty, value);
    }
  }

  for (let i = 0; i < source.childNodes.length; i++) {
    copySvgComputedStyles(source.childNodes[i], target.childNodes[i]);
  }
}
