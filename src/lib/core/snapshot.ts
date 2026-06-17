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
import { NODE_TYPES, isNodeVisible, shouldPruneNode, iterateChildNodes, getTextRect, getElementAttributes, matrixToSimple, INPUT_TYPES_WITH_PLACEHOLDER, isFullyClippedByHorizontalScrollAncestor, isFullyClippedByVerticalOverlayScrollAncestor, isVerticalOverlayScrollClipAncestor } from './walker.js';
import { diffStyles, ensureFlexProps, ensureGridProps, ensureFlexItemProps } from './styles.js';
import { prepareForCapture, decodeImages, assertLayoutValid, resetScrollbarState, cleanupScrollbar } from './prepare.js';
import { getDeclaredLayoutStyles } from './declared.js';
import { getComputedStyleFor, getNodeDocument, getNodeWindow, isInstanceOfOwner } from './dom.js';
import { resetFormControlDebugState, snapshotRadioControl, snapshotSelectControl } from './form-controls.js';
import type {
  CaptureTree,
  SnapshotNode,
  ElementSnapshot,
  ElementRect,
  TextSnapshot,
  CaptureOptions,
  CaptureContext,
  Rect,
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
  resetFormControlDebugState();
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
    const elementRect = element.getBoundingClientRect();
    const { width, height } = elementRect;

    if (!serialized || serialized.nodeType !== NODE_TYPES.ELEMENT_NODE) {
      throw new Error("Container node could not be serialized");
    }
    const rootSnapshot = serialized as ElementSnapshot;
    normalizeElementCaptureOrigin(rootSnapshot, elementRect);
    appendStatusDistributionOverlays(rootSnapshot, element);
    appendCompactToolbarActionOverlays(rootSnapshot, element);
    appendContentHeaderTabOverlays(rootSnapshot, element);
    extendLeftSidebarBackgrounds(rootSnapshot, element, getCaptureScrollHeight(element, rootSnapshot));
    removeStackedSelectClones(rootSnapshot);

    const experimental = mergedOptions.includeReactFiberTree
      ? { reactFiberTree: extractComponentTree(element, getNodeId) }
      : undefined;

    return {
      root: rootSnapshot,
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
    const rootSnapshot = serialized as ElementSnapshot;
    appendStatusDistributionOverlays(rootSnapshot, doc.documentElement);
    appendCompactToolbarActionOverlays(rootSnapshot, doc.documentElement);
    appendContentHeaderTabOverlays(rootSnapshot, doc.documentElement);
    extendLeftSidebarBackgrounds(rootSnapshot, doc.documentElement, getCaptureScrollHeight(doc.documentElement, rootSnapshot));
    removeStackedSelectClones(rootSnapshot);

    const experimental = mergedOptions.includeReactFiberTree
      ? { reactFiberTree: extractComponentTree(doc.documentElement, getNodeId) }
      : undefined;

    const documentScrollX = ownerWindow.scrollX || doc.documentElement.scrollLeft || doc.body?.scrollLeft || 0;
    const documentScrollY = ownerWindow.scrollY || doc.documentElement.scrollTop || doc.body?.scrollTop || 0;
    const viewportWidth = ownerWindow.innerWidth;
    const viewportHeight = ownerWindow.innerHeight;
    const documentWidth = doc.documentElement.scrollWidth;
    const documentHeight = doc.documentElement.scrollHeight;
    const shouldUseViewportRect = shouldNormalizeDocumentToViewport(
      doc.documentElement,
      rootSnapshot,
      ownerWindow,
      documentScrollY,
      documentHeight,
    );

    if (shouldUseViewportRect) {
      normalizeDocumentViewportSnapshot(rootSnapshot, ownerWindow);
    }

    return {
      documentTitle: doc.title || undefined,
      root: rootSnapshot,
      experimental,
      documentRect: {
        x: 0,
        y: 0,
        width: shouldUseViewportRect ? viewportWidth : documentWidth,
        height: shouldUseViewportRect ? viewportHeight : documentHeight,
      },
      viewportRect: {
        x: shouldUseViewportRect ? 0 : documentScrollX,
        y: shouldUseViewportRect ? 0 : documentScrollY,
        width: viewportWidth,
        height: viewportHeight,
      },
      devicePixelRatio: ownerWindow.devicePixelRatio,
      assets: blobMap,
      fonts,
    };
  }

  throw new Error("Container node must be an Element or Document");
}

function normalizeElementCaptureOrigin(rootSnapshot: ElementSnapshot, elementRect: DOMRect): void {
  if (elementRect.x === 0 && elementRect.y === 0) return;
  offsetSnapshotNode(rootSnapshot, -elementRect.x, -elementRect.y);
}

function shouldNormalizeDocumentToViewport(
  rootElement: Element,
  rootSnapshot: ElementSnapshot,
  ownerWindow: Window,
  documentScrollY: number,
  documentHeight: number,
): boolean {
  const viewportHeight = ownerWindow.innerHeight;
  if (viewportHeight <= 0) return false;
  if (documentScrollY > 1) return true;

  const fullHeight = Math.max(documentHeight, rootSnapshot.rect.height, rootElement.scrollHeight);
  const extraHeight = fullHeight - viewportHeight;
  if (extraHeight <= 0) return true;

  const meaningfulLongPageExtra = Math.max(360, viewportHeight * 0.5);
  return extraHeight < meaningfulLongPageExtra;
}

function normalizeDocumentViewportSnapshot(rootSnapshot: ElementSnapshot, ownerWindow: Window): void {
  const viewportWidth = ownerWindow.innerWidth;
  const viewportHeight = ownerWindow.innerHeight;
  if (viewportWidth <= 0 || viewportHeight <= 0) return;

  const viewportRect = {
    x: 0,
    y: 0,
    width: viewportWidth,
    height: viewportHeight,
  };

  normalizeViewportRootRect(rootSnapshot, viewportRect);
  normalizeScrolledViewportShells(rootSnapshot, viewportRect);
}

function normalizeViewportRootRect(
  rootSnapshot: ElementSnapshot,
  viewportRect: { x: number; y: number; width: number; height: number },
): void {
  rootSnapshot.rect.x = viewportRect.x;
  rootSnapshot.rect.y = viewportRect.y;
  rootSnapshot.rect.width = viewportRect.width;
  rootSnapshot.rect.height = viewportRect.height;
  rootSnapshot.rect.cssWidth = Math.round(viewportRect.width);
  rootSnapshot.rect.cssHeight = Math.round(viewportRect.height);
  rootSnapshot.styles.width = `${roundPx(viewportRect.width)}px`;
  rootSnapshot.styles.height = `${roundPx(viewportRect.height)}px`;
  rootSnapshot.styles.overflow = "hidden";
  rootSnapshot.styles.overflowX = "hidden";
  rootSnapshot.styles.overflowY = "hidden";
}

function normalizeScrolledViewportShells(
  node: ElementSnapshot,
  viewportRect: { x: number; y: number; width: number; height: number },
): void {
  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    if (isScrolledViewportShell(child, viewportRect)) {
      child.rect.y = viewportRect.y;
      child.rect.height = viewportRect.height;
      child.rect.cssHeight = Math.round(viewportRect.height);
      child.styles.height = `${roundPx(viewportRect.height)}px`;

      if (child.rect.x <= viewportRect.x + 1 && child.rect.width >= viewportRect.width - 2) {
        child.rect.x = viewportRect.x;
        child.rect.width = viewportRect.width;
        child.rect.cssWidth = Math.round(viewportRect.width);
        child.styles.width = `${roundPx(viewportRect.width)}px`;
      }

      const maxHeight = parsePx(child.styles.maxHeight || "", NaN);
      if (Number.isFinite(maxHeight) && maxHeight < viewportRect.height) {
        delete child.styles.maxHeight;
      }
    }

    normalizeScrolledViewportShells(child, viewportRect);
  }
}

function isScrolledViewportShell(
  node: ElementSnapshot,
  viewportRect: { x: number; y: number; width: number; height: number },
): boolean {
  if (node.rect.y >= viewportRect.y - 1) return false;
  if (node.rect.y + node.rect.height < viewportRect.height * 0.55) return false;
  if (node.rect.width < viewportRect.width * 0.55) return false;
  if (!hasSnapshotDescendantInsideRect(node.childNodes, viewportRect)) return false;

  const identity = `${node.tag} ${node.attributes.id || ""} ${node.attributes.class || ""}`;
  if (/(^|\s)(HTML|BODY)(\s|$)/i.test(identity)) return true;
  if (/(^|[-_\s])(root|app|layout|container|page|screen)([-_\s]|$)/i.test(identity)) return true;

  return node.rect.width >= viewportRect.width - 2 && node.rect.height >= viewportRect.height - 2;
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
  let tagOverride: string | undefined;

  const tag = element.tagName.toUpperCase();

  if (element.getAttribute("data-h2d-ignore") === "true") {
    return null;
  }

  // Skip non-visual elements entirely.
  if (tag === "HEAD" || tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
    return null;
  }

  // Menu expand/collapse arrows are often zero-height <i>/<span> hosts whose
  // visible shape lives entirely in two rotated pseudo bars. Capture them
  // before popup filtering so class names like "menu-arrow" are not mistaken
  // for empty hidden menus.
  const pseudoChevronSnapshot = snapshotPseudoChevronIcon(element);
  if (pseudoChevronSnapshot) {
    return pseudoChevronSnapshot;
  }

  if (!isNodeVisible(element)) return null;

  const statusDistributionCellSnapshot = snapshotStatusDistributionCell(element, generateNodeId);
  if (statusDistributionCellSnapshot) {
    return statusDistributionCellSnapshot;
  }

  const statusDistributionSnapshot = snapshotStatusDistributionBar(element, generateNodeId);
  if (statusDistributionSnapshot) {
    return statusDistributionSnapshot;
  }

  const radioControlSnapshot = snapshotRadioControl(element, generateNodeId);
  if (radioControlSnapshot) {
    return radioControlSnapshot;
  }

  const selectControlSnapshot = snapshotSelectControl(element, generateNodeId);
  if (selectControlSnapshot) {
    return selectControlSnapshot;
  }

  const circularProgressSnapshot = snapshotCircularProgressSvg(element);
  if (circularProgressSnapshot) {
    return circularProgressSnapshot;
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
  ensureInsetShadowBorder(element, computedStyles);
  ensurePositionForZIndex(computedStyles);
  normalizeTreeTextNegativeZIndex(element, computedStyles);
  ensureTopChromeTextStacking(element, computedStyles);
  ensureTextOnlyLineHeight(element, computedStyles);
  relaxVirtualScrollClipping(element, computedStyles);
  stabilizePopupLayerStacking(element, computedStyles);

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
    ensureInputPrefixIconsStackAbove(childNodes);
  } else {
    expandedIframe = true;
    // Once a same-origin iframe is expanded into real DOM nodes, keeping the
    // native iframe clip can make Figma discard visible descendants that sit
    // under scrolled negative-position ancestors.
    computedStyles.overflow = "visible";
    computedStyles.overflowX = "visible";
    computedStyles.overflowY = "visible";
  }

  stabilizeTopChromeLayout(element, computedStyles, childNodes);

  // Pseudo-element styles (::before, ::after, ::placeholder).
  let pseudoElementStyles: Record<string, Record<string, string>> | undefined;
  const materializedPseudoElements = materializePseudoElements(element, childNodes);

  // ::before / ::after — capture when they have visible content
  for (const pseudo of ["::before", "::after"] as const) {
    const pseudoComputed = getComputedStyleFor(element, pseudo);
    const contentValue = pseudoComputed.content;
    if (contentValue && contentValue !== "none" && contentValue !== "normal") {
      if (materializedPseudoElements.has(pseudo)) continue;
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
  let rect = getElementRect(element, computedStyles as unknown as CSSStyleDeclaration, combinedTransform);
  rect = normalizeSmallSvgImageRect(element, computedStyles, rect);
  rect = normalizeTopChromeTextLineBox(element, computedStyles, childNodes, rect);
  unclipZeroSizeVisibleWrapper(computedStyles, rect, childNodes);
  const popupActionOverflowRelaxed = relaxPopupActionClipping(element, computedStyles, rect, childNodes);
  const verticalScrollViewportStabilized = stabilizeVerticalOverlayScrollViewport(element, computedStyles, childNodes, rect);
  stabilizeHorizontalScrolledTableViewport(element, computedStyles, childNodes, rect);
  const iframeCropRect = getEmptyIframeViewportCropRect(element, rect, childNodes);
  if (iframeCropRect) {
    rect = iframeCropRect;
    placeholderUrl = assetCollector.addViewportCrop(iframeCropRect);
    tagOverride = "CANVAS";
    computedStyles.overflow = "hidden";
    computedStyles.overflowX = "hidden";
    computedStyles.overflowY = "hidden";
    computedStyles.width = `${roundPx(iframeCropRect.width)}px`;
    computedStyles.height = `${roundPx(iframeCropRect.height)}px`;
  }

  // Prune invisible nodes (zero-size without children, offscreen, etc.)
  if (shouldPruneNode(element, rect, childNodes) && !shouldKeepClippedPopupAction(element, rect, childNodes)) {
    return null;
  }

  // Infer layout sizing hints for Figma Auto Layout.
  const sizing = inferLayoutSizing(element, computedStyles, element.parentElement);

  const attributes = getSnapshotElementAttributes(element, verticalScrollViewportStabilized);
  if (popupActionOverflowRelaxed) {
    attributes["data-h2d-popup-action-overflow"] = "true";
  }

  const node: ElementSnapshot = {
    nodeType: Node.ELEMENT_NODE as 1,
    id: generateNodeId(element),
    tag: tagOverride ?? (expandedIframe ? "DIV" : tag),
    attributes,
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

function getSnapshotElementAttributes(element: Element, forceVerticalScrollViewport = false): Record<string, string> {
  const attributes = getElementAttributes(element);
  if (forceVerticalScrollViewport || isVerticalOverlayScrollClipAncestor(element)) {
    attributes["data-h2d-vertical-scroll-viewport"] = "true";
  }
  return attributes;
}

function stabilizeVerticalOverlayScrollViewport(
  element: Element,
  styles: Record<string, string>,
  childNodes: SnapshotNode[],
  rect: ElementRect,
): boolean {
  if (rect.width < 200 || rect.height < 120) return false;
  if (element.tagName.toUpperCase() === "HTML" || element.tagName.toUpperCase() === "BODY") return false;

  const computed = getComputedStyleFor(element);
  if (!isScrollableOverflow(computed)) return false;

  const isOverlayScroll = isVerticalOverlayScrollClipAncestor(element);
  const isNegativeLayerScroll = hasNegativeScrolledViewportLayer(childNodes, rect);
  if (!isOverlayScroll && !isNegativeLayerScroll) return false;

  let rebased = false;
  for (const child of childNodes) {
    if (!isElementNodeSnapshot(child)) continue;
    if (child.rect.y >= rect.y - 8) continue;
    if (child.rect.height < rect.height * 0.5) continue;
    if (!hasSnapshotDescendantInsideRect(child.childNodes, rect)) continue;

    child.rect.y = rect.y;
    child.rect.height = Math.min(child.rect.height, rect.height);
    child.rect.cssHeight = Math.round(child.rect.height);
    child.styles.overflow = "hidden";
    child.styles.overflowY = "visible";
    rebaseNestedVisibleScrollLayers(child, rect);
    rebased = true;
  }

  if (!rebased) return false;
  styles.overflow = "hidden";
  styles.overflowX = "hidden";
  styles.overflowY = "hidden";
  return true;
}

function hasNegativeScrolledViewportLayer(
  childNodes: SnapshotNode[],
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  return childNodes.some((child) => {
    if (!isElementNodeSnapshot(child)) return false;
    if (child.rect.y >= rect.y - 8) return false;
    if (child.rect.height < rect.height * 0.5) return false;
    return hasSnapshotDescendantInsideRect(child.childNodes, rect);
  });
}

function rebaseNestedVisibleScrollLayers(
  node: ElementSnapshot,
  viewportRect: { x: number; y: number; width: number; height: number },
): void {
  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    if (
      child.rect.y < viewportRect.y - 1 &&
      child.rect.y + child.rect.height > viewportRect.y &&
      hasSnapshotDescendantInsideRect(child.childNodes, viewportRect)
    ) {
      const visibleTop = getSnapshotDescendantTopInsideRect(child.childNodes, viewportRect);
      const topInset = getSnapshotTopInset(child);
      const targetY = Number.isFinite(visibleTop)
        ? Math.max(child.rect.y, Math.min(viewportRect.y, visibleTop - topInset))
        : viewportRect.y;
      if (targetY > child.rect.y + 0.5) {
        const delta = targetY - child.rect.y;
        child.rect.y = roundPx(targetY);
        child.rect.height = roundPx(Math.max(0, child.rect.height - delta));
        child.rect.cssHeight = Math.round(child.rect.height);
      }

      child.styles.overflow = "visible";
      child.styles.overflowY = "visible";
    }

    rebaseNestedVisibleScrollLayers(child, viewportRect);
  }
}

function getSnapshotDescendantTopInsideRect(
  childNodes: SnapshotNode[],
  rect: { x: number; y: number; width: number; height: number },
): number {
  let top = Number.POSITIVE_INFINITY;

  for (const child of childNodes) {
    if (isSnapshotRectIntersectingRect(child.rect, rect)) {
      top = Math.min(top, child.rect.y);
    }
    if (child.nodeType === NODE_TYPES.ELEMENT_NODE) {
      top = Math.min(top, getSnapshotDescendantTopInsideRect(child.childNodes, rect));
    }
  }

  return top;
}

function getSnapshotTopInset(node: ElementSnapshot): number {
  return parsePx(node.styles.paddingTop || "", 0) + parsePx(node.styles.borderTopWidth || "", 0);
}

function ensurePositionForZIndex(styles: Record<string, string>): void {
  if (styles.zIndex == null) return;
  if (styles.position == null || styles.position === "static") {
    styles.position = "relative";
  }
}

function stabilizePopupLayerStacking(element: Element, styles: Record<string, string>): void {
  const computed = getComputedStyleFor(element);
  if (isPopupLayerCandidate(element, computed)) {
    const maskZIndex = getMaxSiblingBackdropZIndex(element);
    if (maskZIndex != null) {
      elevateLayerZIndex(styles, computed, maskZIndex + 1);
      return;
    }

    const framePopupInfo = getOwnerFramePopupLayerInfo(element);
    if (framePopupInfo) {
      elevateLayerZIndex(styles, computed, framePopupInfo.maskZIndex + 2);
      return;
    }
  }

  const popupInfo = getAncestorPopupLayerInfo(element);
  const framePopupInfo = popupInfo ?? getOwnerFramePopupLayerInfo(element);
  if (!framePopupInfo) return;
  if (!isPopupSurfaceCandidate(element, computed, framePopupInfo.layer)) return;

  elevateLayerZIndex(styles, computed, framePopupInfo.maskZIndex + 2);
}

function isPopupLayerCandidate(element: Element, computed: CSSStyleDeclaration): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "HTML" || tag === "BODY") return false;
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;
  if (computed.position !== "fixed" && computed.position !== "absolute") return false;
  if (isBackdropLayer(element, computed)) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 240 || rect.height < 120) return false;

  const identity = getElementIdentity(element);
  const role = element.getAttribute("role")?.toLowerCase() || "";
  const dataType = element.getAttribute("data-type")?.toLowerCase() || "";
  const looksLikePopup =
    dataType === "popup" ||
    role === "dialog" ||
    role === "alertdialog" ||
    /(^|[-_\s])(popup|pop-up|modal|dialog|drawer)([-_\s]|$)/i.test(identity);
  if (!looksLikePopup) return false;

  return hasDirectVisibleText(element) || hasVisibleTextDescendant(element) || hasReadableIframeVisibleText(element);
}

function isPopupSurfaceCandidate(element: Element, computed: CSSStyleDeclaration, popupLayer: Element): boolean {
  if (element === popupLayer) return false;
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;
  if (isBackdropLayer(element, computed)) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 240 || rect.height < 120) return false;
  if (getNodeDocument(element) === getNodeDocument(popupLayer)) {
    const popupRect = popupLayer.getBoundingClientRect();
    if (rect.right <= popupRect.left || rect.left >= popupRect.right) return false;
    if (rect.bottom <= popupRect.top || rect.top >= popupRect.bottom) return false;
  }

  const identity = getElementIdentity(element);
  const role = element.getAttribute("role")?.toLowerCase() || "";
  const looksLikeSurface =
    role === "dialog" ||
    role === "alertdialog" ||
    /(^|[-_\s])(modal|dialog|drawer|panel|content|container|wrapper)([-_\s]|$)/i.test(identity);
  const hasSurfacePaint =
    isVisiblePaint(computed.backgroundColor) ||
    hasVisibleBorderStyles(computed) ||
    Boolean(computed.boxShadow && computed.boxShadow !== "none");
  if (!looksLikeSurface && !hasSurfacePaint) return false;

  return hasDirectVisibleText(element) || hasVisibleTextDescendant(element);
}

function hasReadableIframeVisibleText(element: Element): boolean {
  const frameDocument = getReadableIframeDocument(element);
  if (!frameDocument?.body) return false;
  return Boolean((frameDocument.body.innerText || frameDocument.body.textContent || "").trim());
}

function isInsidePopupCaptureLayer(element: Element): boolean {
  return Boolean(getAncestorPopupLayerInfo(element) ?? getOwnerFramePopupLayerInfo(element));
}

function shouldKeepClippedPopupAction(
  element: Element,
  rect: { width: number; height: number },
  childNodes: SnapshotNode[],
): boolean {
  if (rect.width <= 0.5 || rect.height <= 0.5) return false;
  if (!isInsidePopupCaptureLayer(element)) return false;

  return isPopupActionElement(element) || hasPopupActionSnapshotDescendant(childNodes);
}

function isPopupActionElement(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  const role = element.getAttribute("role")?.toLowerCase() || "";
  if (tag !== "BUTTON" && role !== "button") return false;

  const label = ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, "");
  return isPopupActionText(label);
}

function hasPopupActionSnapshotDescendant(childNodes: SnapshotNode[]): boolean {
  for (const child of childNodes) {
    if (child.nodeType === NODE_TYPES.TEXT_NODE && isPopupActionText((child as TextSnapshot).text.replace(/\s+/g, ""))) {
      return true;
    }
    if (child.nodeType === NODE_TYPES.ELEMENT_NODE && hasPopupActionSnapshotDescendant((child as ElementSnapshot).childNodes)) {
      return true;
    }
  }

  return false;
}

function isPopupActionText(text: string): boolean {
  if (!text || text.length > 20) return false;
  return /^(取消|保存|确定|提交|关闭|发布|保存并发起审批|发起审批|保存并发布广告)$/.test(text);
}

function getAncestorPopupLayerInfo(element: Element): { layer: Element; maskZIndex: number } | null {
  let ancestor = element.parentElement;
  let depth = 0;
  while (ancestor && depth < 12) {
    const ancestorComputed = getComputedStyleFor(ancestor);
    if (isPopupLayerCandidate(ancestor, ancestorComputed)) {
      const maskZIndex = getMaxSiblingBackdropZIndex(ancestor);
      if (maskZIndex != null) {
        return { layer: ancestor, maskZIndex };
      }
    }
    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return null;
}

function getOwnerFramePopupLayerInfo(element: Element): { layer: Element; maskZIndex: number } | null {
  const frameElement = getNodeWindow(element).frameElement;
  if (!frameElement) return null;

  const frameComputed = getComputedStyleFor(frameElement);
  if (!isPopupLayerCandidate(frameElement, frameComputed)) return null;

  const maskZIndex = getMaxSiblingBackdropZIndex(frameElement);
  if (maskZIndex == null) return null;

  return { layer: frameElement, maskZIndex };
}

function getMaxSiblingBackdropZIndex(element: Element): number | null {
  const parent = element.parentElement;
  if (!parent) return null;

  let maxZIndex: number | null = null;
  for (const sibling of Array.from(parent.children)) {
    if (sibling === element) continue;

    const siblingComputed = getComputedStyleFor(sibling);
    if (!isBackdropLayer(sibling, siblingComputed)) continue;

    const zIndex = parseZIndex(siblingComputed.zIndex);
    if (zIndex == null) continue;
    maxZIndex = maxZIndex == null ? zIndex : Math.max(maxZIndex, zIndex);
  }

  return maxZIndex;
}

function isBackdropLayer(element: Element, computed: CSSStyleDeclaration): boolean {
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;
  if (computed.position !== "fixed" && computed.position !== "absolute") return false;

  const identity = getElementIdentity(element);
  if (!/(^|[-_\s])(mask|backdrop|overlay)([-_\s]|$)/i.test(identity)) return false;

  const rect = element.getBoundingClientRect();
  const view = getNodeWindow(element);
  if (rect.width < view.innerWidth * 0.5 || rect.height < view.innerHeight * 0.5) return false;

  return isVisiblePaint(computed.backgroundColor) || (computed.backgroundImage !== "" && computed.backgroundImage !== "none");
}

function elevateLayerZIndex(styles: Record<string, string>, computed: CSSStyleDeclaration, minZIndex: number): void {
  const currentZIndex = parseZIndex(computed.zIndex);
  if (currentZIndex != null && currentZIndex >= minZIndex) return;

  styles.zIndex = String(minZIndex);
  if (styles.position == null || styles.position === "static") {
    styles.position = computed.position === "static" ? "relative" : computed.position;
  }
}

function parseZIndex(value: string): number | null {
  const parsed = parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTreeTextNegativeZIndex(element: Element, styles: Record<string, string>): void {
  const zIndex = parseInt(styles.zIndex || "", 10);
  if (!Number.isFinite(zIndex) || zIndex >= 0) return;
  if (!isInsideAriaTree(element)) return;
  if (!hasDirectVisibleText(element) && !hasVisibleTextDescendant(element)) return;

  styles.zIndex = "0";
}

function isInsideAriaTree(element: Element): boolean {
  if (isTreeRole(element)) return true;
  let ancestor = element.parentElement;
  let depth = 0;
  while (ancestor && depth < 8) {
    if (isTreeRole(ancestor)) return true;
    ancestor = ancestor.parentElement;
    depth += 1;
  }
  return false;
}

function isTreeRole(element: Element): boolean {
  const role = element.getAttribute("role")?.toLowerCase();
  return role === "tree" || role === "treeitem" || role === "group";
}

function ensureTopChromeTextStacking(element: Element, styles: Record<string, string>): void {
  const rect = element.getBoundingClientRect();
  if (rect.y > 96 || rect.height <= 0 || rect.height > 96 || rect.width <= 0 || rect.width > 480) return;
  if (!hasDirectVisibleText(element) && !hasTopChromeTextDescendant(element)) return;

  const computed = getComputedStyleFor(element);
  if (isVisiblePaint(computed.backgroundColor) || hasVisibleBorderStyles(computed)) return;

  if (styles.position == null || styles.position === "static") {
    styles.position = "relative";
  }
  const zIndex = parseInt(styles.zIndex || "", 10);
  if (styles.zIndex == null || styles.zIndex === "auto" || !Number.isFinite(zIndex) || zIndex < 20) {
    styles.zIndex = "20";
  }
}

function relaxVirtualScrollClipping(element: Element, styles: Record<string, string>): void {
  const computed = getComputedStyleFor(element);
  if (!isScrollableOverflow(computed)) return;
  if (isVerticalOverlayScrollClipAncestor(element)) return;

  const hasHorizontalScrollOffset = hasElementHorizontalScrollOffset(element);
  const shouldRelaxVertical =
    hasNegativeVirtualScrollLayer(element) ||
    hasVerticallyScrolledVisibleContent(element);
  if (!shouldRelaxVertical) return;

  // Some enterprise shells capture the current viewport by moving scrolled
  // content into negative coordinates. Figma can clip that offscreen parent
  // frame before considering visible descendants. Keep horizontal clipping for
  // tables that are intentionally captured after horizontal scrolling; otherwise
  // hidden columns leak back into the visible viewport and overlap sticky columns.
  if (hasHorizontalScrollOffset) {
    styles.overflow = "hidden";
    styles.overflowX = computed.overflowX === "clip" ? "clip" : "hidden";
  } else {
    styles.overflow = "visible";
    styles.overflowX = "visible";
  }
  styles.overflowY = "visible";
}

function isScrollableOverflow(computed: CSSStyleDeclaration): boolean {
  return /^(auto|scroll)$/i.test(computed.overflow) ||
    /^(auto|scroll)$/i.test(computed.overflowX) ||
    /^(auto|scroll)$/i.test(computed.overflowY);
}

function hasNegativeVirtualScrollLayer(element: Element): boolean {
  const viewportRect = element.getBoundingClientRect();
  if (viewportRect.width < 200 || viewportRect.height < 120) return false;

  for (const child of Array.from(element.children)) {
    const childComputed = getComputedStyleFor(child);
    if (childComputed.position !== "absolute") continue;

    const top = parsePx(childComputed.top, NaN);
    if (!Number.isFinite(top) || top > -32) continue;

    const childRect = child.getBoundingClientRect();
    const nearViewportHeight = Math.abs(childRect.height - viewportRect.height) <= Math.max(4, viewportRect.height * 0.08);
    const fillsViewportWidth = childRect.width >= viewportRect.width * 0.7;
    if (!nearViewportHeight || !fillsViewportWidth) continue;

    if (hasVisibleDescendantInsideRect(child, viewportRect)) return true;
  }

  return false;
}

function hasElementHorizontalScrollOffset(element: Element): boolean {
  return (
    isInstanceOfOwner<HTMLElement>(element, element, "HTMLElement") &&
    element.scrollLeft > 0 &&
    element.scrollWidth > element.clientWidth + 1
  );
}

function hasVerticallyScrolledVisibleContent(element: Element): boolean {
  if (!isInstanceOfOwner<HTMLElement>(element, element, "HTMLElement")) return false;
  if (element.scrollTop <= 0) return false;
  if (element.scrollHeight <= element.clientHeight + 1) return false;

  const viewportRect = element.getBoundingClientRect();
  if (viewportRect.width < 200 || viewportRect.height < 120) return false;
  return hasVisibleDescendantInsideRect(element, viewportRect);
}

function hasVisibleDescendantInsideRect(root: Element, viewportRect: DOMRect): boolean {
  for (const descendant of Array.from(root.querySelectorAll("*"))) {
    const rect = descendant.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right <= viewportRect.left || rect.left >= viewportRect.right) continue;
    if (rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom) continue;

    const computed = getComputedStyleFor(descendant);
    if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") continue;
    return true;
  }

  return false;
}

function hasDirectVisibleText(element: Element): boolean {
  return Array.from(element.childNodes).some((child) => (
    child.nodeType === Node.TEXT_NODE &&
    Boolean((child.textContent || "").trim()) &&
    getTextRect(child).width > 0
  ));
}

function hasVisibleTextDescendant(element: Element): boolean {
  return Array.from(element.querySelectorAll("*")).some((descendant) => hasDirectVisibleText(descendant));
}

function hasTopChromeTextDescendant(element: Element): boolean {
  return Array.from(element.querySelectorAll("*")).some((descendant) => {
    const rect = descendant.getBoundingClientRect();
    if (rect.y > 96 || rect.width <= 0 || rect.height <= 0) return false;
    return hasDirectVisibleText(descendant);
  });
}

function isVisiblePaint(color: string): boolean {
  return Boolean(color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)");
}

interface StatusDistributionSegment {
  element: Element;
  rect: DOMRect;
  text: string;
  computed: CSSStyleDeclaration;
}

interface StatusDistributionBar {
  root: Element;
  rect: DOMRect;
  segments: StatusDistributionSegment[];
}

interface StatusDistributionCell extends StatusDistributionBar {
  barRect: DOMRect;
  labelText: string;
  labelRect: { x: number; y: number; width: number; height: number; lineCount: number };
  labelComputed: CSSStyleDeclaration;
}

function snapshotStatusDistributionCell(
  element: Element,
  createId: (node: Node | null) => string,
): ElementSnapshot | null {
  const cell = detectStatusDistributionCell(element);
  if (!cell) return null;

  const childNodes: SnapshotNode[] = [];
  const labelRect = new DOMRect(cell.labelRect.x, cell.labelRect.y, cell.labelRect.width, cell.labelRect.height);
  const labelTextNode: TextSnapshot = {
    nodeType: NODE_TYPES.TEXT_NODE,
    id: createId(null),
    text: cell.labelText,
    rect: {
      x: cell.labelRect.x,
      y: cell.labelRect.y,
      width: cell.labelRect.width,
      height: cell.labelRect.height,
    },
    lineCount: Math.max(1, cell.labelRect.lineCount),
  };
  const fontSize = parsePx(cell.labelComputed.fontSize, Math.max(12, cell.labelRect.height));
  const labelLayer: ElementSnapshot = {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: createId(null),
    tag: "DIV",
    attributes: { "data-h2d-status-label": "true" },
    styles: {
      display: "block",
      width: `${roundPx(cell.labelRect.width)}px`,
      height: `${roundPx(cell.labelRect.height)}px`,
      flexShrink: "0",
      color: firstVisiblePaint(cell.labelComputed.color, "rgb(31, 35, 41)"),
      fontFamily: cell.labelComputed.fontFamily,
      fontSize: cell.labelComputed.fontSize || `${roundPx(fontSize)}px`,
      fontWeight: cell.labelComputed.fontWeight,
      lineHeight: `${roundPx(cell.labelRect.height)}px`,
      whiteSpace: "nowrap",
      boxSizing: "border-box",
      overflow: "visible",
    },
    rect: toElementRect(labelRect),
    childNodes: [labelTextNode],
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
  childNodes.push(labelLayer);

  const spacerWidth = Math.max(0, cell.barRect.x - (cell.labelRect.x + cell.labelRect.width));
  if (spacerWidth > 0.5) {
    childNodes.push(createStatusSpacerSnapshot(cell, spacerWidth, createId));
  }

  childNodes.push(createStatusBarSnapshot({
    root: cell.root,
    rect: cell.barRect,
    segments: cell.segments,
  }, createId));

  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: createId(cell.root),
    tag: "DIV",
    attributes: { "data-h2d-status-cell": "true" },
    styles: {
      display: "flex",
      alignItems: "center",
      width: `${roundPx(cell.rect.width)}px`,
      height: `${roundPx(cell.rect.height)}px`,
      overflow: "visible",
      whiteSpace: "nowrap",
      boxSizing: "border-box",
    },
    rect: toElementRect(cell.rect),
    childNodes,
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function snapshotStatusDistributionBar(
  element: Element,
  createId: (node: Node | null) => string,
): ElementSnapshot | null {
  const bar = detectStatusDistributionBar(element);
  if (!bar) return null;

  return createStatusBarSnapshot(bar, createId);
}

function createStatusBarSnapshot(
  bar: StatusDistributionBar,
  createId: (node: Node | null) => string,
): ElementSnapshot {
  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: createId(bar.root),
    tag: "DIV",
    attributes: { "data-h2d-status-distribution": "true" },
    styles: {
      display: "flex",
      width: `${roundPx(bar.rect.width)}px`,
      height: `${roundPx(bar.rect.height)}px`,
      alignItems: "center",
      overflow: "visible",
      boxSizing: "border-box",
    },
    rect: toElementRect(bar.rect),
    childNodes: bar.segments.map((segment, index) => (
      createStatusSegmentSnapshot(segment, index, bar.segments.length, createId)
    )),
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function createStatusSegmentSnapshot(
  segment: StatusDistributionSegment,
  segmentIndex: number,
  segmentCount: number,
  createId: (node: Node | null) => string,
): ElementSnapshot {
  const segmentWidth = roundPx(segment.rect.width);
  const segmentHeight = roundPx(segment.rect.height);
  const radius = getStatusBarRadius(segment.computed);
  const isSingle = segmentCount <= 1;
  const isFirst = segmentIndex === 0;
  const isLast = segmentIndex === segmentCount - 1;
  const fontSize = parsePx(segment.computed.fontSize, Math.max(10, segment.rect.height * 0.68));
  const textSnapshot: TextSnapshot = {
    nodeType: NODE_TYPES.TEXT_NODE,
    id: createId(null),
    text: segment.text,
    rect: {
      x: segment.rect.x,
      y: segment.rect.y,
      width: segment.rect.width,
      height: segment.rect.height,
    },
    lineCount: 1,
  };

  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: createId(segment.element),
    tag: "DIV",
    attributes: { "data-h2d-status-segment": "true" },
    styles: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: `${segmentWidth}px`,
      height: `${segmentHeight}px`,
      flexShrink: "0",
      backgroundColor: firstVisiblePaint(segment.computed.backgroundColor, "rgb(134, 144, 156)"),
      color: firstVisiblePaint(segment.computed.color, "rgb(255, 255, 255)"),
      fontFamily: segment.computed.fontFamily,
      fontSize: segment.computed.fontSize || `${roundPx(fontSize)}px`,
      fontWeight: segment.computed.fontWeight,
      lineHeight: `${segmentHeight}px`,
      textAlign: "center",
      whiteSpace: "nowrap",
      borderTopLeftRadius: isSingle || isFirst ? radius : "0px",
      borderTopRightRadius: isSingle || isLast ? radius : "0px",
      borderBottomRightRadius: isSingle || isLast ? radius : "0px",
      borderBottomLeftRadius: isSingle || isFirst ? radius : "0px",
      boxSizing: "border-box",
      overflow: "hidden",
    },
    rect: toElementRect(segment.rect),
    childNodes: [textSnapshot],
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function createStatusSpacerSnapshot(
  cell: StatusDistributionCell,
  width: number,
  createId: (node: Node | null) => string,
): ElementSnapshot {
  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: createId(null),
    tag: "DIV",
    attributes: { "data-h2d-status-spacer": "true" },
    styles: {
      display: "block",
      width: `${roundPx(width)}px`,
      height: `${roundPx(cell.rect.height)}px`,
      flexShrink: "0",
      boxSizing: "border-box",
    },
    rect: toElementRect(new DOMRect(cell.labelRect.x + cell.labelRect.width, cell.rect.y, width, cell.rect.height)),
    childNodes: [],
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function detectStatusDistributionCell(element: Element): StatusDistributionCell | null {
  const tag = element.tagName.toUpperCase();
  if (tag !== "SPAN" && tag !== "DIV") return null;
  if (!hasTableCellAncestor(element)) return null;

  const rootRect = element.getBoundingClientRect();
  if (rootRect.width < 40 || rootRect.width > 260 || rootRect.height < 12 || rootRect.height > 40) return null;

  const flex = findStatusDistributionFlex(element);
  if (!flex || flex === element) return null;

  const segments = Array.from(flex.children)
    .map(getStatusDistributionSegment)
    .filter((segment): segment is StatusDistributionSegment => segment !== null);
  if (segments.length === 0 || segments.length !== flex.children.length) return null;

  const labelNodes = getStatusCellLabelTextNodes(element, flex);
  if (labelNodes.length === 0) return null;

  const labelText = labelNodes.map((node) => node.textContent || "").join("").replace(/\s+/g, " ").trim();
  if (!labelText || /^\d+(?:\s+\d+)*$/.test(labelText)) return null;

  const labelRect = getTextRect(labelNodes.length === 1 ? labelNodes[0] : labelNodes);
  if (labelRect.width <= 0 || labelRect.height <= 0) return null;

  return {
    root: element,
    rect: rootRect,
    barRect: flex.getBoundingClientRect(),
    segments,
    labelText,
    labelRect,
    labelComputed: getComputedStyleFor(element),
  };
}

function detectStatusDistributionBar(element: Element): StatusDistributionBar | null {
  const tag = element.tagName.toUpperCase();
  if (tag !== "DIV" && tag !== "SPAN") return null;
  if (hasStatusDistributionAncestor(element)) return null;

  const rootRect = element.getBoundingClientRect();
  if (!isStatusDistributionContainerRect(rootRect)) return null;

  const flex = findStatusDistributionFlex(element);
  if (!flex) return null;

  const segments = Array.from(flex.children)
    .map(getStatusDistributionSegment)
    .filter((segment): segment is StatusDistributionSegment => segment !== null);
  if (segments.length === 0 || segments.length !== flex.children.length) return null;

  const text = segments.map((segment) => segment.text).join(" ").trim();
  if (!/^\d+(?:\s+\d+)*$/.test(text)) return null;

  return {
    root: element,
    rect: rootRect,
    segments,
  };
}

function hasStatusDistributionAncestor(element: Element): boolean {
  let ancestor = element.parentElement;
  let depth = 0;
  while (ancestor && depth < 4) {
    const rect = ancestor.getBoundingClientRect();
    if (isStatusDistributionContainerRect(rect) && findStatusDistributionFlex(ancestor)) {
      return true;
    }
    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return false;
}

function findStatusDistributionFlex(element: Element): Element | null {
  const computed = getComputedStyleFor(element);
  if (isFlexDisplay(computed.display) && hasStatusDistributionSegments(element)) return element;

  for (const child of Array.from(element.children)) {
    const childComputed = getComputedStyleFor(child);
    if (!isFlexDisplay(childComputed.display)) continue;
    if (hasStatusDistributionSegments(child)) return child;
  }

  return null;
}

function hasStatusDistributionSegments(element: Element): boolean {
  if (element.children.length === 0 || element.children.length > 6) return false;
  return Array.from(element.children).every((child) => getStatusDistributionSegment(child) !== null);
}

function getStatusDistributionSegment(element: Element): StatusDistributionSegment | null {
  if (element.tagName.toUpperCase() !== "DIV") return null;

  const rect = element.getBoundingClientRect();
  if (rect.width < 8 || rect.width > 140 || rect.height < 8 || rect.height > 24) return null;

  const computed = getComputedStyleFor(element);
  if (!isVisiblePaint(computed.backgroundColor)) return null;
  if (isNearWhitePaint(computed.backgroundColor)) return null;
  if (parsePx(computed.borderTopLeftRadius, 0) < 4 && parsePx(computed.borderTopRightRadius, 0) < 4) return null;

  const text = getElementVisibleText(element);
  if (!/^\d+$/.test(text)) return null;

  return {
    element,
    rect,
    text,
    computed,
  };
}

function isStatusDistributionContainerRect(rect: DOMRect): boolean {
  return rect.width >= 20 && rect.width <= 160 && rect.height >= 12 && rect.height <= 32;
}

function getStatusBarRadius(computed: CSSStyleDeclaration): string {
  return computed.borderTopLeftRadius && computed.borderTopLeftRadius !== "0px"
    ? computed.borderTopLeftRadius
    : "10px";
}

function getElementVisibleText(element: Element): string {
  return (element.textContent || "").replace(/\s+/g, " ").trim();
}

function getStatusCellLabelTextNodes(element: Element, barElement: Element): Node[] {
  const textNodes: Node[] = [];
  const walker = getNodeDocument(element).createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();

  while (current) {
    if (barElement.contains(current)) break;
    if ((current.textContent || "").trim() && getTextRect(current).width > 0) {
      textNodes.push(current);
    }
    current = walker.nextNode();
  }

  if (textNodes.length > 0) return textNodes;

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) break;
    if (child.nodeType !== Node.TEXT_NODE) continue;
    if (!(child.textContent || "").trim()) continue;
    textNodes.push(child);
  }

  return textNodes;
}

function isFlexDisplay(display: string): boolean {
  return display === "flex" || display === "inline-flex";
}

function hasTableCellAncestor(element: Element): boolean {
  let ancestor = element.parentElement;
  let depth = 0;
  while (ancestor && depth < 3) {
    const tag = ancestor.tagName.toUpperCase();
    if (tag === "TD" || tag === "TH") return true;
    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return false;
}

function firstVisiblePaint(...colors: string[]): string {
  return colors.find(isVisiblePaint) || "rgb(134, 144, 156)";
}

function isNearWhitePaint(color: string): boolean {
  const match = color.match(/rgba?\(([^)]+)\)/i);
  if (!match) return false;
  const [red, green, blue] = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
  if (![red, green, blue].every(Number.isFinite)) return false;
  return red >= 245 && green >= 245 && blue >= 245;
}

function appendStatusDistributionOverlays(rootSnapshot: ElementSnapshot, rootElement: Element): void {
  const bars = collectStatusDistributionBars(rootElement);
  if (bars.length === 0) return;

  pruneStatusDistributionSnapshots(rootSnapshot);

  const rootRect = rootElement.getBoundingClientRect();
  const offsetX = rootSnapshot.rect.x - rootRect.x;
  const offsetY = rootSnapshot.rect.y - rootRect.y;

  for (const bar of bars) {
    const overlay = createStatusBarSnapshot(bar, generateNodeId);
    overlay.attributes["data-h2d-status-overlay"] = "true";
    overlay.styles.zIndex = getStatusDistributionOverlayZIndex(bar.root);
    offsetSnapshotNode(overlay, offsetX, offsetY);
    anchorSnapshotToParent(overlay, rootSnapshot.rect);
    rootSnapshot.childNodes.push(overlay);
  }
}

interface CompactToolbarAction {
  element: Element;
  text: string;
}

interface StructuralTabGroup {
  tabList: Element;
  tabs: Element[];
  rect: DOMRect;
}

function appendCompactToolbarActionOverlays(rootSnapshot: ElementSnapshot, rootElement: Element): void {
  const actions = collectCompactToolbarActions(rootElement);
  if (actions.length === 0) return;

  const rootRect = rootElement.getBoundingClientRect();
  const offsetX = rootSnapshot.rect.x - rootRect.x;
  const offsetY = rootSnapshot.rect.y - rootRect.y;
  const actionIds = new Set(actions.map(({ element }) => generateNodeId(element)));
  actionIds.delete(rootSnapshot.id);
  pruneSnapshotsByIds(rootSnapshot, actionIds);

  for (const action of actions) {
    const overlay = createCompactToolbarActionOverlay(action.element, action.text);
    if (!overlay) continue;

    offsetSnapshotNode(overlay, offsetX, offsetY);
    anchorSnapshotToParent(overlay, rootSnapshot.rect);
    rootSnapshot.childNodes.push(overlay);
  }
}

function collectCompactToolbarActions(rootElement: Element): CompactToolbarAction[] {
  const roots = [rootElement, ...Array.from(rootElement.querySelectorAll("*"))];
  const collected: CompactToolbarAction[] = [];
  const seen = new Set<Element>();

  for (const root of roots) {
    if (!isElementVisibleInDocument(root)) continue;

    const rootRect = root.getBoundingClientRect();
    const actions = getDirectCompactToolbarActions(root, rootRect);
    if (!isCompactToolbarRoot(root, rootRect, actions)) continue;

    for (const action of actions) {
      if (seen.has(action.element)) continue;
      seen.add(action.element);
      collected.push(action);
    }
  }

  return collected;
}

function getDirectCompactToolbarActions(root: Element, rootRect: DOMRect): CompactToolbarAction[] {
  const actions: CompactToolbarAction[] = [];

  for (const child of Array.from(root.children)) {
    const action = getCompactToolbarAction(child, rootRect);
    if (action) actions.push(action);
  }

  return actions;
}

function getCompactToolbarAction(element: Element, rootRect: DOMRect): CompactToolbarAction | null {
  if (!isElementVisibleInDocument(element)) return null;

  const tag = element.tagName.toUpperCase();
  if (["INPUT", "SELECT", "TEXTAREA", "OPTION"].includes(tag)) return null;
  const role = element.getAttribute("role") || "";
  if (/^(tab|tablist|option|listbox|combobox)$/i.test(role)) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width < 16 || rect.width > 220 || rect.height < 12 || rect.height > 36) return null;
  if (Math.abs(getRectCenterY(rect) - getRectCenterY(rootRect)) > 12) return null;

  const text = normalizeToolbarActionText(getElementVisibleText(element));
  if (!text || text.length > 32) return null;
  if (!findToolbarActionSvg(element)) return null;

  return { element, text };
}

function isCompactToolbarRoot(root: Element, rootRect: DOMRect, actions: CompactToolbarAction[]): boolean {
  if (actions.length < 2 || actions.length > 12) return false;
  if (rootRect.width < 40 || rootRect.width > 900 || rootRect.height < 12 || rootRect.height > 48) return false;

  const centers = actions.map(({ element }) => getRectCenterY(element.getBoundingClientRect()));
  if (Math.max(...centers) - Math.min(...centers) > 8) return false;

  const bounds = unionDOMRects(actions.map(({ element }) => element.getBoundingClientRect()));
  if (!bounds) return false;
  if (bounds.left < rootRect.left - 4 || bounds.right > rootRect.right + 4) return false;
  if (bounds.top < rootRect.top - 4 || bounds.bottom > rootRect.bottom + 4) return false;

  const rootText = normalizeToolbarActionText(getElementVisibleText(root));
  const actionText = actions.map((action) => action.text).join("");
  return rootText.includes(actionText);
}

function normalizeToolbarActionText(value: string): string {
  return value.replace(/[\u200b-\u200f\ufeff]/g, "").replace(/\s+/g, "").trim();
}

function getRectCenterY(rect: DOMRect): number {
  return rect.top + rect.height / 2;
}

function unionDOMRects(rects: DOMRect[]): DOMRect | null {
  if (rects.length === 0) return null;

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const rect of rects) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }

  return new DOMRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
}

function appendContentHeaderTabOverlays(rootSnapshot: ElementSnapshot, rootElement: Element): void {
  const primaryGroup = findPrimaryContentTabGroup(rootElement);
  if (!primaryGroup) return;

  const secondaryGroup = findSecondaryContentTabGroup(rootElement, primaryGroup);
  const primaryTabs = collectTabGroupOverlays(primaryGroup, "primary");
  if (primaryTabs.length < Math.min(4, primaryGroup.tabs.length)) return;

  const secondaryTabs = secondaryGroup ? collectTabGroupOverlays(secondaryGroup, "secondary") : [];
  const topSurfaceRect = findConnectedTopSurfaceRect(rootElement, primaryGroup.rect);
  const rootRect = rootElement.getBoundingClientRect();
  const offsetX = rootSnapshot.rect.x - rootRect.x;
  const offsetY = rootSnapshot.rect.y - rootRect.y;

  if (secondaryGroup && secondaryTabs.length > 0) {
    const pruneIds = new Set([generateNodeId(secondaryGroup.tabList)]);
    pruneIds.delete(rootSnapshot.id);
    pruneSnapshotsByIds(rootSnapshot, pruneIds);
  }

  const band = createConnectedTabSurfaceBackground(
    primaryGroup.rect,
    secondaryTabs,
    rootRect,
    topSurfaceRect,
  );
  if (band) {
    offsetSnapshotNode(band, offsetX, offsetY);
    anchorSnapshotToParent(band, rootSnapshot.rect);
    rootSnapshot.childNodes.unshift(band);
  }

  for (const overlay of [...primaryTabs, ...secondaryTabs]) {
    offsetSnapshotNode(overlay, offsetX, offsetY);
    anchorSnapshotToParent(overlay, rootSnapshot.rect);
    rootSnapshot.childNodes.push(overlay);
  }
}

function findPrimaryContentTabGroup(rootElement: Element): StructuralTabGroup | null {
  const candidates = Array.from(rootElement.querySelectorAll('[role="tablist"]'));
  let best: StructuralTabGroup | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const group = getStructuralTabGroup(candidate);
    if (!group || !isPrimaryContentTabGroup(group)) continue;

    const score = group.tabs.length * 100 + group.rect.width - group.rect.top * 0.05;
    if (score > bestScore) {
      best = group;
      bestScore = score;
    }
  }

  return best;
}

function findSecondaryContentTabGroup(rootElement: Element, primaryGroup: StructuralTabGroup): StructuralTabGroup | null {
  const candidates = Array.from(rootElement.querySelectorAll('[role="tablist"]'));
  let best: StructuralTabGroup | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate === primaryGroup.tabList) continue;

    const group = getStructuralTabGroup(candidate);
    if (!group || !isSecondaryContentTabGroup(group, primaryGroup.rect)) continue;

    const score = Math.abs(group.rect.top - primaryGroup.rect.bottom) + group.rect.width * 0.001;
    if (score < bestScore) {
      best = group;
      bestScore = score;
    }
  }

  return best;
}

function getStructuralTabGroup(tabList: Element): StructuralTabGroup | null {
  if (!isElementVisibleInDocument(tabList)) return null;

  const rect = tabList.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const tabs = Array.from(tabList.querySelectorAll('[role="tab"]'))
    .filter((tab) => isVisibleStructuralTab(tab, rect))
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  if (tabs.length < 2) return null;

  return { tabList, tabs, rect };
}

function isVisibleStructuralTab(tab: Element, tabListRect: DOMRect): boolean {
  if (!isElementVisibleInDocument(tab)) return false;

  const rect = tab.getBoundingClientRect();
  if (rect.width < 12 || rect.height < 12 || rect.height > 64) return false;
  if (rect.right < tabListRect.left - 2 || rect.left > tabListRect.right + 2) return false;
  if (rect.bottom < tabListRect.top - 2 || rect.top > tabListRect.bottom + 2) return false;

  return normalizeTabText(getElementVisibleText(tab)).length > 0;
}

function isPrimaryContentTabGroup(group: StructuralTabGroup): boolean {
  if (group.tabs.length < 4 || group.tabs.length > 24) return false;
  if (group.rect.width < 480 || group.rect.height < 24 || group.rect.height > 72) return false;
  if (!isHorizontalTabRow(group)) return false;

  const selectedCount = group.tabs.filter(isSelectedTab).length;
  return selectedCount <= 1;
}

function isSecondaryContentTabGroup(group: StructuralTabGroup, primaryRect: DOMRect): boolean {
  if (group.tabs.length < 2 || group.tabs.length > 8) return false;
  if (group.rect.height < 16 || group.rect.height > 44) return false;
  if (group.rect.width > Math.min(560, primaryRect.width * 0.65)) return false;
  if (group.rect.top < primaryRect.bottom - 8 || group.rect.top > primaryRect.bottom + 96) return false;
  if (group.rect.left < primaryRect.left - 32 || group.rect.right > primaryRect.right + 32) return false;
  if (!isHorizontalTabRow(group)) return false;

  return group.tabs.some((tab) => {
    const computed = getComputedStyleFor(tab);
    return isSelectedTab(tab) || isVisiblePaint(computed.backgroundColor) || hasRoundedCorners(computed, 8);
  });
}

function isHorizontalTabRow(group: StructuralTabGroup): boolean {
  const centers = group.tabs.map((tab) => getRectCenterY(tab.getBoundingClientRect()));
  if (Math.max(...centers) - Math.min(...centers) > Math.max(10, group.rect.height * 0.35)) return false;

  let previousRight = Number.NEGATIVE_INFINITY;
  for (const tab of group.tabs) {
    const rect = tab.getBoundingClientRect();
    if (rect.left < previousRight - 4) return false;
    previousRight = Math.max(previousRight, rect.right);
  }

  return true;
}

function isSelectedTab(tab: Element): boolean {
  const selected = tab.getAttribute("aria-selected");
  return selected === "true" || tab.classList.contains("active") || tab.classList.contains("selected");
}

function hasRoundedCorners(computed: CSSStyleDeclaration, minRadius: number): boolean {
  return parsePx(computed.borderTopLeftRadius, 0) >= minRadius
    || parsePx(computed.borderTopRightRadius, 0) >= minRadius
    || parsePx(computed.borderBottomRightRadius, 0) >= minRadius
    || parsePx(computed.borderBottomLeftRadius, 0) >= minRadius;
}

function collectTabGroupOverlays(
  group: StructuralTabGroup,
  kind: "primary" | "secondary",
): ElementSnapshot[] {
  const overlays: ElementSnapshot[] = [];

  for (const tab of group.tabs) {
    const text = formatTabOverlayText(normalizeTabText(getElementVisibleText(tab)));
    if (!text) continue;

    const overlay = createTabTextOverlay(tab, text, kind);
    if (overlay) overlays.push(overlay);
  }

  return overlays;
}

function normalizeTabText(value: string): string {
  return value.replace(/[\u200b-\u200f\ufeff]/g, "").replace(/\s+/g, "").trim();
}

function formatTabOverlayText(value: string): string {
  return value.replace(/^(.+?)(\d+)$/, "$1 $2");
}

function findConnectedTopSurfaceRect(rootElement: Element, mainTabRect: DOMRect): DOMRect | null {
  let best: DOMRect | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of Array.from(rootElement.querySelectorAll("*"))) {
    if (!isElementVisibleInDocument(candidate)) continue;
    const tag = candidate.tagName.toUpperCase();
    if (tag === "HTML" || tag === "BODY") continue;

    const rect = candidate.getBoundingClientRect();
    if (!isConnectedTopSurfaceCandidate(candidate, rect, mainTabRect)) continue;

    const verticalGap = Math.abs(rect.bottom - mainTabRect.top);
    const leftPad = Math.max(0, mainTabRect.left - rect.left);
    const rightPad = Math.max(0, rect.right - mainTabRect.right);
    const padBalance = Math.abs(leftPad - rightPad);
    const widthExcess = Math.max(0, rect.width - mainTabRect.width);
    const score = verticalGap * 20 + padBalance + Math.abs(widthExcess - 32) * 0.4 + rect.top * 0.02;

    if (score < bestScore) {
      best = rect;
      bestScore = score;
    }
  }

  return best;
}

function isConnectedTopSurfaceCandidate(element: Element, rect: DOMRect, mainTabRect: DOMRect): boolean {
  if (rect.width < mainTabRect.width || rect.height < 72 || rect.height > 320) return false;
  if (rect.left > mainTabRect.left + 2 || rect.right < mainTabRect.right - 2) return false;
  if (rect.top > mainTabRect.top || rect.bottom < mainTabRect.top - 32 || rect.bottom > mainTabRect.top + 32) {
    return false;
  }

  const overlap = Math.min(rect.right, mainTabRect.right) - Math.max(rect.left, mainTabRect.left);
  if (overlap < mainTabRect.width * 0.96) return false;

  const computed = getComputedStyleFor(element);
  if (!isNearWhitePaint(computed.backgroundColor)) return false;

  const opacity = Number.parseFloat(computed.opacity || "1");
  return !Number.isFinite(opacity) || opacity > 0.01;
}

function createConnectedTabSurfaceBackground(
  mainTabRect: DOMRect,
  overlays: ElementSnapshot[],
  rootRect: DOMRect,
  topSurfaceRect: DOMRect | null,
): ElementSnapshot | null {
  if (mainTabRect.width <= 0 || mainTabRect.height <= 0) return null;

  const rootRight = rootRect.right;
  const rootBottom = rootRect.bottom;
  const left = Math.max(rootRect.left, topSurfaceRect ? topSurfaceRect.left : mainTabRect.left - 16);
  const right = Math.min(rootRight, topSurfaceRect ? topSurfaceRect.right : mainTabRect.right + 16);
  const top = Math.max(rootRect.top, topSurfaceRect ? topSurfaceRect.top : mainTabRect.top - 8);
  let bottom = topSurfaceRect ? rootBottom : mainTabRect.bottom + 88;

  for (const overlay of overlays) {
    bottom = Math.max(bottom, overlay.rect.y + overlay.rect.height + 8);
  }
  bottom = Math.min(rootBottom, bottom);

  const height = Math.max(1, bottom - top);
  const rect = new DOMRect(left, top, Math.max(1, right - left), height);
  const node: ElementSnapshot = {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: generateNodeId(null),
    tag: "DIV",
    attributes: { "data-h2d-connected-tab-surface": "true" },
    styles: {
      display: "block",
      position: "absolute",
      left: "0px",
      top: "0px",
      width: `${roundPx(rect.width)}px`,
      height: `${roundPx(rect.height)}px`,
      backgroundColor: "rgb(255, 255, 255)",
      boxSizing: "border-box",
    },
    rect: toElementRect(rect),
    childNodes: [],
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
  return node;
}

function pruneSnapshotsByIds(rootSnapshot: ElementSnapshot, ids: Set<string>): void {
  if (ids.size === 0) return;

  rootSnapshot.childNodes = rootSnapshot.childNodes.filter((child) => {
    if (!isElementNodeSnapshot(child)) return true;
    if (ids.has(child.id)) return false;

    pruneSnapshotsByIds(child, ids);
    return true;
  });
}

function createCompactToolbarActionOverlay(source: Element, text: string): ElementSnapshot | null {
  const computed = getComputedStyleFor(source);
  const sourceRect = source.getBoundingClientRect();
  const svg = findToolbarActionSvg(source);
  const textRect = getElementTextRangeRect(source) ?? getFallbackTextRect(sourceRect, computed, text);
  if (textRect.width <= 0 || textRect.height <= 0) return null;

  const svgRect = svg?.getBoundingClientRect() ?? null;
  const fontSize = parsePx(computed.fontSize, 12);
  const lineHeight = parseLineHeight(computed.lineHeight, fontSize);
  const left = Math.min(sourceRect.left, textRect.x, svgRect?.left ?? sourceRect.left);
  const top = Math.min(sourceRect.top, textRect.y, svgRect?.top ?? sourceRect.top);
  const right = Math.max(sourceRect.right, textRect.x + textRect.width, svgRect?.right ?? sourceRect.right);
  const bottom = Math.max(sourceRect.bottom, textRect.y + textRect.height, svgRect?.bottom ?? sourceRect.bottom);
  const rect = new DOMRect(left, top, Math.max(1, right - left), Math.max(sourceRect.height, bottom - top));
  const childNodes: SnapshotNode[] = [];

  if (svg && svgRect && svgRect.width > 0 && svgRect.height > 0) {
    childNodes.push({
      nodeType: NODE_TYPES.ELEMENT_NODE,
      id: generateNodeId(null),
      tag: "SVG",
      attributes: { "data-h2d-toolbar-icon": "true" },
      styles: {
        display: "block",
        position: "absolute",
        left: "0px",
        top: "0px",
        width: `${roundPx(svgRect.width)}px`,
        height: `${roundPx(svgRect.height)}px`,
        color: getComputedStyleFor(svg).color || computed.color,
        overflow: "visible",
        boxSizing: "border-box",
      },
      rect: toElementRect(svgRect),
      childNodes: [],
      content: serializeToolbarActionSvg(svg),
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
    });
  }

  childNodes.push({
    nodeType: NODE_TYPES.TEXT_NODE,
    id: generateNodeId(null),
    text,
    rect: {
      x: textRect.x,
      y: textRect.y,
      width: Math.max(textRect.width, estimateTextWidth(text, fontSize)),
      height: textRect.height,
    },
    lineCount: 1,
  });

  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: generateNodeId(null),
    tag: "DIV",
    attributes: { "data-h2d-toolbar-action": "true" },
    styles: {
      display: "block",
      position: "absolute",
      left: "0px",
      top: "0px",
      width: `${roundPx(rect.width)}px`,
      height: `${roundPx(rect.height)}px`,
      overflow: "visible",
      color: computed.color,
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize || `${roundPx(fontSize)}px`,
      fontWeight: computed.fontWeight,
      lineHeight: Number.isFinite(lineHeight) ? `${roundPx(lineHeight)}px` : computed.lineHeight,
      whiteSpace: "nowrap",
      textAlign: computed.textAlign,
      boxSizing: "border-box",
      zIndex: "120",
    },
    rect: toElementRect(rect),
    childNodes,
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function findToolbarActionSvg(source: Element): SVGElement | null {
  for (const svg of Array.from(source.querySelectorAll("svg"))) {
    if (!isInstanceOfOwner<SVGElement>(svg, svg, "SVGElement")) continue;
    if (!isElementVisibleInDocument(svg)) continue;

    const rect = svg.getBoundingClientRect();
    if (rect.width < 6 || rect.width > 32 || rect.height < 6 || rect.height > 32) continue;
    return svg;
  }

  return null;
}

function serializeToolbarActionSvg(svg: SVGElement): string {
  let content = new XMLSerializer().serializeToString(svg);
  if (!/\sxmlns=/.test(content)) {
    content = content.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return content;
}

function createTabTextOverlay(
  source: Element,
  text: string,
  kind: "primary" | "secondary",
): ElementSnapshot | null {
  const rect = source.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const computed = getComputedStyleFor(source);
  const textRect = getElementTextRangeRect(source) ?? getFallbackTextRect(rect, computed, text);
  const fontSize = parsePx(computed.fontSize, 12);
  const lineHeight = parseLineHeight(computed.lineHeight, fontSize);

  const textNode: TextSnapshot = {
    nodeType: NODE_TYPES.TEXT_NODE,
    id: generateNodeId(null),
    text,
    rect: {
      x: textRect.x,
      y: textRect.y,
      width: Math.max(textRect.width, estimateTextWidth(text, fontSize)),
      height: textRect.height,
    },
    lineCount: 1,
  };

  const styles: Record<string, string> = {
    display: "block",
    position: "absolute",
    left: "0px",
    top: "0px",
    width: `${roundPx(rect.width)}px`,
    height: `${roundPx(rect.height)}px`,
    overflow: "visible",
    color: computed.color,
    fontFamily: computed.fontFamily,
    fontSize: computed.fontSize || `${roundPx(fontSize)}px`,
    fontWeight: computed.fontWeight,
    lineHeight: Number.isFinite(lineHeight) ? `${roundPx(lineHeight)}px` : computed.lineHeight,
    whiteSpace: "nowrap",
    textAlign: computed.textAlign,
    boxSizing: "border-box",
    zIndex: "120",
  };

  copyTabOverlayPaint(computed, styles);

  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: generateNodeId(null),
    tag: "DIV",
    attributes: { "data-h2d-tab-overlay": kind },
    styles,
    rect: toElementRect(rect),
    childNodes: [textNode],
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function getElementTextRangeRect(element: Element): Rect | null {
  const textNodes: Node[] = [];
  const walker = getNodeDocument(element).createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();

  while (current) {
    if ((current.textContent || "").trim()) {
      const rect = getTextRect(current);
      if (rect.width > 0 && rect.height > 0) {
        textNodes.push(current);
      }
    }
    current = walker.nextNode();
  }

  if (textNodes.length === 0) return null;

  const rect = getTextRect(textNodes.length === 1 ? textNodes[0] : textNodes);
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

function getFallbackTextRect(rect: DOMRect, computed: CSSStyleDeclaration, text: string): Rect {
  const fontSize = parsePx(computed.fontSize, 12);
  const height = Math.max(fontSize * 1.2, Math.min(rect.height, fontSize * 1.6));
  const width = Math.min(rect.width, estimateTextWidth(text, fontSize));
  return {
    x: rect.x + Math.max(0, (rect.width - width) / 2),
    y: rect.y + Math.max(0, (rect.height - height) / 2),
    width,
    height,
  };
}

function copyTabOverlayPaint(computed: CSSStyleDeclaration, styles: Record<string, string>): void {
  if (isVisiblePaint(computed.backgroundColor)) {
    styles.backgroundColor = computed.backgroundColor;
  }

  for (const corner of ["TopLeft", "TopRight", "BottomRight", "BottomLeft"] as const) {
    const key = `border${corner}Radius` as keyof CSSStyleDeclaration;
    const value = computed[key] as string;
    if (parsePx(value, 0) > 0) {
      styles[`border${corner}Radius`] = value;
    }
  }

  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    const width = computed[`border${side}Width` as keyof CSSStyleDeclaration] as string;
    const style = computed[`border${side}Style` as keyof CSSStyleDeclaration] as string;
    const color = computed[`border${side}Color` as keyof CSSStyleDeclaration] as string;
    if (parsePx(width, 0) <= 0 || style === "none" || style === "hidden") continue;

    styles[`border${side}Width`] = width;
    styles[`border${side}Style`] = style;
    styles[`border${side}Color`] = color;
  }
}

function estimateTextWidth(text: string, fontSize: number): number {
  return Math.max(1, text.length * fontSize * 0.62);
}

function getStatusDistributionOverlayZIndex(root: Element): string {
  let maxZIndex = 0;
  let current: Element | null = root;

  while (current) {
    const computed = getComputedStyleFor(current);
    const zIndex = parseInt(computed.zIndex || "", 10);
    if (Number.isFinite(zIndex)) {
      maxZIndex = Math.max(maxZIndex, zIndex);
    }
    current = current.parentElement;
  }

  // Keep the lifted status bar above normal table backgrounds and sticky cells,
  // but below modal/drawer masks whose z-index is commonly 1000+.
  return String(Math.min(Math.max(maxZIndex + 1, 4), 99));
}

function collectStatusDistributionBars(rootElement: Element): StatusDistributionBar[] {
  const bars: StatusDistributionBar[] = [];
  const seen = new Set<Element>();
  const candidates = [rootElement, ...Array.from(rootElement.querySelectorAll("*"))];

  for (const candidate of candidates) {
    const bar = detectStatusDistributionBar(candidate);
    if (!bar || seen.has(bar.root)) continue;
    if (!isElementVisibleInDocument(bar.root)) continue;
    seen.add(bar.root);
    bars.push(bar);
  }

  return bars;
}

function isElementVisibleInDocument(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (isFullyClippedByHorizontalScrollAncestor(element, rect)) return false;
  if (isFullyClippedByVerticalOverlayScrollAncestor(element, rect)) return false;
  const computed = getComputedStyleFor(element);
  return computed.display !== "none" && computed.visibility !== "hidden" && computed.opacity !== "0";
}

function getCaptureScrollHeight(rootElement: Element, rootSnapshot: ElementSnapshot): number {
  const doc = getNodeDocument(rootElement);
  const view = getNodeWindow(rootElement);
  return Math.max(
    rootSnapshot.rect.height,
    rootElement.scrollHeight,
    doc.documentElement.scrollHeight,
    doc.body?.scrollHeight || 0,
    view.innerHeight,
  );
}

function extendLeftSidebarBackgrounds(
  rootSnapshot: ElementSnapshot,
  rootElement: Element,
  captureHeight: number,
): void {
  if (captureHeight <= rootSnapshot.rect.height + 4 && captureHeight <= getNodeWindow(rootElement).innerHeight + 4) {
    return;
  }

  const snapshotById = new Map<string, ElementSnapshot>();
  collectElementSnapshotsById(rootSnapshot, snapshotById);

  const candidates = [rootElement, ...Array.from(rootElement.querySelectorAll("*"))];
  for (const candidate of candidates) {
    const id = getNodeId(candidate);
    if (!id) continue;

    const snapshot = snapshotById.get(id);
    if (!snapshot || !isLeftSidebarBackgroundCandidate(candidate, snapshot, rootSnapshot, captureHeight)) {
      continue;
    }

    const targetBottom = rootSnapshot.rect.y + captureHeight;
    const targetHeight = targetBottom - snapshot.rect.y;
    if (targetHeight <= snapshot.rect.height + 4) continue;

    snapshot.rect.height = roundPx(targetHeight);
    snapshot.rect.cssHeight = Math.round(snapshot.rect.height);
    snapshot.styles.height = `${roundPx(snapshot.rect.height)}px`;
    snapshot.styles.minHeight = `${roundPx(snapshot.rect.height)}px`;

    const maxHeight = parsePx(snapshot.styles.maxHeight, NaN);
    if (Number.isFinite(maxHeight) && maxHeight < snapshot.rect.height) {
      delete snapshot.styles.maxHeight;
    }
  }
}

function collectElementSnapshotsById(node: ElementSnapshot, snapshots: Map<string, ElementSnapshot>): void {
  snapshots.set(node.id, node);

  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;
    collectElementSnapshotsById(child, snapshots);
  }
}

function isLeftSidebarBackgroundCandidate(
  element: Element,
  snapshot: ElementSnapshot,
  rootSnapshot: ElementSnapshot,
  captureHeight: number,
): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "HTML" || tag === "BODY") return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 48 || rect.width > 360 || rect.height < 240) return false;

  const view = getNodeWindow(element);
  if (captureHeight <= rect.height + 64) return false;
  if (rect.height < view.innerHeight * 0.55 || rect.height > view.innerHeight + 96) return false;

  if (snapshot.rect.x > rootSnapshot.rect.x + 8) return false;
  if (snapshot.rect.y > rootSnapshot.rect.y + 32) return false;

  const computed = getComputedStyleFor(element);
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;
  if (!hasExtendableSidebarPaint(computed)) return false;

  const identity = getElementIdentity(element);
  const looksLikeSidebar = /(^|[-_\s])(aside|sidebar|side-bar|sider|layout-sider|side-menu|el-menu|ant-menu|nav|menu)([-_\s]|$)/i.test(identity);
  const pinnedToViewport = computed.position === "fixed" || computed.position === "sticky";
  const fillsViewport = rect.height >= view.innerHeight * 0.85;

  return looksLikeSidebar || pinnedToViewport || fillsViewport;
}

function hasExtendableSidebarPaint(computed: CSSStyleDeclaration): boolean {
  if (computed.backgroundImage && computed.backgroundImage !== "none") return true;
  if (!isVisiblePaint(computed.backgroundColor)) return false;
  return !isNearWhitePaint(computed.backgroundColor);
}

function pruneStatusDistributionSnapshots(root: ElementSnapshot): void {
  root.childNodes = root.childNodes.filter((child) => {
    if (!isElementNodeSnapshot(child)) return true;
    if (child.attributes["data-h2d-status-distribution"] === "true") return false;
    pruneStatusDistributionSnapshots(child);
    return true;
  });
}

function ensureInsetShadowBorder(element: Element, styles: Record<string, string>): void {
  const rect = element.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 16 || rect.height > 80) return;
  if (!isFormControlSurface(element)) return;

  const computed = getComputedStyleFor(element);
  if (!computed.boxShadow || computed.boxShadow === "none" || !/\binset\b/i.test(computed.boxShadow)) return;
  if (hasVisibleBorderStyles(computed)) return;

  const color = extractCssColor(computed.boxShadow) || "rgb(220, 223, 230)";
  styles.borderTopWidth = "1px";
  styles.borderRightWidth = "1px";
  styles.borderBottomWidth = "1px";
  styles.borderLeftWidth = "1px";
  styles.borderTopStyle = "solid";
  styles.borderRightStyle = "solid";
  styles.borderBottomStyle = "solid";
  styles.borderLeftStyle = "solid";
  styles.borderTopColor = color;
  styles.borderRightColor = color;
  styles.borderBottomColor = color;
  styles.borderLeftColor = color;
}

function isFormControlSurface(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;

  const directInput = Array.from(element.children).some((child) => {
    const childTag = child.tagName.toUpperCase();
    return childTag === "INPUT" || childTag === "TEXTAREA" || childTag === "SELECT";
  });
  if (directInput) return true;

  const identity = `${String((element as HTMLElement | SVGElement).className || "")} ${element.id || ""} ${element.getAttribute("role") || ""}`;
  return /(^|[-_\s])(input|textarea|select|combobox|picker|control|wrapper)([-_\s]|$)/i.test(identity);
}

function hasVisibleBorderStyles(computed: CSSStyleDeclaration): boolean {
  return [
    [computed.borderTopWidth, computed.borderTopStyle],
    [computed.borderRightWidth, computed.borderRightStyle],
    [computed.borderBottomWidth, computed.borderBottomStyle],
    [computed.borderLeftWidth, computed.borderLeftStyle],
  ].some(([width, style]) => parsePx(width, 0) > 0 && style !== "none" && style !== "hidden");
}

function extractCssColor(value: string): string | undefined {
  return value.match(/rgba?\([^)]+\)/)?.[0];
}

function normalizeSmallSvgImageRect(
  element: Element,
  styles: Record<string, string>,
  rect: ElementRect,
): ElementRect {
  if (!isInstanceOfOwner<HTMLImageElement>(element, element, "HTMLImageElement")) return rect;
  if (rect.width <= 0 || rect.width > 32 || rect.height <= rect.width * 1.8) return rect;

  const src = element.currentSrc || element.src || element.getAttribute("src") || "";
  if (!/\\.svg(?:$|[?#])/i.test(src) && !src.startsWith("data:image/svg")) return rect;

  const size = rect.width;
  const y = rect.y + (rect.height - size) / 2;
  styles.width = `${roundPx(size)}px`;
  styles.height = `${roundPx(size)}px`;
  styles.lineHeight = `${roundPx(size)}px`;
  styles.objectFit = "contain";

  return {
    ...rect,
    y,
    height: size,
    cssHeight: Math.round(size),
  };
}

function ensureTextOnlyLineHeight(element: Element, styles: Record<string, string>): void {
  const lineHeight = parsePx(styles.lineHeight, NaN);
  const fontSize = parsePx(styles.fontSize, NaN);
  if (!Number.isFinite(lineHeight) || !Number.isFinite(fontSize)) return;
  if (lineHeight <= Math.max(32, fontSize * 2)) return;

  const textNodes = getDirectTextNodes(element);
  if (textNodes.length === 0) return;

  const textRect = getTextRect(textNodes.length === 1 ? textNodes[0] : textNodes);
  if (textRect.lineCount !== 1 || textRect.width <= 0 || textRect.height <= 0) return;
  if (textRect.height >= lineHeight * 0.75) return;

  styles.lineHeight = `${roundPx(Math.max(textRect.height, fontSize * 1.2))}px`;
}

function getDirectTextNodes(element: Element): Node[] {
  const textNodes: Node[] = [];

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) return [];
    if (child.nodeType !== Node.TEXT_NODE) continue;
    if (!(child.textContent || "").trim()) continue;
    textNodes.push(child);
  }

  return textNodes;
}

function stabilizeHorizontalScrolledTableViewport(
  element: Element,
  styles: Record<string, string>,
  childNodes: SnapshotNode[],
  rect: ElementRect,
): void {
  if (!isHorizontalScrolledTableViewport(element, rect)) return;

  const visibleCells = getVisibleTableCellSnapshots(element, childNodes);
  if (visibleCells.length === 0) return;

  childNodes.splice(0, childNodes.length, ...visibleCells);

  styles.display = "block";
  styles.position = styles.position && styles.position !== "static" ? styles.position : "relative";
  styles.overflow = "hidden";
  styles.overflowX = "hidden";
  styles.overflowY = "hidden";
  styles.width = `${roundPx(rect.width)}px`;
  styles.height = `${roundPx(rect.height)}px`;
  styles.boxSizing = "border-box";
}

function isHorizontalScrolledTableViewport(element: Element, rect: { width: number; height: number }): boolean {
  if (!isInstanceOfOwner<HTMLElement>(element, element, "HTMLElement")) return false;
  if (element.scrollLeft <= 0 || element.scrollWidth <= element.clientWidth + 1) return false;
  if (rect.width < 240 || rect.height < 80) return false;

  const computed = getComputedStyleFor(element);
  if (!/^(auto|scroll|hidden|clip)$/i.test(computed.overflowX) && !/^(auto|scroll|hidden|clip)$/i.test(computed.overflow)) {
    return false;
  }

  return Boolean(element.querySelector("table th, table td, [role=\"gridcell\"], [role=\"columnheader\"]"));
}

function getVisibleTableCellSnapshots(element: Element, childNodes: SnapshotNode[]): ElementSnapshot[] {
  const snapshotById = new Map<string, ElementSnapshot>();
  for (const child of childNodes) {
    if (isElementNodeSnapshot(child)) {
      collectElementSnapshotsById(child, snapshotById);
    }
  }

  const viewportRect = element.getBoundingClientRect();
  const entries: ElementSnapshot[] = [];
  const seen = new Set<ElementSnapshot>();
  const cells = Array.from(element.querySelectorAll("th, td, [role=\"gridcell\"], [role=\"columnheader\"]"));

  for (const cell of cells) {
    const id = getNodeId(cell);
    if (!id) continue;

    const snapshot = snapshotById.get(id);
    if (!snapshot || seen.has(snapshot)) continue;
    if (!isTableCellVisibleInScrollViewport(cell, viewportRect)) continue;

    seen.add(snapshot);
    entries.push(materializeVisibleTableCell(snapshot, viewportRect, cell));
  }

  return entries;
}

function isTableCellVisibleInScrollViewport(cell: Element, viewportRect: DOMRect): boolean {
  const rect = cell.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.right <= viewportRect.left || rect.left >= viewportRect.right) return false;
  if (rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom) return false;

  const computed = getComputedStyleFor(cell);
  return computed.display !== "none" && computed.visibility !== "hidden" && computed.opacity !== "0";
}

function materializeVisibleTableCell(
  cell: ElementSnapshot,
  viewportRect: { x: number; y: number; width: number; height: number },
  source: Element,
): ElementSnapshot {
  const computed = getComputedStyleFor(source);
  const zIndex = parseInt(computed.zIndex || "", 10);

  cell.tag = "DIV";
  cell.styles.display = "block";
  anchorSnapshotToParent(cell, viewportRect);

  if (computed.position === "sticky" || computed.position === "fixed") {
    const currentZIndex = parseInt(cell.styles.zIndex || "", 10);
    if (!Number.isFinite(currentZIndex) || currentZIndex < 3) {
      cell.styles.zIndex = Number.isFinite(zIndex) ? String(Math.max(3, zIndex)) : "3";
    }
  }

  return cell;
}

function stabilizeTopChromeLayout(
  element: Element,
  styles: Record<string, string>,
  childNodes: SnapshotNode[],
): void {
  if (!isTopChromeContainer(element, childNodes)) return;

  styles.position = styles.position && styles.position !== "static" ? styles.position : "relative";
  styles.overflow = "visible";
  styles.overflowX = "visible";
  styles.overflowY = "visible";

  const parentRect = element.getBoundingClientRect();
  for (const child of childNodes) {
    if (!isElementNodeSnapshot(child)) continue;
    if (!isDirectTopChromeChild(child, parentRect)) continue;
    anchorSnapshotToParent(child, parentRect);
  }
}

function isTopChromeContainer(element: Element, childNodes: SnapshotNode[]): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.y > 96 || rect.height < 12 || rect.height > 72 || rect.width <= 0) return false;
  if (isTopChromeInlineGroup(element, childNodes, rect)) return true;
  if (rect.width < 320) return false;

  const identity = getElementIdentity(element);
  if (/(^|[-_\s])(navbar|nav-bar|topbar|top-bar|app-header|header)([-_\s]|$)/i.test(identity)) {
    return hasTopChromeDirectChildren(childNodes, rect);
  }

  if (!hasTopChromeAnchors(element)) return false;
  return hasTopChromeDirectChildren(childNodes, rect);
}

function isTopChromeInlineGroup(
  element: Element,
  childNodes: SnapshotNode[],
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  if (!hasElementSnapshotChild(childNodes)) return false;

  const identity = getElementIdentity(element);
  if (!/(^|[-_\s])(breadcrumb|right-menu|avatar|hamburger|user-avatar|hover-effect|el-breadcrumb|el-dropdown)([-_\s]|$)/i.test(identity)) {
    return false;
  }

  return childNodes.some((child) => isElementNodeSnapshot(child) && isDirectTopChromeChild(child, rect));
}

function hasElementSnapshotChild(childNodes: SnapshotNode[]): boolean {
  return childNodes.some(isElementNodeSnapshot);
}

function hasTopChromeAnchors(element: Element): boolean {
  return Boolean(element.querySelector(
    "#breadcrumb-container, #hamburger-container, .right-menu, .avatar-container, .navbar",
  ));
}

function hasTopChromeDirectChildren(
  childNodes: SnapshotNode[],
  parentRect: { x: number; y: number; width: number; height: number },
): boolean {
  let leftChrome = false;
  let rightChrome = false;

  for (const child of childNodes) {
    if (!isElementNodeSnapshot(child)) continue;
    if (!isDirectTopChromeChild(child, parentRect)) continue;

    const childCenter = child.rect.x + child.rect.width / 2;
    if (childCenter < parentRect.x + parentRect.width * 0.35) leftChrome = true;
    if (childCenter > parentRect.x + parentRect.width * 0.65) rightChrome = true;
  }

  return leftChrome || rightChrome;
}

function isDirectTopChromeChild(
  child: ElementSnapshot,
  parentRect: { x: number; y: number; width: number; height: number },
): boolean {
  if (child.rect.width <= 0 || child.rect.height <= 0) return false;
  if (child.rect.height > parentRect.height + 8) return false;
  if (child.rect.y < parentRect.y - 4 || child.rect.y > parentRect.y + parentRect.height + 4) return false;
  if (child.rect.x + child.rect.width < parentRect.x - 4) return false;
  if (child.rect.x > parentRect.x + parentRect.width + 4) return false;
  return true;
}

function anchorSnapshotToParent(
  node: ElementSnapshot,
  parentRect: { x: number; y: number; width: number; height: number },
): void {
  delete node.styles.flexGrow;
  delete node.styles.flexShrink;
  delete node.styles.flexBasis;
  delete node.styles.alignSelf;
  delete node.styles.order;
  delete node.styles.gridColumn;
  delete node.styles.gridColumnStart;
  delete node.styles.gridColumnEnd;
  delete node.styles.gridRow;
  delete node.styles.gridRowStart;
  delete node.styles.gridRowEnd;
  delete node.styles.margin;
  delete node.styles.marginTop;
  delete node.styles.marginRight;
  delete node.styles.marginBottom;
  delete node.styles.marginLeft;

  node.styles.position = "absolute";
  node.styles.left = `${roundPx(node.rect.x - parentRect.x)}px`;
  node.styles.top = `${roundPx(node.rect.y - parentRect.y)}px`;
  node.styles.width = `${roundPx(node.rect.width)}px`;
  node.styles.height = `${roundPx(node.rect.height)}px`;
  node.styles.boxSizing = "border-box";
  node.styles.cssFloat = "none";
  node.layoutSizingHorizontal = "FIXED";
  node.layoutSizingVertical = "FIXED";
}

function getElementIdentity(element: Element): string {
  return `${String((element as HTMLElement | SVGElement).className || "")} ${element.id || ""} ${element.getAttribute("role") || ""}`;
}

function normalizeTopChromeTextLineBox(
  element: Element,
  styles: Record<string, string>,
  childNodes: SnapshotNode[],
  rect: ElementRect,
): ElementRect {
  if (!hasDirectTextSnapshot(childNodes)) return rect;

  const lineBox = getBreadcrumbLineBox(element);
  if (!lineBox) return rect;
  if (rect.width <= 0 || rect.height <= 0 || rect.height >= lineBox.height * 0.75) return rect;

  const targetTextTop = lineBox.y + Math.max(0, (lineBox.height - rect.height) / 2);
  const textDelta = targetTextTop - rect.y;
  for (const child of childNodes) {
    if (child.nodeType !== NODE_TYPES.TEXT_NODE || !child.text.trim()) continue;
    child.rect.y = roundPx(child.rect.y + textDelta);
  }

  styles.display = styles.display === "inline" ? "block" : styles.display;
  styles.height = `${roundPx(lineBox.height)}px`;
  styles.lineHeight = `${roundPx(lineBox.height)}px`;
  styles.verticalAlign = "top";

  return {
    ...rect,
    y: lineBox.y,
    height: lineBox.height,
    cssHeight: Math.round(lineBox.height),
  };
}

function hasDirectTextSnapshot(childNodes: SnapshotNode[]): boolean {
  return childNodes.some((child) => child.nodeType === NODE_TYPES.TEXT_NODE && child.text.trim());
}

function getBreadcrumbLineBox(element: Element): DOMRect | null {
  const breadcrumb = element.closest?.("#breadcrumb-container, .el-breadcrumb, [aria-label=\"面包屑\"]");
  if (!breadcrumb) return null;

  const rect = breadcrumb.getBoundingClientRect();
  if (rect.y > 96 || rect.height < 32 || rect.height > 72 || rect.width <= 0) return null;
  return rect;
}

function ensureInputPrefixIconsStackAbove(childNodes: SnapshotNode[]): void {
  if (childNodes.length < 2) return;

  const inputNodes = childNodes.filter(isInputSnapshot);
  if (inputNodes.length === 0) return;

  const prefixNodes: ElementSnapshot[] = [];
  for (const child of childNodes) {
    if (!isElementNodeSnapshot(child)) continue;
    if (!isInputPrefixIconSnapshot(child, inputNodes)) continue;
    prefixNodes.push(child);
  }
  if (prefixNodes.length === 0) return;

  for (const prefixNode of prefixNodes) {
    const currentIndex = childNodes.indexOf(prefixNode);
    if (currentIndex < 0) continue;
    childNodes.splice(currentIndex, 1);
    childNodes.push(prefixNode);
  }
}

function isInputSnapshot(node: SnapshotNode): node is ElementSnapshot {
  return isElementNodeSnapshot(node) && node.tag === "INPUT";
}

function isInputPrefixIconSnapshot(node: ElementSnapshot, inputNodes: ElementSnapshot[]): boolean {
  if (node.rect.width <= 0 || node.rect.height <= 0 || node.rect.width > 40 || node.rect.height > 40) return false;
  if (!hasSvgDescendant(node)) return false;

  const position = node.styles.position || "";
  const zIndex = parseInt(node.styles.zIndex || "", 10);
  if (position !== "absolute" && (!Number.isFinite(zIndex) || zIndex <= 0)) return false;

  return inputNodes.some((input) => {
    const iconCenterX = node.rect.x + node.rect.width / 2;
    const iconCenterY = node.rect.y + node.rect.height / 2;
    const leftZoneWidth = Math.min(48, Math.max(24, input.rect.width * 0.25));

    return (
      iconCenterX >= input.rect.x &&
      iconCenterX <= input.rect.x + leftZoneWidth &&
      iconCenterY >= input.rect.y &&
      iconCenterY <= input.rect.y + input.rect.height
    );
  });
}

function hasSvgDescendant(node: ElementSnapshot): boolean {
  if (node.tag === "SVG") return true;
  return node.childNodes.some((child) => isElementNodeSnapshot(child) && hasSvgDescendant(child));
}

interface SelectSnapshotEntry {
  node: ElementSnapshot;
  parent: ElementSnapshot;
  text: string;
}

function removeStackedSelectClones(root: ElementSnapshot): void {
  const entries: SelectSnapshotEntry[] = [];
  collectSelectSnapshots(root, entries);
  if (entries.length < 2) return;

  const sorted = [...entries].sort((a, b) => a.node.rect.y - b.node.rect.y);
  const remove = new Set<ElementSnapshot>();

  for (let index = 0; index < sorted.length; index += 1) {
    const candidate = sorted[index];
    if (!candidate || remove.has(candidate.node)) continue;

    for (let prevIndex = 0; prevIndex < index; prevIndex += 1) {
      const previous = sorted[prevIndex];
      if (!previous || remove.has(previous.node)) continue;
      if (!isStackedSelectClone(previous, candidate)) continue;

      remove.add(candidate.node);
      break;
    }
  }

  if (remove.size === 0) return;

  for (const entry of entries) {
    if (!remove.has(entry.node)) continue;
    entry.parent.childNodes = entry.parent.childNodes.filter((child) => child !== entry.node);
  }
}

function collectSelectSnapshots(node: ElementSnapshot, entries: SelectSnapshotEntry[]): void {
  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    if (child.attributes["data-h2d-select-control"] === "true") {
      entries.push({
        node: child,
        parent: node,
        text: getSnapshotText(child),
      });
    }

    collectSelectSnapshots(child, entries);
  }
}

function isStackedSelectClone(previous: SelectSnapshotEntry, candidate: SelectSnapshotEntry): boolean {
  if (!previous.text || previous.text !== candidate.text) return false;

  const first = previous.node.rect;
  const second = candidate.node.rect;
  if (isContainedSelectClone(first, second, candidate.node)) return true;

  const verticalGap = second.y - (first.y + first.height);
  if (verticalGap < -4 || verticalGap > 12) return false;

  const widthDelta = Math.abs(first.width - second.width);
  const heightDelta = Math.abs(first.height - second.height);
  if (widthDelta > Math.max(8, first.width * 0.08)) return false;
  if (heightDelta > Math.max(4, first.height * 0.2)) return false;

  const overlap = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
  return overlap >= Math.min(first.width, second.width) * 0.8;
}

function isContainedSelectClone(
  outer: ElementRect,
  inner: ElementRect,
  innerNode: ElementSnapshot,
): boolean {
  if (inner.width <= 0 || inner.height <= 0) return false;
  if (inner.width > outer.width || inner.height > outer.height) return false;

  const overlapWidth = Math.min(outer.x + outer.width, inner.x + inner.width) - Math.max(outer.x, inner.x);
  const overlapHeight = Math.min(outer.y + outer.height, inner.y + inner.height) - Math.max(outer.y, inner.y);
  if (overlapWidth <= 0 || overlapHeight <= 0) return false;

  const overlapArea = overlapWidth * overlapHeight;
  const innerArea = inner.width * inner.height;
  if (overlapArea < innerArea * 0.9) return false;

  const isMeaningfullySmaller =
    inner.width <= outer.width - 12 ||
    inner.height <= outer.height - 2 ||
    hasGeneratedSelectArrow(innerNode);
  return isMeaningfullySmaller;
}

function hasGeneratedSelectArrow(node: ElementSnapshot): boolean {
  return node.childNodes.some((child) => {
    if (!isElementNodeSnapshot(child)) return false;
    if (child.attributes["data-h2d-select-arrow"] === "generated") return true;
    return hasGeneratedSelectArrow(child);
  });
}

function getSnapshotText(node: SnapshotNode): string {
  if (node.nodeType === NODE_TYPES.TEXT_NODE) return node.text.replace(/\s+/g, " ").trim();
  if (!isElementNodeSnapshot(node)) return "";

  return node.childNodes
    .map((child) => getSnapshotText(child))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Pseudo-element materialization
// ---------------------------------------------------------------------------

function materializePseudoElements(element: Element, childNodes: SnapshotNode[]): Set<string> {
  const materialized = new Set<string>();

  for (const pseudo of ["::before", "::after"] as const) {
    const pseudoNode =
      snapshotTextPseudoElement(element, pseudo) ??
      snapshotPaintPseudoElement(element, pseudo);
    if (!pseudoNode) continue;

    if (pseudo === "::before") {
      childNodes.unshift(pseudoNode);
    } else {
      childNodes.push(pseudoNode);
    }
    materialized.add(pseudo);
  }

  return materialized;
}

function snapshotPseudoChevronIcon(element: Element): ElementSnapshot | null {
  const tag = element.tagName.toUpperCase();
  if (tag !== "I" && tag !== "SPAN") return null;

  const before = getComputedStyleFor(element, "::before");
  const after = getComputedStyleFor(element, "::after");
  if (!isPaintPseudoCandidate(element, before) || !isPaintPseudoCandidate(element, after)) return null;
  if (!isChevronPseudoBar(before) || !isChevronPseudoBar(after)) return null;

  const hostRect = element.getBoundingClientRect();
  if (hostRect.width <= 0 && hostRect.height <= 0) return null;

  const size = Math.max(10, Math.min(14, Math.max(hostRect.width || 0, hostRect.height || 12)));
  const x = hostRect.x + (hostRect.width - size) / 2;
  const y = hostRect.height > 0
    ? hostRect.y + (hostRect.height - size) / 2
    : hostRect.y - size / 2;
  const direction = getPseudoChevronDirection(element, before, after);
  const color = getPseudoChevronColor(element, before, after);

  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: generateNodeId(element),
    tag: "SVG",
    attributes: {
      "data-h2d-pseudo-chevron": direction,
    },
    styles: {
      display: "block",
      position: "absolute",
      left: "0px",
      top: "0px",
      width: `${roundPx(size)}px`,
      height: `${roundPx(size)}px`,
      color,
      overflow: "visible",
      boxSizing: "border-box",
    },
    rect: toElementRect(new DOMRect(x, y, size, size)),
    childNodes: [],
    content: createPseudoChevronSvg(direction, color),
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function isChevronPseudoBar(computed: CSSStyleDeclaration): boolean {
  if (!computed.transform || computed.transform === "none") return false;

  const width = parsePx(computed.width, 0);
  const height = parsePx(computed.height, 0);
  if (width <= 0 || height <= 0) return false;
  return Math.max(width, height) / Math.max(1, Math.min(width, height)) >= 2;
}

function getPseudoChevronDirection(
  element: Element,
  before: CSSStyleDeclaration,
  after: CSSStyleDeclaration,
): "up" | "down" {
  let current: Element | null = element;
  let depth = 0;
  while (current && depth < 5) {
    const expanded = current.getAttribute("aria-expanded");
    if (expanded === "true") return "up";
    if (expanded === "false") return "down";
    current = current.parentElement;
    depth += 1;
  }

  const beforeAngle = getTransformRotationAngle(before.transform);
  const afterAngle = getTransformRotationAngle(after.transform);
  if (Number.isFinite(beforeAngle) && Number.isFinite(afterAngle) && beforeAngle < afterAngle) {
    return "up";
  }

  return "down";
}

function getTransformRotationAngle(transform: string): number {
  if (!transform || transform === "none") return NaN;

  const matrixMatch = transform.match(/matrix\(([^)]+)\)/);
  if (matrixMatch) {
    const values = matrixMatch[1].split(",").map((value) => parseFloat(value.trim()));
    if (values.length >= 2 && Number.isFinite(values[0]) && Number.isFinite(values[1])) {
      return Math.atan2(values[1], values[0]) * (180 / Math.PI);
    }
  }

  const rotateMatch = transform.match(/rotate\(([-\d.]+)deg\)/);
  if (rotateMatch) {
    const angle = parseFloat(rotateMatch[1]);
    if (Number.isFinite(angle)) return angle;
  }

  return NaN;
}

function getPseudoChevronColor(
  element: Element,
  before: CSSStyleDeclaration,
  after: CSSStyleDeclaration,
): string {
  if (isVisiblePaint(before.backgroundColor)) return before.backgroundColor;
  if (isVisiblePaint(after.backgroundColor)) return after.backgroundColor;

  const computed = getComputedStyleFor(element);
  return isVisiblePaint(computed.color) ? computed.color : "rgb(134, 136, 143)";
}

function createPseudoChevronSvg(direction: "up" | "down", color: string): string {
  const path = direction === "up"
    ? "M3 7.5 6 4.5 9 7.5"
    : "M3 4.5 6 7.5 9 4.5";
  const stroke = escapeSvgAttribute(color);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function escapeSvgAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function snapshotCircularProgressSvg(element: Element): ElementSnapshot | null {
  if (!isInstanceOfOwner<SVGElement>(element, element, "SVGElement")) return null;

  const svg = element as SVGElement;
  const circles = Array.from(svg.querySelectorAll("circle")) as SVGCircleElement[];
  if (circles.length < 2) return null;

  const rect = svg.getBoundingClientRect();
  if (rect.width < 16 || rect.height < 16 || rect.width > 120 || rect.height > 120) return null;

  const progressCircle = circles[circles.length - 1];
  const trackCircle = circles[0];
  const radius = getSvgAnimatedLength(progressCircle.r, parseFloat(progressCircle.getAttribute("r") || ""));
  if (!Number.isFinite(radius) || radius <= 0) return null;

  const percent = getCircularProgressPercent(svg, progressCircle, radius);
  if (percent == null) return null;

  const svgComputed = getComputedStyleFor(svg);
  const progressComputed = getComputedStyleFor(progressCircle);
  const trackComputed = getComputedStyleFor(trackCircle);
  const viewBox = getSvgViewBox(svg, rect);
  const cx = getSvgAnimatedLength(progressCircle.cx, viewBox.x + viewBox.width / 2);
  const cy = getSvgAnimatedLength(progressCircle.cy, viewBox.y + viewBox.height / 2);
  const strokeWidth = Math.max(1, parsePx(progressComputed.strokeWidth, parseFloat(progressCircle.getAttribute("stroke-width") || "1")));
  const trackColor = getSvgStrokeColor(trackCircle, trackComputed, "rgb(240, 242, 245)");
  const progressColor = getSvgStrokeColor(progressCircle, progressComputed, "rgb(22, 119, 255)");

  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: generateNodeId(svg),
    tag: "SVG",
    attributes: { "data-h2d-circular-progress": "true" },
    styles: {
      display: "block",
      width: `${roundPx(rect.width)}px`,
      height: `${roundPx(rect.height)}px`,
      color: svgComputed.color,
      overflow: "visible",
      boxSizing: "border-box",
    },
    rect: toElementRect(rect),
    childNodes: [],
    content: createCircularProgressSvg({
      viewBox,
      cx,
      cy,
      radius,
      strokeWidth,
      trackColor,
      progressColor,
      percent,
    }),
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function getSvgAnimatedLength(length: SVGAnimatedLength | undefined, fallback: number): number {
  const value = length?.baseVal?.value;
  return Number.isFinite(value) ? value as number : fallback;
}

function getSvgViewBox(svg: SVGElement, rect: DOMRect): { x: number; y: number; width: number; height: number } {
  const viewBox = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map((value) => parseFloat(value)) || [];
  if (viewBox.length === 4 && viewBox.every(Number.isFinite)) {
    return { x: viewBox[0], y: viewBox[1], width: viewBox[2], height: viewBox[3] };
  }

  const width = parsePx(getComputedStyleFor(svg).width, rect.width);
  const height = parsePx(getComputedStyleFor(svg).height, rect.height);
  return { x: 0, y: 0, width, height };
}

function getCircularProgressPercent(svg: SVGElement, progressCircle: SVGCircleElement, radius: number): number | null {
  const textPercent = getNearbyPercentText(svg);
  if (textPercent != null) return textPercent;

  const computed = getComputedStyleFor(progressCircle);
  const circumference = 2 * Math.PI * radius;
  const pathLength = parseFloat(progressCircle.getAttribute("pathLength") || "");
  const dashArray = parseSvgNumberList(
    computed.getPropertyValue("stroke-dasharray") ||
    computed.strokeDasharray ||
    progressCircle.getAttribute("stroke-dasharray") ||
    "",
  );

  if (dashArray.length > 0 && dashArray[0] > 0) {
    const dash = dashArray[0];
    if (Number.isFinite(pathLength) && pathLength > 0) return clampPercent((dash / pathLength) * 100);
    if (dash <= 100 && dashArray.some((value) => value >= 90 && value <= 110)) return clampPercent(dash);
    return clampPercent((dash / circumference) * 100);
  }

  const dashOffset = parseFloat(
    computed.getPropertyValue("stroke-dashoffset") ||
    computed.strokeDashoffset ||
    progressCircle.getAttribute("stroke-dashoffset") ||
    "",
  );
  if (Number.isFinite(dashOffset) && circumference > 0) {
    return clampPercent(((circumference - dashOffset) / circumference) * 100);
  }

  return null;
}

function getNearbyPercentText(svg: SVGElement): number | null {
  let current: Element | null = svg.parentElement;
  let depth = 0;
  while (current && depth < 4) {
    const match = (current.textContent || "").match(/(\d+(?:\.\d+)?)\s*%/);
    if (match) return clampPercent(parseFloat(match[1]));
    current = current.parentElement;
    depth += 1;
  }
  return null;
}

function parseSvgNumberList(value: string): number[] {
  if (!value || value === "none") return [];
  return value
    .split(/[\s,]+/)
    .map((part) => parseFloat(part))
    .filter(Number.isFinite);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function getSvgStrokeColor(circle: SVGCircleElement, computed: CSSStyleDeclaration, fallback: string): string {
  return firstVisiblePaint(
    computed.getPropertyValue("stroke"),
    computed.stroke,
    circle.getAttribute("stroke") || "",
    fallback,
  );
}

function createCircularProgressSvg(options: {
  viewBox: { x: number; y: number; width: number; height: number };
  cx: number;
  cy: number;
  radius: number;
  strokeWidth: number;
  trackColor: string;
  progressColor: string;
  percent: number;
}): string {
  const viewBox = `${roundPx(options.viewBox.x)} ${roundPx(options.viewBox.y)} ${roundPx(options.viewBox.width)} ${roundPx(options.viewBox.height)}`;
  const cx = roundPx(options.cx);
  const cy = roundPx(options.cy);
  const radius = roundPx(options.radius);
  const strokeWidth = roundPx(options.strokeWidth);
  const track = escapeSvgAttribute(options.trackColor);
  const progress = escapeSvgAttribute(options.progressColor);
  const trackCircle = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${track}" stroke-width="${strokeWidth}"/>`;

  if (options.percent <= 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" overflow="visible">${trackCircle}</svg>`;
  }

  if (options.percent >= 99.9) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" overflow="visible">${trackCircle}<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${progress}" stroke-width="${strokeWidth}" stroke-linecap="round"/></svg>`;
  }

  const arcPath = describeArc(options.cx, options.cy, options.radius, -90, -90 + (options.percent / 100) * 360);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" overflow="visible">${trackCircle}<path d="${arcPath}" fill="none" stroke="${progress}" stroke-width="${strokeWidth}" stroke-linecap="round"/></svg>`;
}

function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, radius, startAngle);
  const end = polarToCartesian(cx, cy, radius, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${roundPx(start.x)} ${roundPx(start.y)} A ${roundPx(radius)} ${roundPx(radius)} 0 ${largeArcFlag} 1 ${roundPx(end.x)} ${roundPx(end.y)}`;
}

function polarToCartesian(cx: number, cy: number, radius: number, angleInDegrees: number): { x: number; y: number } {
  const angleInRadians = angleInDegrees * Math.PI / 180;
  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians),
  };
}

function snapshotPaintPseudoElement(element: Element, pseudo: "::before" | "::after"): ElementSnapshot | null {
  const computed = getComputedStyleFor(element, pseudo);
  if (!isPaintPseudoCandidate(element, computed)) return null;

  const width = parsePx(computed.width, NaN);
  const height = parsePx(computed.height, NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const hostRect = element.getBoundingClientRect();
  if (hostRect.width <= 0 && hostRect.height <= 0) return null;

  const inlineMarkerRect = computeInlinePaintPseudoMarkerRect(element, pseudo, hostRect, computed, width, height);
  const rect = inlineMarkerRect ?? computePaintPseudoRect(pseudo, hostRect, computed, width, height);
  const styles = getPaintPseudoStyles(computed, width, height);
  const transform = inlineMarkerRect ? undefined : resolveTransform(computed);

  return {
    nodeType: Node.ELEMENT_NODE as 1,
    id: generateNodeId(null),
    tag: "SPAN",
    attributes: {
      "data-h2d-pseudo": pseudo === "::before" ? "before" : "after",
      "data-h2d-pseudo-kind": "paint",
    },
    styles,
    rect: toElementRect(rect),
    childNodes: [],
    relativeTransform: transform ? matrixToSimple(transform) : undefined,
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function isPaintPseudoCandidate(element: Element, computed: CSSStyleDeclaration): boolean {
  const hostTag = element.tagName.toUpperCase();
  const isIconHost = hostTag === "I" || hostTag === "SPAN";
  if (!isIconHost && !isSmallMarkerPseudoCandidate(element, computed)) return false;

  const hostRect = element.getBoundingClientRect();
  if (isIconHost && (hostRect.width > 48 || hostRect.height > 48)) return false;

  const text = parseCssTextContent(computed.content);
  if (text && text.trim()) return false;

  const width = parsePx(computed.width, NaN);
  const height = parsePx(computed.height, NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0 || width > 32 || height > 32) return false;

  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") {
    return false;
  }

  return isVisiblePaint(computed.backgroundColor) || hasVisibleBorderStyles(computed);
}

function isSmallMarkerPseudoCandidate(element: Element, computed: CSSStyleDeclaration): boolean {
  const hostRect = element.getBoundingClientRect();
  if (hostRect.width <= 0 || hostRect.height <= 0 || hostRect.height > 80) return false;

  const width = parsePx(computed.width, NaN);
  const height = parsePx(computed.height, NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0 || width > 10 || height > 36) return false;
  if (!isVisiblePaint(computed.backgroundColor) && !hasVisibleBorderStyles(computed)) return false;

  const left = parsePx(computed.left, NaN);
  const top = parsePx(computed.top, NaN);
  const bottom = parsePx(computed.bottom, NaN);
  return Number.isFinite(left) || Number.isFinite(top) || Number.isFinite(bottom) || computed.position === "absolute";
}

function computePaintPseudoRect(
  pseudo: "::before" | "::after",
  hostRect: DOMRect,
  computed: CSSStyleDeclaration,
  width: number,
  height: number,
): DOMRect {
  const marginLeft = parsePx(computed.marginLeft, 0);
  const marginRight = parsePx(computed.marginRight, 0);
  const marginTop = parsePx(computed.marginTop, 0);
  const marginBottom = parsePx(computed.marginBottom, 0);
  const left = parsePx(computed.left, NaN);
  const right = parsePx(computed.right, NaN);
  const top = parsePx(computed.top, NaN);
  const bottom = parsePx(computed.bottom, NaN);

  let x: number;
  if (Number.isFinite(left)) {
    x = hostRect.x + left + marginLeft;
  } else if (Number.isFinite(right)) {
    x = hostRect.right - right - width - marginRight;
  } else {
    x = pseudo === "::before" ? hostRect.x + marginLeft : hostRect.right - width - marginRight;
  }

  let y: number;
  if (Number.isFinite(top)) {
    y = hostRect.y + top + marginTop;
  } else if (Number.isFinite(bottom)) {
    y = hostRect.bottom - bottom - height - marginBottom;
  } else {
    y = hostRect.y + Math.max(0, (hostRect.height - height) / 2) + marginTop;
  }

  return new DOMRect(x, y, width, height);
}

function computeInlinePaintPseudoMarkerRect(
  element: Element,
  pseudo: "::before" | "::after",
  hostRect: DOMRect,
  computed: CSSStyleDeclaration,
  width: number,
  height: number,
): DOMRect | null {
  if (!isInlineTabMarkerPseudoCandidate(element, pseudo, computed, width, height)) return null;

  const textRect = getFirstDirectTextRect(element);
  if (!textRect) return null;

  const marginLeft = parsePx(computed.marginLeft, 0);
  const marginRight = parsePx(computed.marginRight, 0);
  const textGap = pseudo === "::before" ? Math.max(0, marginRight) : Math.max(0, marginLeft);
  const x =
    pseudo === "::before"
      ? textRect.x - width - textGap
      : textRect.x + textRect.width + textGap;
  const y = hostRect.y + Math.max(0, (hostRect.height - height) / 2);

  return new DOMRect(x, y, width, height);
}

function isInlineTabMarkerPseudoCandidate(
  element: Element,
  pseudo: "::before" | "::after",
  computed: CSSStyleDeclaration,
  width: number,
  height: number,
): boolean {
  if (pseudo !== "::before") return false;
  if (computed.position === "absolute" || computed.position === "fixed") return false;
  if (width <= 0 || height <= 0 || width > 12 || height > 12) return false;
  if (!isVisiblePaint(computed.backgroundColor)) return false;

  const hostRect = element.getBoundingClientRect();
  if (hostRect.width <= 0 || hostRect.height <= 0 || hostRect.height > 40) return false;

  const identity = `${getElementIdentity(element)} ${element.getAttribute("href") || ""} ${element.getAttribute("data-path") || ""}`;
  const hasTabSignal =
    element.getAttribute("aria-current") === "page" ||
    /(^|[-_\s])(tab|tabs|tag|tags|router-link-active|tags-view-item)([-_\s]|$)/i.test(identity);
  if (!hasTabSignal) return false;

  const directText = getFirstDirectTextRect(element);
  return Boolean(directText);
}

function getFirstDirectTextRect(element: Element): { x: number; y: number; width: number; height: number } | null {
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType !== Node.TEXT_NODE) continue;
    if (!(child.textContent || "").trim()) continue;

    const textRect = getTextRect(child);
    if (textRect.width > 0 && textRect.height > 0) {
      return textRect;
    }
  }

  return null;
}

function getPaintPseudoStyles(computed: CSSStyleDeclaration, width: number, height: number): Record<string, string> {
  const styles: Record<string, string> = {
    display: "block",
    position: "absolute",
    left: "0px",
    top: "0px",
    width: `${roundPx(width)}px`,
    height: `${roundPx(height)}px`,
    boxSizing: computed.boxSizing || "border-box",
    overflow: "visible",
  };

  if (isVisiblePaint(computed.backgroundColor)) {
    styles.backgroundColor = computed.backgroundColor;
  }
  if (computed.backgroundImage && computed.backgroundImage !== "none") {
    styles.backgroundImage = computed.backgroundImage;
  }
  if (computed.opacity && computed.opacity !== "1") {
    styles.opacity = computed.opacity;
  }
  if (computed.transform && computed.transform !== "none") {
    styles.transform = computed.transform;
  }
  if (computed.transformOrigin) {
    styles.transformOrigin = computed.transformOrigin;
  }

  copyPaintPseudoBorderStyles(computed, styles);
  copyPaintPseudoRadiusStyles(computed, styles);

  return styles;
}

function copyPaintPseudoBorderStyles(computed: CSSStyleDeclaration, styles: Record<string, string>): void {
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    const width = computed[`border${side}Width` as keyof CSSStyleDeclaration] as string;
    const style = computed[`border${side}Style` as keyof CSSStyleDeclaration] as string;
    const color = computed[`border${side}Color` as keyof CSSStyleDeclaration] as string;
    if (parsePx(width, 0) <= 0 || style === "none" || style === "hidden") continue;

    styles[`border${side}Width`] = width;
    styles[`border${side}Style`] = style;
    styles[`border${side}Color`] = color;
  }
}

function copyPaintPseudoRadiusStyles(computed: CSSStyleDeclaration, styles: Record<string, string>): void {
  for (const corner of ["TopLeft", "TopRight", "BottomRight", "BottomLeft"] as const) {
    const key = `border${corner}Radius` as keyof CSSStyleDeclaration;
    const value = computed[key] as string;
    if (parsePx(value, 0) <= 0) continue;
    styles[`border${corner}Radius`] = value;
  }
}

function snapshotTextPseudoElement(element: Element, pseudo: "::before" | "::after"): ElementSnapshot | null {
  const computed = getComputedStyleFor(element, pseudo);
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return null;

  const text = parseCssTextContent(computed.content);
  if (!text || !isPlainPseudoText(text)) return null;
  if (isLayoutOnlyDotPseudoText(text, pseudo, computed)) return null;

  const hostRect = element.getBoundingClientRect();
  if (hostRect.width <= 0 && hostRect.height <= 0) return null;

  const fontSize = parsePx(computed.fontSize, parsePx(getComputedStyleFor(element).fontSize, 12));
  const lineHeight = parseLineHeight(computed.lineHeight, fontSize);
  const width = getPseudoTextWidth(text, computed, fontSize);
  const height = Math.max(1, parsePx(computed.height, 0), lineHeight);
  const rect = computePseudoTextRect(element, pseudo, hostRect, computed, width, height, fontSize);
  const styles = getPseudoTextStyles(computed, fontSize, lineHeight);

  const textNode: TextSnapshot = {
    nodeType: Node.TEXT_NODE as 3,
    id: generateNodeId(null),
    text,
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    lineCount: 1,
  };

  return {
    nodeType: Node.ELEMENT_NODE as 1,
    id: generateNodeId(null),
    tag: "SPAN",
    attributes: {
      "data-h2d-pseudo": pseudo === "::before" ? "before" : "after",
    },
    styles,
    rect: toElementRect(rect),
    childNodes: [textNode],
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function parseCssTextContent(content: string): string | null {
  if (!content || content === "none" || content === "normal") return null;
  if (content.startsWith("url(")) return null;

  const quote = content[0];
  if ((quote === "\"" || quote === "'") && content[content.length - 1] === quote) {
    return content
      .slice(1, -1)
      .replace(/\\A/g, "\n")
      .replace(/\\([\\'"])/g, "$1");
  }

  return content;
}

function isPlainPseudoText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("<svg") || trimmed.startsWith("<")) return false;
  return trimmed.length <= 8;
}

function isLayoutOnlyDotPseudoText(
  text: string,
  pseudo: "::before" | "::after",
  computed: CSSStyleDeclaration,
): boolean {
  if (pseudo !== "::after" || text.trim() !== ".") return false;

  const clear = computed.clear || "";
  if (clear && clear !== "none") return true;

  const hasPaint =
    isVisiblePaint(computed.backgroundColor) ||
    hasVisibleBorderStyles(computed) ||
    (computed.backgroundImage && computed.backgroundImage !== "none");
  if (hasPaint) return false;

  return computed.display === "block" || parsePx(computed.height, 0) <= 1;
}

function computePseudoTextRect(
  element: Element,
  pseudo: "::before" | "::after",
  hostRect: DOMRect,
  computed: CSSStyleDeclaration,
  width: number,
  height: number,
  fontSize: number,
): DOMRect {
  const inlineRect = computeInlinePseudoTextRect(element, pseudo, computed, width, height);
  if (inlineRect) return inlineRect;

  const marginLeft = parsePx(computed.marginLeft, 0);
  const marginTop = parsePx(computed.marginTop, 0);
  const left = parsePx(computed.left, NaN);
  const right = parsePx(computed.right, NaN);
  const top = parsePx(computed.top, NaN);
  const bottom = parsePx(computed.bottom, NaN);
  const explicitHeight = parsePx(computed.height, NaN);
  const hasUsableHeight = Number.isFinite(explicitHeight) && explicitHeight > 0;

  let x: number;
  if (Number.isFinite(left)) {
    x = hostRect.x + left + marginLeft;
  } else if (Number.isFinite(right)) {
    x = hostRect.right - right - width + marginLeft;
  } else {
    x = pseudo === "::before" ? hostRect.x - width + marginLeft : hostRect.right + marginLeft;
  }

  let y: number;
  if (Number.isFinite(top) && hasUsableHeight) {
    y = hostRect.y + top + marginTop;
  } else if (Number.isFinite(bottom) && hasUsableHeight) {
    y = hostRect.bottom - bottom - height + marginTop;
  } else {
    y = hostRect.y + Math.max(0, (hostRect.height - Math.max(fontSize, 1)) / 2) + marginTop;
  }

  return new DOMRect(x, y, width, height);
}

function computeInlinePseudoTextRect(
  element: Element,
  pseudo: "::before" | "::after",
  computed: CSSStyleDeclaration,
  width: number,
  height: number,
): DOMRect | null {
  if (computed.position === "absolute" || computed.position === "fixed") return null;

  const anchors = getDirectChildVisualRects(element);
  const anchor = pseudo === "::before" ? anchors[0] : anchors[anchors.length - 1];
  if (!anchor) return null;

  const marginLeft = parsePx(computed.marginLeft, 0);
  const marginRight = parsePx(computed.marginRight, 0);
  const marginTop = parsePx(computed.marginTop, 0);
  const x = pseudo === "::before"
    ? anchor.x - width - marginRight + marginLeft
    : anchor.right + marginLeft;
  const y = anchor.y + Math.max(0, (anchor.height - height) / 2) + marginTop;

  return new DOMRect(x, y, width, height);
}

function getDirectChildVisualRects(element: Element): DOMRect[] {
  const rects: DOMRect[] = [];

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent || "";
      if (!text.trim()) continue;
      const rect = getTextRect(child);
      if (rect.width > 0 || rect.height > 0) rects.push(new DOMRect(rect.x, rect.y, rect.width, rect.height));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childElement = child as Element;
      if (!isNodeVisible(childElement)) continue;
      const rect = childElement.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) rects.push(rect);
    }
  }

  return rects;
}

function getPseudoTextStyles(computed: CSSStyleDeclaration, fontSize: number, lineHeight: number): Record<string, string> {
  return {
    display: "block",
    position: "absolute",
    left: "0px",
    top: "0px",
    width: `${roundPx(getPseudoTextWidth(parseCssTextContent(computed.content) || "", computed, fontSize))}px`,
    height: `${roundPx(lineHeight)}px`,
    overflow: "visible",
    color: computed.color,
    fontFamily: computed.fontFamily,
    fontSize: `${roundPx(fontSize)}px`,
    fontWeight: computed.fontWeight,
    lineHeight: `${roundPx(lineHeight)}px`,
    whiteSpace: computed.whiteSpace || "pre",
    textAlign: computed.textAlign,
    boxSizing: "border-box",
  };
}

function getPseudoTextWidth(text: string, computed: CSSStyleDeclaration, fontSize: number): number {
  const explicitWidth = parsePx(computed.width, NaN);
  if (Number.isFinite(explicitWidth) && explicitWidth > 0) return explicitWidth;
  return Math.max(1, text.length * fontSize * 0.55);
}

function parseLineHeight(value: string, fontSize: number): number {
  const parsed = parseFloat(value || "");
  if (!Number.isFinite(parsed) || parsed <= 0) return fontSize;
  return parsed;
}

function parsePx(value: string, fallback: number): number {
  const parsed = parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toElementRect(rect: DOMRect): ElementRect {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    cssWidth: Math.round(rect.width),
    cssHeight: Math.round(rect.height),
  };
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
  rasterizeEmptyIframeShells(serialized, assetCollector);
  lockSnapshotGeometry(serialized, frameRect);
  childNodes.push(serialized);
  return true;
}

function getEmptyIframeViewportCropRect(
  element: Element,
  rect: ElementRect,
  childNodes: SnapshotNode[],
): ElementRect | null {
  if (element.tagName.toUpperCase() !== "IFRAME") return null;
  if (childNodes.length > 0) return null;
  if (element.ownerDocument !== document) return null;
  return getLargeVisibleViewportIntersectionRect(rect);
}

function rasterizeEmptyIframeShells(node: SnapshotNode, assetCollector: ResourceResolver): void {
  if (!isElementNodeSnapshot(node)) return;

  if (node.tag === "IFRAME" && node.childNodes.length === 0) {
    const cropRect = getLargeVisibleViewportIntersectionRect(node.rect);
    if (cropRect) {
      node.tag = "CANVAS";
      node.rect = cropRect;
      node.rect.cssWidth = Math.round(cropRect.width);
      node.rect.cssHeight = Math.round(cropRect.height);
      node.placeholderUrl = assetCollector.addViewportCrop(cropRect);
      node.attributes["data-h2d-rasterized-frame"] = "true";
      node.styles.overflow = "hidden";
      node.styles.overflowX = "hidden";
      node.styles.overflowY = "hidden";
      node.styles.width = `${roundPx(cropRect.width)}px`;
      node.styles.height = `${roundPx(cropRect.height)}px`;
    }
    return;
  }

  for (const child of node.childNodes) {
    rasterizeEmptyIframeShells(child, assetCollector);
  }
}

function getLargeVisibleViewportIntersectionRect(rect: Rect): ElementRect | null {
  if (rect.width < 120 || rect.height < 120) return null;

  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(window.innerWidth, rect.x + rect.width);
  const bottom = Math.min(window.innerHeight, rect.y + rect.height);
  const width = right - left;
  const height = bottom - top;

  if (width < 80 || height < 80) return null;

  return {
    x: left,
    y: top,
    width,
    height,
    cssWidth: Math.round(width),
    cssHeight: Math.round(height),
  };
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
  const overflowAxes = getSnapshotChildOverflowAxes(node);
  const isVerticalOverlayScrollViewport = node.attributes["data-h2d-vertical-scroll-viewport"] === "true";
  const shouldPreservePopupActionOverflow = node.attributes["data-h2d-popup-action-overflow"] === "true";
  if (isZeroSizeVisibleWrapper(node) || shouldPreservePopupActionOverflow) {
    node.styles.overflow = "visible";
    node.styles.overflowX = "visible";
    node.styles.overflowY = "visible";
  } else if (isVerticalOverlayScrollViewport) {
    node.styles.overflow = "hidden";
    node.styles.overflowX = "hidden";
    node.styles.overflowY = "hidden";
  } else if (overflowAxes.x || overflowAxes.y) {
    if (overflowAxes.x && !overflowAxes.y) {
      node.styles.overflow = "hidden";
      node.styles.overflowX = "hidden";
    } else if (overflowAxes.y && !overflowAxes.x) {
      node.styles.overflow = "hidden";
      node.styles.overflowY = "visible";
    } else {
      node.styles.overflow = "hidden";
      node.styles.overflowX = "hidden";
      node.styles.overflowY = "visible";
    }
  }
  node.layoutSizingHorizontal = "FIXED";
  node.layoutSizingVertical = "FIXED";
  delete node.declaredStyles;

  for (const child of node.childNodes) {
    if (isElementNodeSnapshot(child)) {
      rebaseNegativeScrollLayer(node, child);
    }
    lockSnapshotGeometry(child, node.rect);
  }
}

function rebaseNegativeScrollLayer(parent: ElementSnapshot, child: ElementSnapshot): void {
  if (!shouldRebaseNegativeScrollLayer(parent, child)) return;

  if (child.rect.y < parent.rect.y) {
    child.rect.y = parent.rect.y;
    child.rect.height = Math.min(child.rect.height, parent.rect.height);
    child.rect.cssHeight = Math.round(child.rect.height);
  }

  child.styles.overflow = "hidden";
  child.styles.overflowY = "visible";
}

function shouldRebaseNegativeScrollLayer(parent: ElementSnapshot, child: ElementSnapshot): boolean {
  if (parent.rect.width < 200 || parent.rect.height < 120) return false;

  const above = child.rect.y < parent.rect.y - 8;
  if (!above) return false;

  const layerSized =
    child.rect.height >= parent.rect.height * 0.5;
  if (!layerSized) return false;

  return hasSnapshotDescendantInsideRect(child.childNodes, parent.rect);
}

function hasSnapshotDescendantInsideRect(
  childNodes: SnapshotNode[],
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  for (const child of childNodes) {
    if (isSnapshotRectIntersectingRect(child.rect, rect)) return true;
    if (
      child.nodeType === NODE_TYPES.ELEMENT_NODE &&
      hasSnapshotDescendantInsideRect(child.childNodes, rect)
    ) {
      return true;
    }
  }

  return false;
}

function unclipZeroSizeVisibleWrapper(
  styles: Record<string, string>,
  rect: { width: number; height: number },
  childNodes: SnapshotNode[],
): void {
  if (rect.width > 0.5 && rect.height > 0.5) return;
  if (!hasNonZeroSnapshotDescendant(childNodes)) return;

  styles.overflow = "visible";
  styles.overflowX = "visible";
  styles.overflowY = "visible";
}

function relaxPopupActionClipping(
  element: Element,
  styles: Record<string, string>,
  rect: { x: number; y: number; width: number; height: number },
  childNodes: SnapshotNode[],
): boolean {
  if (!isInsidePopupCaptureLayer(element)) return false;
  if (!hasPopupActionSnapshotDescendant(childNodes)) return false;
  if (!isPopupActionOverflowRegion(element, rect)) return false;
  if (!hasSnapshotChildOutsideRect(childNodes, rect)) return false;

  if (/^(hidden|clip)$/i.test(styles.overflow || "")) {
    styles.overflow = "visible";
  }
  if (/^(hidden|clip)$/i.test(styles.overflowX || "")) {
    styles.overflowX = "visible";
  }
  if (/^(hidden|clip)$/i.test(styles.overflowY || "")) {
    styles.overflowY = "visible";
  }

  return true;
}

function isPopupActionOverflowRegion(
  element: Element,
  rect: { width: number; height: number },
): boolean {
  if (rect.width <= 0.5 || rect.height <= 0.5 || rect.height > 160) return false;

  const identity = getElementIdentity(element);
  if (/(^|[-_\s])(footer|actions?|button-group|buttonbar|operation|toolbar)([-_\s]|$)/i.test(identity)) {
    return true;
  }

  const computed = getComputedStyleFor(element);
  return (
    rect.height <= 96 &&
    (computed.display === "flex" ||
      computed.display === "inline-flex" ||
      computed.textAlign === "right" ||
      /^(fixed|absolute|sticky)$/i.test(computed.position))
  );
}

function hasSnapshotChildOutsideRect(
  childNodes: SnapshotNode[],
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  for (const child of childNodes) {
    if (child.rect.width > 0.5 && child.rect.height > 0.5) {
      if (
        child.rect.x < rect.x - 0.5 ||
        child.rect.y < rect.y - 0.5 ||
        child.rect.x + child.rect.width > rect.x + rect.width + 0.5 ||
        child.rect.y + child.rect.height > rect.y + rect.height + 0.5
      ) {
        return true;
      }
    }

    if (child.nodeType === NODE_TYPES.ELEMENT_NODE && hasSnapshotChildOutsideRect((child as ElementSnapshot).childNodes, rect)) {
      return true;
    }
  }

  return false;
}

function isZeroSizeVisibleWrapper(node: ElementSnapshot): boolean {
  return (
    (node.rect.width <= 0.5 || node.rect.height <= 0.5) &&
    hasNonZeroSnapshotDescendant(node.childNodes)
  );
}

function hasNonZeroSnapshotDescendant(childNodes: SnapshotNode[]): boolean {
  for (const child of childNodes) {
    if (child.rect.width > 0.5 && child.rect.height > 0.5) return true;
    if (
      child.nodeType === NODE_TYPES.ELEMENT_NODE &&
      hasNonZeroSnapshotDescendant(child.childNodes)
    ) {
      return true;
    }
  }

  return false;
}

function getSnapshotChildOverflowAxes(node: ElementSnapshot): { x: boolean; y: boolean } {
  const axes = { x: false, y: false };

  for (const child of node.childNodes) {
    const childAxes = getSnapshotRectOverflowAxes(child.rect, node.rect);
    axes.x ||= childAxes.x;
    axes.y ||= childAxes.y;
    if (axes.x && axes.y) break;
  }

  return axes;
}

function isSnapshotRectIntersectingRect(
  child: { x: number; y: number; width: number; height: number },
  parent: { x: number; y: number; width: number; height: number },
): boolean {
  if (child.width <= 0 || child.height <= 0) return false;

  return !(
    child.x + child.width <= parent.x ||
    child.x >= parent.x + parent.width ||
    child.y + child.height <= parent.y ||
    child.y >= parent.y + parent.height
  );
}

function isSnapshotRectOutsideRect(
  child: { x: number; y: number; width: number; height: number },
  parent: { x: number; y: number; width: number; height: number },
): boolean {
  const axes = getSnapshotRectOverflowAxes(child, parent);
  return axes.x || axes.y;
}

function getSnapshotRectOverflowAxes(
  child: { x: number; y: number; width: number; height: number },
  parent: { x: number; y: number; width: number; height: number },
): { x: boolean; y: boolean } {
  if (child.width <= 0 || child.height <= 0) return { x: false, y: false };

  const parentRight = parent.x + parent.width;
  const parentBottom = parent.y + parent.height;
  const childRight = child.x + child.width;
  const childBottom = child.y + child.height;

  return {
    x: child.x < parent.x || childRight > parentRight,
    y: child.y < parent.y || childBottom > parentBottom,
  };
}

function roundPx(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function getTextNodeParentElement(nodeOrNodes: Node | Node[]): Element | null {
  const nodes = Array.isArray(nodeOrNodes) ? nodeOrNodes : [nodeOrNodes];
  if (nodes.length === 0) return null;

  const parent = nodes[0].parentElement;
  if (!parent) return null;

  return nodes.every((node) => node.parentElement === parent) ? parent : null;
}

function getEllipsizedTextSnapshotData(
  nodeOrNodes: Node | Node[],
  text: string,
  rect: { x: number; y: number; width: number; height: number },
  lineCount: number,
): { text: string; rect: { x: number; y: number; width: number; height: number }; lineCount: number } {
  if (lineCount !== 1 || !text.trim()) {
    return { text, rect, lineCount };
  }

  const parent = getTextNodeParentElement(nodeOrNodes);
  if (!parent || !isEllipsisTextContainer(parent)) {
    return { text, rect, lineCount };
  }

  const computed = getComputedStyleFor(parent);
  const availableWidth = getEllipsisVisibleTextWidth(parent, computed, rect);
  if (availableWidth <= 0) {
    return { text, rect, lineCount };
  }

  const fullTextWidth = measureSingleLineText(parent, computed, text);
  if (fullTextWidth <= availableWidth + 0.5) {
    return { text, rect, lineCount };
  }

  const visibleText = fitTextWithEllipsis(parent, computed, text, availableWidth);
  return {
    text: visibleText,
    rect: {
      ...rect,
      width: Math.min(rect.width, availableWidth),
    },
    lineCount: 1,
  };
}

function isEllipsisTextContainer(element: Element): boolean {
  if (!isInstanceOfOwner<HTMLElement>(element, element, "HTMLElement")) return false;

  const tag = element.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return false;

  const computed = getComputedStyleFor(element);
  if (!/\bellipsis\b/i.test(computed.textOverflow)) return false;
  if (!/^(hidden|clip)$/i.test(computed.overflowX) && !/^(hidden|clip)$/i.test(computed.overflow)) return false;
  if (!/^(nowrap|pre)$/i.test(computed.whiteSpace)) return false;

  return element.scrollWidth > element.clientWidth + 1;
}

function getEllipsisVisibleTextWidth(
  element: Element,
  computed: CSSStyleDeclaration,
  textRect: { x: number; width: number },
): number {
  const rect = element.getBoundingClientRect();
  const borderLeft = parsePx(computed.borderLeftWidth, 0);
  const borderRight = parsePx(computed.borderRightWidth, 0);
  const paddingLeft = parsePx(computed.paddingLeft, 0);
  const paddingRight = parsePx(computed.paddingRight, 0);

  const contentLeft = rect.left + borderLeft + paddingLeft;
  const contentRight = rect.right - borderRight - paddingRight;
  const textLeft = Math.max(textRect.x, contentLeft);

  return Math.max(0, contentRight - textLeft);
}

function fitTextWithEllipsis(
  element: Element,
  computed: CSSStyleDeclaration,
  text: string,
  maxWidth: number,
): string {
  const ellipsis = "...";
  if (measureSingleLineText(element, computed, ellipsis) > maxWidth) {
    return ellipsis;
  }

  let low = 0;
  let high = text.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${text.slice(0, mid).trimEnd()}${ellipsis}`;
    const width = measureSingleLineText(element, computed, candidate);

    if (width <= maxWidth + 0.5) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best || ellipsis;
}

function measureSingleLineText(element: Element, computed: CSSStyleDeclaration, text: string): number {
  const doc = getNodeDocument(element);
  const body = doc.body;
  if (!body) return 0;

  const probe = doc.createElement("span");
  probe.textContent = text;
  probe.style.position = "fixed";
  probe.style.left = "-10000px";
  probe.style.top = "-10000px";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "nowrap";
  probe.style.fontFamily = computed.fontFamily;
  probe.style.fontSize = computed.fontSize;
  probe.style.fontStyle = computed.fontStyle;
  probe.style.fontWeight = computed.fontWeight;
  probe.style.fontStretch = computed.fontStretch;
  probe.style.letterSpacing = computed.letterSpacing;
  probe.style.textTransform = computed.textTransform;

  body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
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

  const ellipsized = getEllipsizedTextSnapshotData(
    nodeOrNodes,
    text,
    rectWithoutLineCount,
    lineCount,
  );

  const identityNode = Array.isArray(nodeOrNodes)
    ? nodeOrNodes.length === 1
      ? nodeOrNodes[0]
      : null
    : nodeOrNodes;

  return {
    nodeType: Node.TEXT_NODE as 3,
    id: generateNodeId(identityNode),
    text: ellipsized.text,
    rect: ellipsized.rect,
    lineCount: ellipsized.lineCount,
  };
}
