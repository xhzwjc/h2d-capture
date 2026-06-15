/**
 * Transform math and bounding rectangle utilities.
 *
 * Provides helpers for measuring DOM elements, parsing CSS individual
 * transform properties, building combined transform matrices, and
 * computing rotated quads for elements with non-trivial transforms.
 */

import type { Quad, ElementRect } from '../types.js';
import {
  getComputedStyleFor,
  getNodeDocument,
  isElementLike,
  isHtmlElement,
  isMathElement,
  isSvgGraphicsElement,
  isSvgSvgElement,
  isTextNode,
} from '../core/dom.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a DOMMatrix contains a rotation component.
 */
function hasRotation(matrix: DOMMatrix): boolean {
  return Math.abs(matrix.b) > 1e-6 || Math.abs(matrix.c) > 1e-6;
}

/**
 * Extract only the rotation (and scale/skew) part of a DOMMatrix by
 * zeroing out the translation components.
 */
function extractRotationMatrix(matrix: DOMMatrix): DOMMatrix {
  if (matrix.is2D) {
    return new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, 0, 0]);
  }

  const result = DOMMatrix.fromMatrix(matrix);
  result.m41 = 0;
  result.m42 = 0;
  result.m43 = 0;
  return result;
}

/**
 * Parse a CSS `transform-origin` value into a DOMPoint.
 */
function parseTransformOrigin(value: string | undefined): DOMPoint {
  const [tx, ty, tz] = value?.split(" ") ?? ["0px", "0px", "0px"];
  return new DOMPoint().matrixTransform(
    new DOMMatrix(`translate3d(${tx}, ${ty ?? "0px"}, ${tz ?? "0px"})`)
  );
}

/**
 * Apply a matrix transform to every corner of a DOMQuad.
 */
function transformQuad(quad: DOMQuad, matrix: DOMMatrix): DOMQuad {
  return new DOMQuad(
    quad.p1.matrixTransform(matrix),
    quad.p2.matrixTransform(matrix),
    quad.p3.matrixTransform(matrix),
    quad.p4.matrixTransform(matrix)
  );
}

/**
 * Return the center point of a DOMRect (or rect-like object).
 */
function getRectCenter(rect: { x: number; y: number; width: number; height: number }): DOMPoint {
  return new DOMPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Measure the CSS-level dimensions of any supported DOM node
 * (HTMLElement, SVGSVGElement, SVGGraphicsElement, MathMLElement, or Text).
 */
export function getElementDimensions(element: Element | Text): { width: number; height: number } {
  let width = 0;
  let height = 0;

  if (isHtmlElement(element)) {
    width = element.offsetWidth;
    height = element.offsetHeight;
  } else if (isSvgSvgElement(element)) {
    const computed = getComputedStyleFor(element);
    width = parseFloat(computed.width) || element.width.baseVal.value;
    height = parseFloat(computed.height) || element.height.baseVal.value;
  } else if (isSvgGraphicsElement(element)) {
    const bbox = element.getBBox();
    width = bbox.width;
    height = bbox.height;
  } else if (isMathElement(element)) {
    const clientRect = element.getBoundingClientRect();
    width = clientRect.width;
    height = clientRect.height;
  } else if (isTextNode(element)) {
    const range = getNodeDocument(element).createRange();
    range.selectNodeContents(element);
    const clientRect = range.getBoundingClientRect();
    width = clientRect.width;
    height = clientRect.height;
  }

  return { width, height };
}

/**
 * Parse a CSS `translate` property value into a DOMMatrix.
 */
export function parseTranslate(value: string | undefined): DOMMatrix {
  if (!value) return new DOMMatrix();

  const parts = value.trim().split(/\s+/);
  if (parts.length === 0) return new DOMMatrix();

  const x = parts[0];
  const y = parts[1] ?? "0px";
  const z = parts[2] ?? "0px";
  return new DOMMatrix(`translate3d(${x}, ${y}, ${z})`);
}

/**
 * Parse a CSS `scale` property value into a DOMMatrix.
 */
export function parseScale(value: string | undefined): DOMMatrix {
  if (!value) return new DOMMatrix();

  const parts = value.trim().split(/\s+/);
  if (parts.length === 0) return new DOMMatrix();
  if (parts.length > 3) throw new Error(`Invalid scale value: ${value}`);

  const x = parts[0];
  const y = parts[1] ?? parts[0];
  const z = parts[2] ?? 1;
  return new DOMMatrix(`scale3d(${x}, ${y}, ${z})`);
}

/**
 * Parse a CSS `rotate` property value into a DOMMatrix.
 *
 * Supports forms:
 *   "45deg"               - single angle
 *   "x 45deg"             - axis + angle
 *   "1 0 0 45deg"         - rotate3d(x, y, z, angle)
 */
export function parseRotate(value: string | undefined): DOMMatrix {
  if (!value) return new DOMMatrix();

  const parts = value.trim().split(/\s+/);
  if (parts.length === 0) return new DOMMatrix();

  if (parts.length === 1) {
    return new DOMMatrix(`rotate(${parts[0]})`);
  }

  if (parts.length === 2) {
    switch (parts[0]) {
      case "x":
        return new DOMMatrix(`rotateX(${parts[1]})`);
      case "y":
        return new DOMMatrix(`rotateY(${parts[1]})`);
      case "z":
        return new DOMMatrix(`rotateZ(${parts[1]})`);
      default:
        return new DOMMatrix();
    }
  }

  if (parts.length === 4) {
    return new DOMMatrix(
      `rotate3d(${parts[0]}, ${parts[1]}, ${parts[2]}, ${parts[3]})`
    );
  }

  return new DOMMatrix();
}

/**
 * Build the full transform matrix for an element from its individual CSS
 * transform properties (`translate`, `rotate`, `scale`, `transform`),
 * taking `transform-origin` into account.
 *
 * Returns `null` when no transform properties are set, or if the matrix
 * computation fails (e.g. malformed values).
 */
export function resolveTransform(computedStyle: CSSStyleDeclaration): DOMMatrix | null {
  if (
    !computedStyle.rotate &&
    !computedStyle.scale &&
    !computedStyle.transform &&
    !computedStyle.translate
  ) {
    return null;
  }

  try {
    const [ox, oy, oz] =
      computedStyle.transformOrigin?.split(" ") ?? ["0px", "0px", "0px"];

    const originMatrix = new DOMMatrix(
      `translate3d(${ox}, ${oy ?? "0px"}, ${oz ?? "0px"})`
    );

    return originMatrix
      .multiply(parseTranslate(computedStyle.translate))
      .multiply(parseRotate(computedStyle.rotate))
      .multiply(parseScale(computedStyle.scale))
      .multiply(new DOMMatrix(computedStyle.transform ?? "none"))
      .multiply(originMatrix.inverse());
  } catch (_error) {
    return null;
  }
}

/**
 * Optionally multiply two matrices together. Either or both may be
 * `undefined`/`null`. Returns the combined matrix, or `undefined` when
 * both inputs are falsy.
 */
export function multiplyMatrices(a: DOMMatrix | undefined | null, b: DOMMatrix | undefined | null): DOMMatrix | undefined {
  if (!a && !b) return undefined;
  if (a) return b ? a.multiply(b) : a;
  return b ?? undefined;
}

/**
 * Compute a bounding rect (and optional rotated quad) for an element.
 *
 * When the combined transform contains a rotation the result will include
 * a `quad` property describing the rotated four corners in viewport
 * coordinates.
 */
export function getElementRect(element: Element | Text, computedStyle: CSSStyleDeclaration, combinedTransform: DOMMatrix | undefined | null): ElementRect {
  const boundingRect = isElementLike(element)
    ? element.getBoundingClientRect()
    : (() => { const r = getNodeDocument(element).createRange(); r.selectNode(element); const rect = r.getBoundingClientRect(); r.detach(); return rect; })();
  let { x, y, width, height } = boundingRect;
  const dimensions = getElementDimensions(element);
  let cssWidth = dimensions.width;
  let cssHeight = dimensions.height;

  // For root elements (HTML, BODY), getBoundingClientRect may return only the
  // viewport size. Use scrollWidth/scrollHeight to get full document dimensions.
  // However, if an explicit CSS width is set (e.g. for mobile capture at 360px),
  // respect that instead of expanding to viewport/scroll size.
  if (isHtmlElement(element)) {
    const tag = element.tagName;
    if (tag === "HTML" || tag === "BODY") {
      const explicitWidth = element.style.getPropertyValue("max-width");
      const explicitPx = explicitWidth ? parseInt(explicitWidth, 10) : 0;

      if (explicitPx > 0) {
        // Explicit CSS override (e.g. mobile capture) — use it
        width = explicitPx;
        cssWidth = explicitPx;
      } else {
        const fullWidth = Math.max(element.scrollWidth, width);
        width = fullWidth;
        cssWidth = fullWidth;
      }

      const fullHeight = Math.max(element.scrollHeight, height);
      height = fullHeight;
      cssHeight = fullHeight;
    }
  }

  if (!combinedTransform || !hasRotation(combinedTransform)) {
    return { x, y, width, height, cssWidth, cssHeight };
  }

  try {
    const quad = computeRotatedQuad(element, computedStyle, combinedTransform);
    return { x, y, width, height, cssWidth, cssHeight, quad };
  } catch (_error) {
    return { x, y, width, height, cssWidth, cssHeight };
  }
}

/**
 * Compute a rotated quad for the element by reconstructing its untransformed
 * rectangle, applying the rotation around the transform origin, and
 * repositioning it to match the viewport bounding rect.
 */
export function computeRotatedQuad(element: Element | Text, computedStyle: CSSStyleDeclaration, combinedTransform: DOMMatrix): Quad {
  const boundingRect = isElementLike(element)
    ? element.getBoundingClientRect()
    : (() => { const r = getNodeDocument(element).createRange(); r.selectNode(element); const rect = r.getBoundingClientRect(); r.detach(); return rect; })();
  const dimensions = getElementDimensions(element);
  const elementWidth = dimensions.width;
  const elementHeight = dimensions.height;

  const origin = parseTransformOrigin(computedStyle.transformOrigin);

  // Build a quad centered on the transform origin (origin at 0,0)
  const localQuad = DOMQuad.fromQuad({
    p1: { x: -origin.x, y: -origin.y },
    p2: { x: elementWidth - origin.x, y: -origin.y },
    p3: { x: elementWidth - origin.x, y: elementHeight - origin.y },
    p4: { x: -origin.x, y: elementHeight - origin.y },
  });

  const rectCenter = getRectCenter(boundingRect);

  // Offset from rect center to the transform origin
  const originOffset = new DOMPoint(
    origin.x - elementWidth / 2,
    origin.y - elementHeight / 2
  );

  const rotationOnly = extractRotationMatrix(combinedTransform);

  // Transform the origin offset by the rotation matrix
  const transformedOffset = originOffset.matrixTransform(rotationOnly);

  // Rotate the local quad, then translate it into viewport coordinates
  const rotatedQuad = transformQuad(localQuad, rotationOnly);
  const translationMatrix = new DOMMatrix().translate(
    rectCenter.x + transformedOffset.x,
    rectCenter.y + transformedOffset.y
  );
  const finalQuad = transformQuad(rotatedQuad, translationMatrix);

  return {
    p1: { x: finalQuad.p1.x, y: finalQuad.p1.y },
    p2: { x: finalQuad.p2.x, y: finalQuad.p2.y },
    p3: { x: finalQuad.p3.x, y: finalQuad.p3.y },
    p4: { x: finalQuad.p4.x, y: finalQuad.p4.y },
  };
}
