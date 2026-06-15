/**
 * DOM snapshot engine — orchestrates the capture pipeline.
 */

import { getSourceAnnotations, getInspectorSelectedId } from '../react/fiber.js';
import { TypefaceProbe, resolveFonts } from '../typography/probe.js';
import { ResourceResolver, CaptureError, resolveResources, canvasToBlob } from '../media/resolver.js';
import { bakeSvgStyles } from '../media/svg.js';
import { resolveTransform, multiplyMatrices, getElementRect } from '../transform/matrix.js';
import { extractComponentTree, findParentComponent } from '../react/tree.js';
import { inferLayoutSizing } from './layout.js';
import { NODE_TYPES, isNodeVisible, shouldPruneNode, iterateChildNodes, getTextRect, getElementAttributes, matrixToSimple, INPUT_TYPES_WITH_PLACEHOLDER } from './walker.js';
import { diffStyles, ensureFlexProps, ensureGridProps, ensureFlexItemProps, BASELINE_STYLES } from './styles.js';
import { prepareForCapture, decodeImages, assertLayoutValid, resetScrollbarState, cleanupScrollbar } from './prepare.js';
import { getDeclaredLayoutStyles } from './declared.js';
import { getComputedStyleFor, getNodeDocument, getNodeWindow, isInstanceOfOwner } from './dom.js';
import type {
  CaptureTree,
  SnapshotNode,
  ElementSnapshot,
  TextSnapshot,
  CaptureOptions,
  CaptureContext,
  SimpleMatrix,
  SourceAnnotation,
} from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CAPTURE_TIMEOUT = 10000;

export const DEFAULT_CONFIG: Required<Omit<CaptureOptions, 'timeoutSignal'>> = {
  assertLayoutValid: true,
  skipRemoteAssetSerialization: false,
  includeReactFiberTree: false,
  captureDeclaredStyles: false,
};

const LAYOUT_STYLE_PROPS = [
  "display",
  "flexDirection",
  "flexWrap",
  "justifyContent",
  "alignItems",
  "alignContent",
  "columnGap",
  "rowGap",
  "gap",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "alignSelf",
  "order",
  "gridTemplateColumns",
  "gridTemplateRows",
  "gridAutoFlow",
  "gridAutoColumns",
  "gridAutoRows",
  "gridTemplateAreas",
  "gridColumnStart",
  "gridColumnEnd",
  "gridRowStart",
  "gridRowEnd",
  "gridColumn",
  "gridRow",
] as const;

const CONTROL_LIKE_CLASS_PATTERN =
  /(^|[-_\s])(select|selector|dropdown|picker|cascader|combobox|autocomplete|input|textarea)([-_\s]|$)/i;
const CONTROL_LIKE_ROLES = new Set([
  "combobox",
  "listbox",
  "searchbox",
  "spinbutton",
  "textbox",
]);
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

// ---------------------------------------------------------------------------
// Node ID tracking
// ---------------------------------------------------------------------------

let nodeIdCounter = 0;
const nodeIdMap = new WeakMap<Node, string>();

/**
 * Generate or retrieve a unique h2d node ID for a DOM node.
 */
function generateNodeId(node: Node | null): string {
  if (node !== null) {
    const existing = nodeIdMap.get(node);
    if (existing) return existing;
  }
  const id = `h2d-node-${++nodeIdCounter}`;
  if (node !== null) nodeIdMap.set(node, id);
  return id;
}

/**
 * Retrieve the h2d node ID for an element without generating a new one.
 */
export function getNodeId(element: Node): string | undefined {
  return nodeIdMap.get(element);
}

// ---------------------------------------------------------------------------
// requestAnimationFrame helper
// ---------------------------------------------------------------------------

/**
 * Schedule a callback in a requestAnimationFrame, honouring an AbortSignal.
 */
function safeRequestAnimationFrame(callback: (timestamp: number) => void, signal: AbortSignal): void {
  if (signal.aborted) return;

  const frameId = requestAnimationFrame((timestamp) => {
    if (!signal.aborted) callback(timestamp);
  });

  signal.addEventListener("abort", () => cancelAnimationFrame(frameId), {
    once: true,
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Serialize a DOM element or document into a capture tree.
 */
export async function captureDOM(elementOrDocument: Element | Document, options?: CaptureOptions): Promise<CaptureTree> {
  const mergedOptions = { ...DEFAULT_CONFIG, ...options };
  const ctx: CaptureContext = {
    captureDeclaredStyles: mergedOptions.captureDeclaredStyles === true,
    declaredStylesCache: mergedOptions.captureDeclaredStyles ? new Map() : undefined,
  };

  assertLayoutValid(mergedOptions);
  nodeIdCounter = 0;
  resetScrollbarState();

  const assetCollector = new ResourceResolver(mergedOptions);
  const fontCollector = new TypefaceProbe();

  try {
    return await captureDOMInner(elementOrDocument, mergedOptions, ctx, assetCollector, fontCollector);
  } finally {
    cleanupScrollbar();
  }
}

async function captureDOMInner(
  elementOrDocument: Element | Document,
  mergedOptions: Required<Omit<CaptureOptions, 'timeoutSignal'>> & CaptureOptions,
  ctx: CaptureContext,
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
): Promise<CaptureTree> {

  if (elementOrDocument.nodeType === Node.ELEMENT_NODE) {
    const element = elementOrDocument as Element;
    const ownerDoc = getNodeDocument(element);
    const ownerWindow = getNodeWindow(element);

    // Scroll through the page to trigger lazy-loaded images
    await prepareForCapture(element);
    await decodeImages(Array.from(element.querySelectorAll("img")));

    const serialized = await snapshotInAnimationFrame(
      element,
      assetCollector,
      fontCollector,
      mergedOptions,
      ctx,
    );

    const blobMap = await assetCollector.getBlobMap();
    const fonts = fontCollector.getFonts();
    const { width, height } = element.getBoundingClientRect();

    if (!serialized || serialized.nodeType !== NODE_TYPES.ELEMENT_NODE) {
      throw new Error("Container node could not be serialized");
    }

    const experimental = mergedOptions.includeReactFiberTree
      ? { reactFiberTree: extractComponentTree(element, getNodeId) }
      : undefined;

    return {
      root: serialized as ElementSnapshot,
      documentTitle: ownerDoc.title || undefined,
      experimental,
      documentRect: {
        x: 0,
        y: 0,
        width: element.scrollWidth,
        height: element.scrollHeight,
      },
      viewportRect: {
        x: element.scrollLeft,
        y: element.scrollTop,
        width,
        height,
      },
      devicePixelRatio: ownerWindow.devicePixelRatio,
      assets: blobMap,
      fonts,
    };
  } else if (elementOrDocument.nodeType === Node.DOCUMENT_NODE) {
    const doc = elementOrDocument as Document;
    const ownerWindow = doc.defaultView ?? window;

    await prepareForCapture(doc.documentElement);
    await decodeImages(Array.from(doc.images));

    const serialized = await snapshotInAnimationFrame(
      doc.documentElement,
      assetCollector,
      fontCollector,
      mergedOptions,
      ctx,
    );

    const blobMap = await assetCollector.getBlobMap();
    const fonts = fontCollector.getFonts();

    if (!serialized || serialized.nodeType !== NODE_TYPES.ELEMENT_NODE) {
      throw new Error("Container node must have a body element");
    }

    const experimental = mergedOptions.includeReactFiberTree
      ? { reactFiberTree: extractComponentTree(doc.documentElement, getNodeId) }
      : undefined;

    return {
      documentTitle: doc.title || undefined,
      root: serialized as ElementSnapshot,
      experimental,
      documentRect: {
        x: 0,
        y: 0,
        width: doc.documentElement.scrollWidth,
        height: doc.documentElement.scrollHeight,
      },
      viewportRect: {
        x: 0,
        y: 0,
        width: ownerWindow.innerWidth,
        height: ownerWindow.innerHeight,
      },
      devicePixelRatio: ownerWindow.devicePixelRatio,
      assets: blobMap,
      fonts,
    };
  }

  throw new Error("Container node must be an Element or Document");
}

// ---------------------------------------------------------------------------
// Animation-frame serialization
// ---------------------------------------------------------------------------

/**
 * Schedule the DOM tree walk inside a requestAnimationFrame and apply a
 * timeout via an AbortSignal.
 */
function snapshotInAnimationFrame(
  element: Element,
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
  options: CaptureOptions,
  ctx: CaptureContext,
): Promise<SnapshotNode | null> {
  assertLayoutValid(options);

  const signal = options.timeoutSignal ?? AbortSignal.timeout(CAPTURE_TIMEOUT);

  return new Promise((resolve, reject) => {
    safeRequestAnimationFrame(
      () => resolve(snapshotNode(element, assetCollector, fontCollector, undefined, ctx)),
      signal,
    );

    signal.addEventListener(
      "abort",
      () => reject(new CaptureError("requestAnimationFrame timed out", "PAGE_NOT_RESPONDING")),
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// Node dispatcher
// ---------------------------------------------------------------------------

/**
 * Serialize a single DOM node, dispatching to element or text serializers.
 */
function snapshotNode(
  node: Node | Node[],
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
  parentTransform: DOMMatrix | undefined,
  ctx: CaptureContext,
): SnapshotNode | null {
  if (Array.isArray(node) || node.nodeType === Node.TEXT_NODE) {
    return snapshotTextNode(node);
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    return snapshotElement(node as Element, assetCollector, fontCollector, parentTransform, ctx);
  }

  if (node.nodeType !== Node.COMMENT_NODE) {
    console.warn(`Unsupported node type: ${node.nodeType}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Element serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a single DOM element into the capture node format.
 */
function snapshotElement(
  element: Element,
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
  parentTransform: DOMMatrix | undefined,
  ctx: CaptureContext,
): ElementSnapshot | null {
  const childNodes: SnapshotNode[] = [];
  let svgContent: string | undefined;
  let placeholderUrl: string | undefined;
  let selectionSourceId: string | undefined;
  let expandedIframe = false;

  if (!isNodeVisible(element)) return null;

  const tag = element.tagName.toUpperCase();

  // Skip non-visual elements entirely.
  if (tag === "HEAD" || tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
    return null;
  }

  // Source annotations from React/Figma instrumentation.
  const sources = getSourceAnnotations(element);
  if (sources && sources.length > 0) {
    // If there is exactly one text child with a source annotation, wrap it.
    if (sources[0]?.type === "text" && element.childNodes.length === 1) {
      const textNode = snapshotTextNode(element.childNodes[0]);
      (textNode as TextSnapshot & { sources?: SourceAnnotation[] }).sources = sources;
      return textNode as unknown as ElementSnapshot;
    }
    selectionSourceId = getInspectorSelectedId(element);
  }

  // Computed style diff vs defaults.
  const computedStyles = diffStyles(element);
  ensureFormControlAppearance(element, computedStyles);

  // Browser propagates body background to the viewport when html has no background.
  // Replicate this so Figma shows the correct background on the root frame.
  if (tag === "HTML" && !computedStyles.backgroundColor && !computedStyles.backgroundImage) {
    const body = getNodeDocument(element).body;
    const bodyBg = body ? getComputedStyleFor(body).backgroundColor : "";
    if (bodyBg && bodyBg !== "rgba(0, 0, 0, 0)") {
      computedStyles.backgroundColor = bodyBg;
    }
  }

  // For flex/grid containers, always include layout properties even if they
  // match browser defaults — Figma needs them to reconstruct the layout.
  const displayValue = computedStyles.display;
  if (displayValue === "flex" || displayValue === "inline-flex") {
    ensureFlexProps(element, computedStyles);
  } else if (displayValue === "grid" || displayValue === "inline-grid") {
    ensureGridProps(element, computedStyles);
  }

  // For flex/grid children, always include item-level properties.
  const parentDisplay = element.parentElement
    ? getComputedStyleFor(element.parentElement).display
    : "";
  if (
    parentDisplay === "flex" || parentDisplay === "inline-flex" ||
    parentDisplay === "grid" || parentDisplay === "inline-grid"
  ) {
    ensureFlexItemProps(element, computedStyles);
  }

  // Declared grid styles (if enabled).
  const declaredStyles =
    ctx?.captureDeclaredStyles === true && ctx.declaredStylesCache
      ? getDeclaredLayoutStyles(element, ctx.declaredStylesCache)
      : {};

  // Transform matrix.
  const elementTransform = resolveTransform(computedStyles as unknown as CSSStyleDeclaration);
  const combinedTransform = multiplyMatrices(parentTransform, elementTransform);

  // SVG: serialize inline; Canvas: rasterize; otherwise: recurse children.
  if (isInstanceOfOwner<SVGElement>(element, element, "SVGElement")) {
    svgContent = bakeSvgStyles(element);
  } else if (isInstanceOfOwner<HTMLCanvasElement>(element, element, "HTMLCanvasElement")) {
    placeholderUrl = assetCollector.addCanvas(element);
  } else if (!snapshotIframeDocument(element, assetCollector, fontCollector, ctx, childNodes)) {
    const root = element.shadowRoot ?? element;
    for (const childOrGroup of iterateChildNodes(root)) {
      const serialized = snapshotNode(childOrGroup, assetCollector, fontCollector, combinedTransform, ctx);
      if (serialized != null) childNodes.push(serialized);
    }
  } else {
    expandedIframe = true;
    computedStyles.overflow = computedStyles.overflow || "hidden";
  }

  // Pseudo-element styles (::before, ::after, ::placeholder).
  let pseudoElementStyles: Record<string, Record<string, string>> | undefined;

  // ::before / ::after — capture when they have visible content
  for (const pseudo of ["::before", "::after"] as const) {
    const pseudoComputed = getComputedStyleFor(element, pseudo);
    const contentValue = pseudoComputed.content;
    if (contentValue && contentValue !== "none" && contentValue !== "normal") {
      if (!pseudoElementStyles) pseudoElementStyles = {};
      const styles = diffStyles(element, pseudo);
      styles.content = contentValue;
      pseudoElementStyles[pseudo === "::before" ? "before" : "after"] = styles;
    }
  }

  // ::placeholder for inputs/textareas
  if (
    (isInstanceOfOwner<HTMLInputElement>(element, element, "HTMLInputElement") && INPUT_TYPES_WITH_PLACEHOLDER.has(element.type)) ||
    isInstanceOfOwner<HTMLTextAreaElement>(element, element, "HTMLTextAreaElement")
  ) {
    if (element.placeholder) {
      if (!pseudoElementStyles) pseudoElementStyles = {};
      pseudoElementStyles.placeholder = diffStyles(element, "::placeholder");
    }
  }

  // Collect images/videos/backgrounds and font usage.
  resolveResources(element, computedStyles as unknown as CSSStyleDeclaration, assetCollector);
  resolveFonts(element, computedStyles as unknown as CSSStyleDeclaration, fontCollector);

  // Element bounding rect (may include rotated quad).
  const rect = getElementRect(element, computedStyles as unknown as CSSStyleDeclaration, combinedTransform);

  // Prune invisible nodes (zero-size without children, offscreen, etc.)
  if (shouldPruneNode(element, rect, childNodes)) {
    return null;
  }

  // Infer layout sizing hints for Figma Auto Layout.
  const sizing = inferLayoutSizing(element, computedStyles, element.parentElement);

  const node: ElementSnapshot = {
    nodeType: Node.ELEMENT_NODE as 1,
    id: generateNodeId(element),
    tag: expandedIframe ? "DIV" : tag,
    attributes: getElementAttributes(element),
    styles: computedStyles,
    rect,
    childNodes,
    content: svgContent,
    placeholderUrl,
    pseudoElementStyles,
    owningReactComponent: findParentComponent(element),
    sources,
    selectionSourceId,
    relativeTransform: elementTransform ? matrixToSimple(elementTransform) : undefined,
    layoutSizingHorizontal: sizing.horizontal,
    layoutSizingVertical: sizing.vertical,
  };

  if (Object.keys(declaredStyles).length > 0) {
    node.declaredStyles = declaredStyles;
  }

  return node;
}

// ---------------------------------------------------------------------------
// Form-control appearance helpers
// ---------------------------------------------------------------------------

function ensureFormControlAppearance(element: Element, styles: Record<string, string>): void {
  if (!isFormControlLikeElement(element)) return;

  const rect = element.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 16) return;

  if (!styles.boxSizing) styles.boxSizing = "border-box";

  const hasVisibleBorder = [
    styles.borderTopWidth,
    styles.borderRightWidth,
    styles.borderBottomWidth,
    styles.borderLeftWidth,
  ].some((width) => parseFloat(width || "0") > 0);

  const hasVisibleBackground =
    styles.backgroundColor != null &&
    styles.backgroundColor !== "rgba(0, 0, 0, 0)" &&
    styles.backgroundColor !== "transparent";

  if (!hasVisibleBackground) {
    styles.backgroundColor = "rgb(255, 255, 255)";
  }

  if (!hasVisibleBorder) {
    const computed = getComputedStyleFor(element);
    const borderColor = getControlBorderFallbackColor(computed);

    styles.borderTopWidth = "1px";
    styles.borderRightWidth = "1px";
    styles.borderBottomWidth = "1px";
    styles.borderLeftWidth = "1px";
    styles.borderTopStyle = "solid";
    styles.borderRightStyle = "solid";
    styles.borderBottomStyle = "solid";
    styles.borderLeftStyle = "solid";
    styles.borderTopColor = borderColor;
    styles.borderRightColor = borderColor;
    styles.borderBottomColor = borderColor;
    styles.borderLeftColor = borderColor;
  }

  if (!styles.borderTopLeftRadius || styles.borderTopLeftRadius === "0px") {
    const computed = getComputedStyleFor(element);
    const radius = computed.borderTopLeftRadius && computed.borderTopLeftRadius !== "0px"
      ? computed.borderTopLeftRadius
      : "4px";
    styles.borderTopLeftRadius = radius;
    styles.borderTopRightRadius = radius;
    styles.borderBottomRightRadius = radius;
    styles.borderBottomLeftRadius = radius;
  }
}

function isFormControlLikeElement(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;

  if (tag === "INPUT") {
    const type = element.getAttribute("type")?.toLowerCase() || "text";
    return !NON_TEXT_INPUT_TYPES.has(type);
  }

  const role = element.getAttribute("role")?.toLowerCase();
  if (role && CONTROL_LIKE_ROLES.has(role)) return true;

  const ariaExpanded = element.getAttribute("aria-expanded");
  const ariaHasPopup = element.getAttribute("aria-haspopup");
  if (ariaExpanded != null && ariaHasPopup != null) return true;

  const className = String((element as HTMLElement | SVGElement).className || "");
  const id = element.id || "";
  const dataRole = element.getAttribute("data-role") || "";
  return CONTROL_LIKE_CLASS_PATTERN.test(`${className} ${id} ${dataRole}`);
}

function firstUsableColor(...colors: string[]): string {
  for (const color of colors) {
    if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
      return color;
    }
  }
  return "rgb(217, 217, 217)";
}

function getControlBorderFallbackColor(computed: CSSStyleDeclaration): string {
  if (parseFloat(computed.outlineWidth || "0") > 0 && computed.outlineStyle !== "none") {
    return firstUsableColor(computed.outlineColor);
  }

  const shadowColor = computed.boxShadow.match(/rgba?\([^)]+\)/)?.[0];
  return firstUsableColor(shadowColor || "", "rgb(217, 217, 217)");
}

// ---------------------------------------------------------------------------
// Iframe serializer
// ---------------------------------------------------------------------------

function getReadableIframeDocument(element: Element): Document | null {
  if (element.tagName.toUpperCase() !== "IFRAME") return null;

  const iframe = element as HTMLIFrameElement;
  try {
    const doc = iframe.contentDocument ?? iframe.contentWindow?.document ?? null;
    if (!doc?.documentElement) return null;
    return doc;
  } catch (err) {
    console.debug("H2D Capture: iframe DOM is not readable; keeping iframe shell only", {
      src: iframe.getAttribute("src"),
      error: err,
    });
    return null;
  }
}

function snapshotIframeDocument(
  element: Element,
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
  ctx: CaptureContext,
  childNodes: SnapshotNode[],
): boolean {
  const frameDocument = getReadableIframeDocument(element);
  if (!frameDocument) return false;

  const serialized = snapshotNode(frameDocument.documentElement, assetCollector, fontCollector, undefined, ctx);
  if (serialized == null) return true;

  const rect = element.getBoundingClientRect();
  const frameElement = element as HTMLElement;
  const frameRect = {
    x: rect.x + frameElement.clientLeft,
    y: rect.y + frameElement.clientTop,
    width: frameElement.clientWidth || rect.width,
    height: frameElement.clientHeight || rect.height,
  };
  offsetSnapshotNode(serialized, frameRect.x, frameRect.y);
  lockSnapshotGeometry(serialized, frameRect);
  childNodes.push(serialized);
  return true;
}

function offsetSnapshotNode(node: SnapshotNode, dx: number, dy: number): void {
  node.rect.x += dx;
  node.rect.y += dy;

  if (isElementNodeSnapshot(node)) {
    if (node.rect.quad) {
      node.rect.quad.p1.x += dx;
      node.rect.quad.p1.y += dy;
      node.rect.quad.p2.x += dx;
      node.rect.quad.p2.y += dy;
      node.rect.quad.p3.x += dx;
      node.rect.quad.p3.y += dy;
      node.rect.quad.p4.x += dx;
      node.rect.quad.p4.y += dy;
    }

    for (const child of node.childNodes) {
      offsetSnapshotNode(child, dx, dy);
    }
  }
}

function isElementNodeSnapshot(node: SnapshotNode): node is ElementSnapshot {
  return node.nodeType === NODE_TYPES.ELEMENT_NODE;
}

function lockSnapshotGeometry(node: SnapshotNode, parentRect: { x: number; y: number; width: number; height: number }): void {
  if (!isElementNodeSnapshot(node)) return;

  if (node.tag === "HTML" || node.tag === "BODY") {
    node.tag = "DIV";
  }

  for (const prop of LAYOUT_STYLE_PROPS) {
    delete node.styles[prop];
  }

  node.styles.display = "block";
  node.styles.position = "absolute";
  node.styles.left = `${roundPx(node.rect.x - parentRect.x)}px`;
  node.styles.top = `${roundPx(node.rect.y - parentRect.y)}px`;
  node.styles.width = `${roundPx(node.rect.width)}px`;
  node.styles.height = `${roundPx(node.rect.height)}px`;
  node.styles.boxSizing = "border-box";
  node.layoutSizingHorizontal = "FIXED";
  node.layoutSizingVertical = "FIXED";
  delete node.declaredStyles;

  for (const child of node.childNodes) {
    lockSnapshotGeometry(child, node.rect);
  }
}

function roundPx(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Text node serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a text node (or group of adjacent text nodes).
 */
function snapshotTextNode(nodeOrNodes: Node | Node[]): TextSnapshot {
  const { lineCount, ...rectWithoutLineCount } = getTextRect(nodeOrNodes);

  const text = Array.isArray(nodeOrNodes)
    ? nodeOrNodes.map((n) => n.textContent || "").join("")
    : nodeOrNodes.textContent || "";

  const identityNode = Array.isArray(nodeOrNodes)
    ? nodeOrNodes.length === 1
      ? nodeOrNodes[0]
      : null
    : nodeOrNodes;

  return {
    nodeType: Node.TEXT_NODE as 3,
    id: generateNodeId(identityNode),
    text,
    rect: rectWithoutLineCount,
    lineCount,
  };
}
