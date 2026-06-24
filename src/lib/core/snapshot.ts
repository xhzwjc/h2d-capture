/**
 * DOM snapshot engine — orchestrates the capture pipeline.
 */

import { getSourceAnnotations, getInspectorSelectedId } from '../react/fiber.js';
import { TypefaceProbe, resolveFonts } from '../typography/probe.js';
import { ResourceResolver, CaptureError, resolveResources, canvasToBlob } from '../media/resolver.js';
import { bakeSvgStyles, preloadExternalSvgSprites } from '../media/svg.js';
import { resolveTransform, multiplyMatrices, getElementRect } from '../transform/matrix.js';
import { extractComponentTree, findParentComponent } from '../react/tree.js';
import { inferLayoutSizing } from './layout.js';
import { NODE_TYPES, isNodeVisible, shouldPruneNode, iterateChildNodes, getTextRect, getElementAttributes, matrixToSimple, INPUT_TYPES_WITH_PLACEHOLDER, isFullyClippedByHorizontalScrollAncestor, isFullyClippedByVerticalOverlayScrollAncestor, isVerticalOverlayScrollClipAncestor } from './walker.js';
import { diffStyles, ensureFlexProps, ensureGridProps, ensureFlexItemProps, normalizeCssColorFunctions } from './styles.js';
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
  captureMode: "viewport",
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

const PRIVATE_USE_GLYPH_PATTERN = /[\uE000-\uF8FF]/u;
const PRIVATE_USE_GLYPH_ONLY_PATTERN = /^[\uE000-\uF8FF]+$/u;
const TOOLBAR_ACTION_TEXT_PATTERN = /^(新建|新增|创建|发起|关闭|转交|批量|授权|审批|导入|导出|删除|移除|编辑|保存|提交|发布|取消|通过|驳回|分配|转移|复制|下载|上传|启用|停用|禁用|加入|进入|设置|重置)/;
const TOOLBAR_ACTION_TEXT_START_PATTERN = /新建|新增|创建|发起|关闭|转交|批量|导入|导出|删除|移除|编辑|保存|提交|发布|取消|通过|驳回|分配|转移|复制|下载|上传|启用|停用|禁用|加入|进入|设置|重置/g;
const TOOLBAR_ACTION_TEXT_HIT_PATTERN = /新建|新增|创建|发起|关闭|转交|批量|授权|审批|导入|导出|删除|移除|编辑|保存|提交|发布|取消|通过|驳回|分配|转移|复制|下载|上传|启用|停用|禁用|加入|进入|设置|重置/g;

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
    ctx.svgSpriteCache = await preloadExternalSvgSprites(element);

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
    const elementViewportCrop = getElementViewportCrop(element, elementRect, ownerWindow, mergedOptions.captureMode);
    if (elementViewportCrop) {
      normalizeElementViewportSnapshot(rootSnapshot, elementViewportCrop);
      normalizeViewportOverflowShells(rootSnapshot);
      relaxViewportVisibleClipContainers(rootSnapshot);
      pruneViewportTopOverflowSnapshots(rootSnapshot);
      pruneNestedViewportClipOverflowSnapshots(rootSnapshot);
      normalizeVirtualViewportWrapperBounds(rootSnapshot);
    } else {
      normalizeElementCaptureOrigin(rootSnapshot, elementRect);
    }
    normalizeViewportCropCanvasGeometry(rootSnapshot);
    promoteExternalActionToolbarSnapshots(rootSnapshot);
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
        width: elementViewportCrop?.width ?? element.scrollWidth,
        height: elementViewportCrop?.height ?? element.scrollHeight,
      },
      viewportRect: {
        x: elementViewportCrop ? 0 : element.scrollLeft,
        y: elementViewportCrop ? 0 : element.scrollTop,
        width: elementViewportCrop?.width ?? width,
        height: elementViewportCrop?.height ?? height,
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
    ctx.svgSpriteCache = await preloadExternalSvgSprites(doc.documentElement);

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
    const shouldUseViewportRect = mergedOptions.captureMode !== "full-page";

    if (shouldUseViewportRect) {
      normalizeDocumentViewportSnapshot(rootSnapshot, ownerWindow);
      normalizeViewportOverflowShells(rootSnapshot);
      relaxViewportVisibleClipContainers(rootSnapshot);
      pruneViewportTopOverflowSnapshots(rootSnapshot);
      pruneNestedViewportClipOverflowSnapshots(rootSnapshot);
      normalizeVirtualViewportWrapperBounds(rootSnapshot);
    } else {
      normalizeFullPageDocumentSnapshot(
        rootSnapshot,
        documentScrollX,
        documentScrollY,
        documentWidth,
        documentHeight,
        viewportWidth,
        viewportHeight,
      );
      extendFullPageFixedBackgrounds(rootSnapshot, viewportHeight);
      extendLeftSidebarBackgrounds(rootSnapshot, doc.documentElement, documentHeight);
    }
    normalizeViewportCropCanvasGeometry(rootSnapshot);
    promoteExternalActionToolbarSnapshots(rootSnapshot);
    if (shouldUseViewportRect) {
      removeGeneratedToolbarActionOverlays(rootSnapshot);
      appendCompactToolbarActionOverlays(rootSnapshot, doc.documentElement);
      normalizeGeneratedViewportRootOverlays(rootSnapshot);
      clampSlightViewportRootOverscroll(rootSnapshot);
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

interface ElementViewportCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

function getElementViewportCrop(
  element: Element,
  elementRect: DOMRect,
  ownerWindow: Window,
  captureMode: string | undefined,
): ElementViewportCrop | null {
  if (captureMode === "full-page") return null;

  const viewportWidth = ownerWindow.innerWidth;
  const viewportHeight = ownerWindow.innerHeight;
  if (viewportWidth <= 0 || viewportHeight <= 0) return null;

  const left = Math.max(elementRect.left, 0);
  const top = Math.max(elementRect.top, 0);
  const right = Math.min(elementRect.right, viewportWidth);
  const bottom = Math.min(elementRect.bottom, viewportHeight);
  if (right <= left || bottom <= top) return null;

  if (!isViewportPageContainerElement(element, elementRect, ownerWindow)) return null;

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function isViewportPageContainerElement(element: Element, elementRect: DOMRect, ownerWindow: Window): boolean {
  const viewportWidth = ownerWindow.innerWidth;
  const viewportHeight = ownerWindow.innerHeight;
  const fillsViewportWidth = elementRect.width >= viewportWidth * 0.7;
  const fillsViewportHeight = elementRect.height >= viewportHeight * 0.85;
  if (!fillsViewportWidth || !fillsViewportHeight) return false;

  const crossesViewport =
    elementRect.top < -1 ||
    elementRect.left < -1 ||
    elementRect.bottom > viewportHeight + 1 ||
    elementRect.right > viewportWidth + 1;
  if (!crossesViewport) return false;

  const identity = `${element.tagName} ${element.id} ${element.className}`.toLowerCase();
  return /(page|layout|container|content|main|app|pro-page)/.test(identity);
}

function normalizeElementViewportSnapshot(rootSnapshot: ElementSnapshot, crop: ElementViewportCrop): void {
  offsetSnapshotNode(rootSnapshot, -crop.x, -crop.y);
  normalizeViewportRootRect(rootSnapshot, {
    x: 0,
    y: 0,
    width: crop.width,
    height: crop.height,
  });
}

function normalizeViewportCropCanvasGeometry(node: ElementSnapshot, parentRect?: Rect): void {
  if (isViewportCropCanvasSnapshot(node)) {
    alignSnapshotGeometryToParent(node, parentRect ?? node.rect);
  }

  for (const child of node.childNodes) {
    if (isElementNodeSnapshot(child)) {
      normalizeViewportCropCanvasGeometry(child, node.rect);
    }
  }
}

interface ExternalActionToolbarPromotion {
  parent: ElementSnapshot;
  node: ElementSnapshot;
}

function promoteExternalActionToolbarSnapshots(root: ElementSnapshot): void {
  const promotions: ExternalActionToolbarPromotion[] = [];
  collectExternalActionToolbarPromotions(root, [], promotions);
  if (promotions.length === 0) return;

  const promoted = new Set<ElementSnapshot>();
  for (const { parent, node } of promotions) {
    if (promoted.has(node)) continue;
    promoted.add(node);

    parent.childNodes = parent.childNodes.filter((child) => child !== node);
    node.attributes["data-h2d-promoted-action-toolbar"] = "true";
    node.styles.zIndex = "160";
    anchorSnapshotToParent(node, root.rect);
    root.childNodes.push(node);
  }
}

function collectExternalActionToolbarPromotions(
  node: ElementSnapshot,
  clippingAncestors: ElementSnapshot[],
  promotions: ExternalActionToolbarPromotion[],
): void {
  const nextClippingAncestors = isSnapshotOverflowClipContainer(node.styles)
    ? [...clippingAncestors, node]
    : clippingAncestors;

  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    if (isExternallyClippedActionToolbar(child, nextClippingAncestors)) {
      promotions.push({ parent: node, node: child });
      continue;
    }

    collectExternalActionToolbarPromotions(child, nextClippingAncestors, promotions);
  }
}

function isExternallyClippedActionToolbar(node: ElementSnapshot, clippingAncestors: ElementSnapshot[]): boolean {
  if (clippingAncestors.length === 0) return false;
  if (!isActionToolbarSnapshot(node)) return false;

  return clippingAncestors.some((ancestor) => isSnapshotRectOutsideRect(node.rect, ancestor.rect));
}

function isActionToolbarSnapshot(node: ElementSnapshot): boolean {
  if (node.rect.width < 80 || node.rect.width > 1000) return false;
  if (node.rect.height < 24 || node.rect.height > 96) return false;

  const actions = node.childNodes.filter((child): child is ElementSnapshot => (
    isElementNodeSnapshot(child) && isActionButtonSnapshot(child)
  ));
  if (actions.length < 2 || actions.length > 12) return false;

  const centers = actions.map((action) => action.rect.y + action.rect.height / 2);
  if (Math.max(...centers) - Math.min(...centers) > 12) return false;

  const bounds = unionSnapshotRects(actions.map((action) => action.rect));
  if (!bounds) return false;
  if (bounds.x < node.rect.x - 8 || bounds.x + bounds.width > node.rect.x + node.rect.width + 8) return false;
  if (bounds.y < node.rect.y - 8 || bounds.y + bounds.height > node.rect.y + node.rect.height + 8) return false;

  const toolbarText = normalizeToolbarActionText(getSnapshotText(node));
  const actionText = actions.map((action) => normalizeToolbarActionText(getSnapshotText(action))).join("");
  return toolbarText.includes(actionText);
}

function isActionButtonSnapshot(node: ElementSnapshot): boolean {
  const text = normalizeToolbarActionText(getSnapshotText(node));
  if (!text || text.length > 32) return false;
  if (node.rect.width < 32 || node.rect.width > 240) return false;
  if (node.rect.height < 20 || node.rect.height > 56) return false;
  return hasSnapshotButtonSurface(node);
}

function hasSnapshotButtonSurface(node: ElementSnapshot, depth = 0): boolean {
  if (isSnapshotButtonSurface(node)) return true;
  if (depth >= 4) return false;

  return node.childNodes.some((child) => (
    isElementNodeSnapshot(child) && hasSnapshotButtonSurface(child, depth + 1)
  ));
}

function isSnapshotButtonSurface(node: ElementSnapshot): boolean {
  if (node.rect.width < 24 || node.rect.height < 18 || node.rect.height > 56) return false;
  if (!hasSnapshotRoundedCorners(node.styles, 2)) return false;
  return hasSnapshotVisibleBorderStyles(node.styles) || hasSnapshotVisibleBackground(node.styles);
}

function hasSnapshotRoundedCorners(styles: Record<string, string>, minRadius: number): boolean {
  return [
    styles.borderTopLeftRadius,
    styles.borderTopRightRadius,
    styles.borderBottomRightRadius,
    styles.borderBottomLeftRadius,
  ].some((value) => parsePx(value || "", 0) >= minRadius);
}

function hasSnapshotVisibleBackground(styles: Record<string, string>): boolean {
  const color = styles.backgroundColor || "";
  return isVisiblePaint(color) && color !== "rgb(255, 255, 255)";
}

function hasSnapshotVisibleBorderStyles(styles: Record<string, string>): boolean {
  return [
    [styles.borderTopWidth, styles.borderTopStyle, styles.borderTopColor],
    [styles.borderRightWidth, styles.borderRightStyle, styles.borderRightColor],
    [styles.borderBottomWidth, styles.borderBottomStyle, styles.borderBottomColor],
    [styles.borderLeftWidth, styles.borderLeftStyle, styles.borderLeftColor],
  ].some(([width, style, color]) => (
    parsePx(width || "", 0) > 0 &&
    style !== "none" &&
    style !== "hidden" &&
    isVisiblePaint(color || "")
  ));
}

function unionSnapshotRects(rects: Array<{ x: number; y: number; width: number; height: number }>): Rect | null {
  if (rects.length === 0) return null;

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function isViewportCropCanvasSnapshot(node: ElementSnapshot): boolean {
  return node.tag === "CANVAS" &&
    node.attributes["data-h2d-rasterized-frame"] === "true" &&
    Boolean(node.placeholderUrl?.startsWith("rasterized:"));
}

function alignSnapshotGeometryToParent(node: ElementSnapshot, parentRect: Rect): void {
  node.rect.cssWidth = Math.round(node.rect.width);
  node.rect.cssHeight = Math.round(node.rect.height);
  node.styles.display = "block";
  node.styles.position = "absolute";
  node.styles.left = `${roundPx(node.rect.x - parentRect.x)}px`;
  node.styles.top = `${roundPx(node.rect.y - parentRect.y)}px`;
  node.styles.width = `${roundPx(node.rect.width)}px`;
  node.styles.height = `${roundPx(node.rect.height)}px`;
  node.styles.boxSizing = "border-box";
  node.styles.overflow = "hidden";
  node.styles.overflowX = "hidden";
  node.styles.overflowY = "hidden";
  delete node.styles.transform;
  delete node.styles.transformOrigin;
  delete node.relativeTransform;
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

function normalizeFullPageDocumentSnapshot(
  rootSnapshot: ElementSnapshot,
  scrollX: number,
  scrollY: number,
  documentWidth: number,
  documentHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): void {
  if (scrollX !== 0 || scrollY !== 0) {
    offsetSnapshotNode(rootSnapshot, scrollX, scrollY);
    rebaseFullPageFixedSnapshots(rootSnapshot, scrollX, scrollY);
  }

  rootSnapshot.rect.x = 0;
  rootSnapshot.rect.y = 0;
  rootSnapshot.rect.width = documentWidth;
  rootSnapshot.rect.height = documentHeight;
  rootSnapshot.rect.cssWidth = Math.round(documentWidth);
  rootSnapshot.rect.cssHeight = Math.round(documentHeight);
  rootSnapshot.styles.width = `${roundPx(documentWidth)}px`;
  rootSnapshot.styles.height = `${roundPx(documentHeight)}px`;
  rootSnapshot.styles.overflow = "visible";
  rootSnapshot.styles.overflowX = "visible";
  rootSnapshot.styles.overflowY = "visible";
  rootSnapshot.styles.minWidth = `${roundPx(Math.max(documentWidth, viewportWidth))}px`;
  rootSnapshot.styles.minHeight = `${roundPx(Math.max(documentHeight, viewportHeight))}px`;
}

function rebaseFullPageFixedSnapshots(node: ElementSnapshot, scrollX: number, scrollY: number): void {
  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    if (child.styles.position === "fixed") {
      offsetSnapshotNode(child, -scrollX, -scrollY);
      continue;
    }

    rebaseFullPageFixedSnapshots(child, scrollX, scrollY);
  }
}

function normalizeViewportOverflowShells(rootSnapshot: ElementSnapshot): void {
  normalizeViewportOverflowShellsInner(rootSnapshot, rootSnapshot.rect);
}

function normalizeViewportOverflowShellsInner(node: ElementSnapshot, viewportRect: ElementRect): void {
  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    if (isViewportOverflowShellSnapshot(child, viewportRect)) {
      child.rect.y = viewportRect.y;
      child.rect.height = viewportRect.height;
      child.rect.cssHeight = Math.round(child.rect.height);
      child.styles.height = `${roundPx(child.rect.height)}px`;
      child.styles.overflow = "hidden";
      child.styles.overflowX = "hidden";
      child.styles.overflowY = "hidden";

      if (child.rect.x <= viewportRect.x + 1 && child.rect.width >= viewportRect.width - 2) {
        child.rect.x = viewportRect.x;
        child.rect.width = viewportRect.width;
        child.rect.cssWidth = Math.round(child.rect.width);
        child.styles.width = `${roundPx(child.rect.width)}px`;
      }

      const maxHeight = parsePx(child.styles.maxHeight || "", NaN);
      if (Number.isFinite(maxHeight) && maxHeight < child.rect.height) {
        delete child.styles.maxHeight;
      }
    }

    normalizeViewportOverflowShellsInner(child, viewportRect);
  }
}

function relaxViewportVisibleClipContainers(rootSnapshot: ElementSnapshot): void {
  relaxViewportVisibleClipContainersInner(rootSnapshot, rootSnapshot.rect);
}

function relaxViewportVisibleClipContainersInner(node: ElementSnapshot, viewportRect: ElementRect): void {
  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    if (isSnapshotOverflowClipContainer(child.styles)) {
      relaxViewportVisibleClipContainer(child, viewportRect);
    }

    relaxViewportVisibleClipContainersInner(child, viewportRect);
  }
}

function relaxViewportVisibleClipContainer(node: ElementSnapshot, viewportRect: ElementRect): void {
  if (isNarrowNavigationClipSnapshot(node, viewportRect)) return;
  if (isCollapsedFixedViewportBarSnapshot(node, viewportRect)) return;

  const visibleBounds = getSnapshotDescendantVisibleBounds(node.childNodes, viewportRect);
  if (!visibleBounds) return;

  const nodeBottom = node.rect.y + node.rect.height;
  const visibleBottom = visibleBounds.y + visibleBounds.height;
  if (visibleBottom <= nodeBottom + 1) return;

  node.rect.height = roundPx(Math.max(node.rect.height, visibleBottom - node.rect.y));
  node.rect.cssHeight = Math.round(node.rect.height);
  node.styles.height = `${roundPx(node.rect.height)}px`;
  node.styles.overflow = "visible";
  node.styles.overflowY = "visible";

  const maxHeight = parsePx(node.styles.maxHeight || "", NaN);
  if (Number.isFinite(maxHeight) && maxHeight < node.rect.height) {
    delete node.styles.maxHeight;
  }
}

function pruneNestedViewportClipOverflowSnapshots(rootSnapshot: ElementSnapshot): void {
  pruneNestedViewportClipOverflowSnapshotsInner(rootSnapshot, rootSnapshot.rect, 0);
}

function pruneNestedViewportClipOverflowSnapshotsInner(
  node: ElementSnapshot,
  viewportRect: ElementRect,
  depth: number,
): void {
  if (isNestedViewportClipSnapshot(node, viewportRect, depth)) {
    pruneSnapshotChildrenToClipRect(node, node.rect);
  }

  for (const child of node.childNodes) {
    if (isElementNodeSnapshot(child)) {
      pruneNestedViewportClipOverflowSnapshotsInner(child, viewportRect, depth + 1);
    }
  }
}

function isNestedViewportClipSnapshot(
  node: ElementSnapshot,
  viewportRect: ElementRect,
  depth: number,
): boolean {
  if (depth < 3) return false;
  if (node.tag === "HTML" || node.tag === "BODY") return false;
  if (node.childNodes.length === 0) return false;
  if (node.rect.width <= 0 || node.rect.height <= 0) return false;
  if (isNarrowNavigationClipSnapshot(node, viewportRect)) return false;
  if (!isSnapshotRectIntersectingRect(node.rect, viewportRect)) return false;
  if (!isViewportPaneSizedSnapshot(node, viewportRect)) return false;
  if (!isSnapshotOverflowClipContainer(node.styles)) return false;
  if (!hasSnapshotDescendantInsideRect(node.childNodes, node.rect)) return false;
  return hasSnapshotChildOutsideRect(node.childNodes, node.rect);
}

function isViewportPaneSizedSnapshot(node: ElementSnapshot, viewportRect: ElementRect): boolean {
  if (node.rect.width < Math.min(480, viewportRect.width * 0.35)) return false;
  if (node.rect.height < Math.min(360, viewportRect.height * 0.42)) return false;

  const viewportBottom = viewportRect.y + viewportRect.height;
  const nodeBottom = node.rect.y + node.rect.height;
  if (node.rect.y > viewportRect.y + viewportRect.height * 0.28) return false;
  return nodeBottom >= viewportBottom - Math.max(48, viewportRect.height * 0.08);
}

function pruneSnapshotChildrenToClipRect(node: ElementSnapshot, clipRect: ElementRect): void {
  node.childNodes = node.childNodes.filter((child) => {
    if (isElementNodeSnapshot(child)) {
      pruneSnapshotChildrenToClipRect(child, clipRect);
      normalizeTransparentClipWrapperBounds(child, clipRect);
      if (isPreservedOverflowActionToolbarSnapshot(child, clipRect)) return true;
    }

    if (!isSnapshotFullyOutsideRect(child.rect, clipRect)) return true;
    if (isElementNodeSnapshot(child) && hasSnapshotDescendantInsideRect(child.childNodes, clipRect)) return true;
    return false;
  });
}

function isPreservedOverflowActionToolbarSnapshot(node: ElementSnapshot, clipRect: ElementRect): boolean {
  if (!isSnapshotRectNearRect(node.rect, clipRect, 96)) return false;
  return isActionToolbarSnapshot(node) ||
    isActionToolbarTextClusterSnapshot(node) ||
    hasActionToolbarSnapshotDescendant(node, 0);
}

function hasActionToolbarSnapshotDescendant(node: ElementSnapshot, depth: number): boolean {
  if (depth >= 5) return false;

  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;
    if (isActionToolbarSnapshot(child) || isActionToolbarTextClusterSnapshot(child)) return true;
    if (hasActionToolbarSnapshotDescendant(child, depth + 1)) return true;
  }

  return false;
}

function isActionToolbarTextClusterSnapshot(node: ElementSnapshot): boolean {
  if (node.rect.width < 120 || node.rect.width > 1000) return false;
  if (node.rect.height < 20 || node.rect.height > 120) return false;

  const text = normalizeToolbarActionText(getSnapshotText(node));
  if (text.length < 6 || text.length > 96) return false;
  return countToolbarActionTextHits(text) >= 3;
}

function isSnapshotRectNearRect(
  rect: { x: number; y: number; width: number; height: number },
  clipRect: { x: number; y: number; width: number; height: number },
  margin: number,
): boolean {
  return rect.x + rect.width >= clipRect.x - margin &&
    rect.x <= clipRect.x + clipRect.width + margin &&
    rect.y + rect.height >= clipRect.y - margin &&
    rect.y <= clipRect.y + clipRect.height + margin;
}

function normalizeTransparentClipWrapperBounds(node: ElementSnapshot, clipRect: ElementRect): void {
  if (!isTransparentStructuralSnapshot(node)) return;
  if (isSnapshotOverflowClipContainer(node.styles)) return;
  if (!hasSnapshotChildOutsideRect(node.childNodes, clipRect) && !isSnapshotRectOutsideRect(node.rect, clipRect)) {
    return;
  }

  const visibleBounds = getSnapshotDescendantVisibleBounds(node.childNodes, clipRect);
  if (!visibleBounds) return;
  if (visibleBounds.width <= 0 || visibleBounds.height <= 0) return;

  node.rect.x = roundPx(visibleBounds.x);
  node.rect.y = roundPx(visibleBounds.y);
  node.rect.width = roundPx(visibleBounds.width);
  node.rect.height = roundPx(visibleBounds.height);
  node.rect.cssWidth = Math.round(node.rect.width);
  node.rect.cssHeight = Math.round(node.rect.height);
  delete node.rect.quad;

  node.styles.width = `${roundPx(node.rect.width)}px`;
  node.styles.height = `${roundPx(node.rect.height)}px`;
  node.styles.minHeight = "0px";
  if (!isSnapshotOverflowClipContainer(node.styles)) {
    node.styles.overflow = "visible";
    node.styles.overflowX = "visible";
    node.styles.overflowY = "visible";
  }
  node.layoutSizingHorizontal = "FIXED";
  node.layoutSizingVertical = "FIXED";
}

function isSnapshotFullyOutsideRect(
  rect: { x: number; y: number; width: number; height: number },
  clipRect: { x: number; y: number; width: number; height: number },
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;

  const tolerance = 0.5;
  return rect.x + rect.width <= clipRect.x + tolerance ||
    rect.x >= clipRect.x + clipRect.width - tolerance ||
    rect.y + rect.height <= clipRect.y + tolerance ||
    rect.y >= clipRect.y + clipRect.height - tolerance;
}

function normalizeVirtualViewportWrapperBounds(rootSnapshot: ElementSnapshot): void {
  normalizeVirtualViewportWrapperBoundsInner(rootSnapshot, rootSnapshot.rect, 0);
}

function normalizeVirtualViewportWrapperBoundsInner(
  node: ElementSnapshot,
  viewportRect: ElementRect,
  depth: number,
): void {
  for (const child of node.childNodes) {
    if (isElementNodeSnapshot(child)) {
      normalizeVirtualViewportWrapperBoundsInner(child, viewportRect, depth + 1);
    }
  }

  if (!isVirtualViewportWrapperOutlier(node, viewportRect, depth)) return;

  const visibleBounds = getSnapshotDescendantVisibleBounds(node.childNodes, viewportRect);
  if (!visibleBounds) return;

  node.rect.x = roundPx(visibleBounds.x);
  node.rect.y = roundPx(visibleBounds.y);
  node.rect.width = roundPx(visibleBounds.width);
  node.rect.height = roundPx(visibleBounds.height);
  node.rect.cssWidth = Math.round(node.rect.width);
  node.rect.cssHeight = Math.round(node.rect.height);
  delete node.rect.quad;

  node.styles.width = `${roundPx(node.rect.width)}px`;
  node.styles.height = `${roundPx(node.rect.height)}px`;
  node.styles.minHeight = "0px";
  if (!isSnapshotOverflowClipContainer(node.styles)) {
    node.styles.overflow = "visible";
    node.styles.overflowX = "visible";
    node.styles.overflowY = "visible";
  }
  node.layoutSizingHorizontal = "FIXED";
  node.layoutSizingVertical = "FIXED";
}

function isVirtualViewportWrapperOutlier(
  node: ElementSnapshot,
  viewportRect: ElementRect,
  depth: number,
): boolean {
  if (depth < 3) return false;
  if (node.tag === "HTML" || node.tag === "BODY") return false;
  if (node.childNodes.length === 0) return false;
  if (node.rect.width <= 0 || node.rect.height <= 0) return false;
  if (!isTransparentStructuralSnapshot(node)) return false;
  if (isNarrowNavigationClipSnapshot(node, viewportRect)) return false;

  const viewportRight = viewportRect.x + viewportRect.width;
  const viewportBottom = viewportRect.y + viewportRect.height;
  if (node.rect.x + node.rect.width <= viewportRect.x || node.rect.x >= viewportRight) return false;

  const sticksFarAbove = node.rect.y < viewportRect.y - 96;
  const sticksFarBelow = node.rect.y + node.rect.height > viewportBottom + 96;
  const muchTallerThanViewport = node.rect.height > viewportRect.height * 1.35;
  if (!sticksFarAbove && !sticksFarBelow && !muchTallerThanViewport) return false;

  const visibleBounds = getSnapshotDescendantVisibleBounds(node.childNodes, viewportRect);
  if (!visibleBounds) return false;
  if (visibleBounds.width <= 0 || visibleBounds.height <= 0) return false;

  const nodeArea = node.rect.width * node.rect.height;
  const visibleArea = visibleBounds.width * visibleBounds.height;
  return visibleArea < nodeArea * 0.9;
}

function isTransparentStructuralSnapshot(node: ElementSnapshot): boolean {
  if (isVisiblePaint(node.styles.backgroundColor || "")) return false;
  if (node.styles.backgroundImage && node.styles.backgroundImage !== "none") return false;
  if (node.styles.boxShadow && node.styles.boxShadow !== "none") return false;
  if (hasSnapshotBorderStyles(node.styles)) return false;
  if (node.placeholderUrl || node.content || node.pseudoElementStyles) return false;
  return true;
}

function hasSnapshotBorderStyles(styles: Record<string, string>): boolean {
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    const width = parsePx(styles[`border${side}Width`] || "", 0);
    const style = styles[`border${side}Style`];
    const color = styles[`border${side}Color`];
    if (width > 0 && style && style !== "none" && (!color || isVisiblePaint(color))) {
      return true;
    }
  }

  return false;
}

function isNarrowNavigationClipSnapshot(node: ElementSnapshot, viewportRect: ElementRect): boolean {
  const maxNavWidth = Math.min(360, viewportRect.width * 0.28);
  if (node.rect.width <= 0 || node.rect.width > maxNavWidth) return false;

  const isNearViewportEdge =
    node.rect.x <= viewportRect.x + maxNavWidth ||
    node.rect.x + node.rect.width >= viewportRect.x + viewportRect.width - maxNavWidth;
  if (!isNearViewportEdge) return false;

  return hasNavigationListDescendant(node, 0);
}

function hasNavigationListDescendant(node: ElementSnapshot, depth: number): boolean {
  if (depth > 3) return false;

  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;
    if ((child.tag === "UL" || child.tag === "OL") && hasListItemChild(child)) return true;
    if (hasNavigationListDescendant(child, depth + 1)) return true;
  }

  return false;
}

function hasListItemChild(node: ElementSnapshot): boolean {
  return node.childNodes.some((child) => isElementNodeSnapshot(child) && child.tag === "LI");
}

function isCollapsedFixedViewportBarSnapshot(node: ElementSnapshot, viewportRect: ElementRect): boolean {
  if (node.styles.position !== "fixed") return false;

  const top = parsePx(node.styles.top || "", NaN);
  const bottom = parsePx(node.styles.bottom || "", NaN);
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return false;
  if (Math.abs(node.rect.y - top) > 2) return false;

  const cssHeight = viewportRect.height - top - bottom;
  if (cssHeight <= 0 || cssHeight > 160) return false;

  const rectHeight = node.rect.height;
  return rectHeight <= cssHeight + 2 || rectHeight >= viewportRect.height - 2;
}

function isViewportOverflowShellSnapshot(node: ElementSnapshot, viewportRect: ElementRect): boolean {
  if (node.rect.y >= viewportRect.y - 1) return false;
  if (node.rect.width < viewportRect.width * 0.45) return false;
  if (!hasSnapshotDescendantInsideRect(node.childNodes, viewportRect)) return false;

  const viewportBottom = viewportRect.y + viewportRect.height;
  const nodeBottom = node.rect.y + node.rect.height;
  if (nodeBottom >= viewportBottom - 1) return true;

  const visibleBounds = getSnapshotDescendantVisibleBounds(node.childNodes, viewportRect);
  if (!visibleBounds || visibleBounds.y + visibleBounds.height <= nodeBottom + 1) return false;

  return isViewportShellLikeSnapshot(node, viewportRect);
}

function pruneViewportTopOverflowSnapshots(rootSnapshot: ElementSnapshot): void {
  pruneViewportTopOverflowSnapshotsInner(rootSnapshot, rootSnapshot.rect);
}

function pruneViewportTopOverflowSnapshotsInner(node: ElementSnapshot, viewportRect: ElementRect): void {
  node.childNodes = node.childNodes.filter((child) => {
    if (!isElementNodeSnapshot(child)) return true;
    if (isViewportTopOverflowSnapshot(child, viewportRect)) return false;

    pruneViewportTopOverflowSnapshotsInner(child, viewportRect);
    return true;
  });
}

function isViewportTopOverflowSnapshot(node: ElementSnapshot, viewportRect: ElementRect): boolean {
  if (node.rect.y >= viewportRect.y - 1) return false;
  if (isViewportTopOverflowToolbarSnapshot(node, viewportRect)) return true;

  const visibleBottom = node.rect.y + node.rect.height;
  if (visibleBottom <= viewportRect.y) return true;

  const visibleHeight = visibleBottom - viewportRect.y;
  return visibleHeight <= 8 && node.rect.height >= 16;
}

function isViewportTopOverflowToolbarSnapshot(node: ElementSnapshot, viewportRect: ElementRect): boolean {
  const visibleBottom = node.rect.y + node.rect.height;
  if (visibleBottom <= viewportRect.y || visibleBottom > viewportRect.y + 96) return false;
  if (node.rect.height < 16 || node.rect.height > 120) return false;

  const name = node.owningReactComponent || "";
  const identity = `${node.tag} ${node.attributes.id || ""} ${node.attributes.class || ""} ${name}`;
  const compactIdentity = identity.replace(/[-_\s]/g, "").toLowerCase();
  const isToolbarNode = /(listtoolbar|toolbar|pageheader|listheader)/.test(compactIdentity);
  if (!isToolbarNode && !hasToolbarSnapshotDescendant(node)) {
    return false;
  }

  const text = normalizeToolbarActionText(getSnapshotText(node));
  if (!text || text.length > 80) return false;

  return true;
}

function hasToolbarSnapshotDescendant(node: ElementSnapshot, depth = 0): boolean {
  if (depth >= 4) return false;

  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    const name = child.owningReactComponent || "";
    const identity = `${child.tag} ${child.attributes.id || ""} ${child.attributes.class || ""} ${name}`;
    const compactIdentity = identity.replace(/[-_\s]/g, "").toLowerCase();
    if (/(listtoolbar|toolbar|pageheader|listheader)/.test(compactIdentity)) return true;
    if (hasToolbarSnapshotDescendant(child, depth + 1)) return true;
  }

  return false;
}

function normalizeGeneratedViewportRootOverlays(rootSnapshot: ElementSnapshot): void {
  for (const child of rootSnapshot.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;
    if (!isGeneratedRootOverlaySnapshot(child)) continue;
    anchorSnapshotToParent(child, rootSnapshot.rect);
  }
}

function isGeneratedRootOverlaySnapshot(node: ElementSnapshot): boolean {
  return Boolean(
    node.attributes["data-h2d-toolbar-action"] ||
    node.attributes["data-h2d-status-overlay"] ||
    node.attributes["data-h2d-tab-overlay"] ||
    node.attributes["data-h2d-connected-tab-surface"],
  );
}

function clampSlightViewportRootOverscroll(rootSnapshot: ElementSnapshot): void {
  clampSlightViewportOverscrollInner(rootSnapshot, rootSnapshot.rect);
}

function clampSlightViewportOverscrollInner(node: ElementSnapshot, viewportRect: ElementRect): void {
  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    clampSlightViewportOverscrollNode(child, viewportRect);
    clampSlightViewportOverscrollInner(child, viewportRect);
  }
}

function clampSlightViewportOverscrollNode(node: ElementSnapshot, viewportRect: ElementRect): void {
  if (!isSnapshotOverflowClipContainer(node.styles)) return;

  const viewportRight = viewportRect.x + viewportRect.width;
  const viewportBottom = viewportRect.y + viewportRect.height;
  const nodeRight = node.rect.x + node.rect.width;
  const nodeBottom = node.rect.y + node.rect.height;

  const bottomOvershoot = nodeBottom - viewportBottom;
  if (
    bottomOvershoot > 0 &&
    bottomOvershoot <= 32 &&
    node.rect.y >= viewportRect.y - 1 &&
    node.rect.height > bottomOvershoot
  ) {
    node.rect.height -= bottomOvershoot;
    node.rect.cssHeight = Math.round(node.rect.height);
    node.styles.height = `${roundPx(node.rect.height)}px`;
  }

  const rightOvershoot = nodeRight - viewportRight;
  if (
    rightOvershoot > 0 &&
    rightOvershoot <= 32 &&
    node.rect.x >= viewportRect.x - 1 &&
    node.rect.width > rightOvershoot
  ) {
    node.rect.width -= rightOvershoot;
    node.rect.cssWidth = Math.round(node.rect.width);
    node.styles.width = `${roundPx(node.rect.width)}px`;
  }
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
      child.styles.overflow = "hidden";
      child.styles.overflowX = "hidden";
      child.styles.overflowY = "hidden";

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
  const visibleBounds = getSnapshotDescendantVisibleBounds(node.childNodes, viewportRect);
  if (!visibleBounds) return false;
  const viewportBottom = viewportRect.y + viewportRect.height;
  const nodeBottom = node.rect.y + node.rect.height;
  if (nodeBottom < viewportRect.height * 0.55 && visibleBounds.y + visibleBounds.height <= nodeBottom + 1) {
    return false;
  }
  if (node.rect.width < viewportRect.width * 0.55) return false;
  if (!hasSnapshotDescendantInsideRect(node.childNodes, viewportRect)) return false;
  if (nodeBottom < viewportBottom - 1 && !isViewportShellLikeSnapshot(node, viewportRect)) return false;

  return isViewportShellLikeSnapshot(node, viewportRect);
}

function isViewportShellLikeSnapshot(
  node: ElementSnapshot,
  viewportRect: { width: number; height: number },
): boolean {
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
  let rasterizedFrame = false;

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

  const iconFontGlyphSnapshot = snapshotIconFontGlyphElement(element, assetCollector);
  if (iconFontGlyphSnapshot) {
    return iconFontGlyphSnapshot;
  }

  const clippedCornerMarkerSnapshot = snapshotClippedCornerMarkerElement(element);
  if (clippedCornerMarkerSnapshot) {
    return clippedCornerMarkerSnapshot;
  }

  const borderTriangleSnapshot = snapshotCssBorderTriangleElement(element);
  if (borderTriangleSnapshot) {
    return borderTriangleSnapshot;
  }

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
  preserveFloatingMenuSurfaceStyles(element, computedStyles);
  const absorbedPseudoElements = absorbFullCoverBackgroundPseudos(element, computedStyles);

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
    svgContent = bakeSvgStyles(element, ctx.svgSpriteCache);
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

  materializeLinearGradientCornerMarker(element, computedStyles, childNodes);
  stabilizeTopChromeLayout(element, computedStyles, childNodes);

  // Pseudo-element styles (::before, ::after, ::placeholder).
  let pseudoElementStyles: Record<string, Record<string, string>> | undefined;
  const materializedPseudoElements = materializePseudoElements(element, childNodes, absorbedPseudoElements);

  // ::before / ::after — capture when they have visible content
  for (const pseudo of ["::before", "::after"] as const) {
    const pseudoComputed = getComputedStyleFor(element, pseudo);
    const contentValue = pseudoComputed.content;
    if (contentValue && contentValue !== "none" && contentValue !== "normal") {
      if (absorbedPseudoElements.has(pseudo)) continue;
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
  rect = applyNegativeVirtualScrollOffsetToElementRect(element, rect);
  rect = normalizeSmallSvgImageRect(element, computedStyles, rect);
  rect = normalizeTopChromeTextLineBox(element, computedStyles, childNodes, rect);
  normalizeExcessiveBorderRadii(computedStyles, rect);
  const insetClipPathNormalized = normalizeInsetClipPathElement(computedStyles, rect);
  const visibleImageCropRect = getSmallVisibleImageViewportCropRect(element);
  if (visibleImageCropRect) {
    placeholderUrl = assetCollector.addViewportCrop(visibleImageCropRect);
    tagOverride = "CANVAS";
    rasterizedFrame = true;
    computedStyles.overflow = "hidden";
    computedStyles.overflowX = "hidden";
    computedStyles.overflowY = "hidden";
  }
  if (isTableMeasurementSnapshot(element, rect, childNodes)) {
    return null;
  }
  unclipZeroSizeVisibleWrapper(computedStyles, rect, childNodes);
  const externalPseudoOverflowRelaxed = relaxExternalPseudoElementClipping(computedStyles, rect, childNodes);
  const externalControlOverflowRelaxed = relaxExternalMaterializedControlClipping(computedStyles, rect, childNodes);
  const externalRuleOverflowRelaxed = relaxExternalRuleElementClipping(computedStyles, rect, childNodes);
  const popupActionOverflowRelaxed = relaxPopupActionClipping(element, computedStyles, rect, childNodes);
  const verticalScrollViewportStabilized = stabilizeVerticalOverlayScrollViewport(element, computedStyles, childNodes, rect);
  stabilizeHorizontalScrolledTableViewport(element, computedStyles, childNodes, rect);
  const iframeCropRect = getEmptyIframeViewportCropRect(element, rect, childNodes);
  if (iframeCropRect) {
    rect = iframeCropRect;
    placeholderUrl = assetCollector.addViewportCrop(iframeCropRect);
    tagOverride = "CANVAS";
    rasterizedFrame = true;
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
  if (insetClipPathNormalized || stabilizeMeasuredInlineTextGroup(element, computedStyles, rect, childNodes)) {
    sizing.horizontal = "FIXED";
    sizing.vertical = "FIXED";
  }

  const attributes = getSnapshotElementAttributes(element, verticalScrollViewportStabilized);
  if (popupActionOverflowRelaxed) {
    attributes["data-h2d-popup-action-overflow"] = "true";
  }
  if (externalPseudoOverflowRelaxed) {
    attributes["data-h2d-external-pseudo-overflow"] = "true";
  }
  if (externalControlOverflowRelaxed) {
    attributes["data-h2d-external-control-overflow"] = "true";
  }
  if (externalRuleOverflowRelaxed) {
    attributes["data-h2d-external-rule-overflow"] = "true";
  }
  if (rasterizedFrame) {
    attributes["data-h2d-rasterized-frame"] = "true";
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

function snapshotIconFontGlyphElement(
  element: Element,
  assetCollector: ResourceResolver,
): ElementSnapshot | null {
  const glyphText = getPrivateUseGlyphText(element);
  if (!glyphText || !isIconFontGlyphElement(element, glyphText)) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const iconCanvas = createIconFontGlyphCanvas(element, glyphText, rect);
  if (!iconCanvas) return null;

  const computed = getComputedStyleFor(element);
  const styles: Record<string, string> = {
    display: "block",
    boxSizing: "border-box",
    width: `${roundPx(rect.width)}px`,
    height: `${roundPx(rect.height)}px`,
    overflow: "hidden",
  };

  if (computed.opacity && computed.opacity !== "1") {
    styles.opacity = computed.opacity;
  }
  if (computed.transform && computed.transform !== "none") {
    styles.transform = computed.transform;
  }
  if (computed.borderRadius && computed.borderRadius !== "0px") {
    styles.borderRadius = computed.borderRadius;
  }

  return {
    nodeType: Node.ELEMENT_NODE as 1,
    id: generateNodeId(element),
    tag: "CANVAS",
    attributes: {
      ...getSnapshotElementAttributes(element),
      "data-h2d-icon-font-glyph": "true",
    },
    styles,
    rect: toElementRect(rect),
    childNodes: [],
    placeholderUrl: assetCollector.addCanvas(iconCanvas),
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function isIconFontGlyphElement(element: Element, glyphText: string): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "HTML" || tag === "BODY" || tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
    return false;
  }

  if (element.childElementCount > 0) return false;
  if (glyphText.length > 4) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4 || rect.width > 64 || rect.height > 64) return false;

  const computed = getComputedStyleFor(element);
  if (computed.visibility === "hidden" || computed.display === "none") return false;
  if (Number.parseFloat(computed.opacity || "1") <= 0.01) return false;

  const fontFamily = computed.fontFamily || "";
  const identity = getElementIdentity(element);
  const hasIconIdentity =
    /(^|[-_\s])(icon|glyph|symbol)([-_\s]|$)/i.test(identity) ||
    /icon|symbol|glyph/i.test(fontFamily);
  const looksSquare = rect.width <= rect.height * 2.5 && rect.height <= rect.width * 2.5;

  return hasIconIdentity || looksSquare;
}

function getPrivateUseGlyphText(element: Element): string {
  const rawText = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || "")
    .join("");
  if (!PRIVATE_USE_GLYPH_PATTERN.test(rawText)) return "";

  const glyphText = rawText.replace(/\s+/g, "");
  return PRIVATE_USE_GLYPH_ONLY_PATTERN.test(glyphText) ? glyphText : "";
}

function getSmallVisibleImageViewportCropRect(element: Element): Rect | null {
  if (!isInstanceOfOwner<HTMLImageElement>(element, element, "HTMLImageElement")) return null;

  const img = element;
  const src = img.currentSrc || img.src || img.getAttribute("src") || "";
  if (!src) return null;
  if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return null;
  if (!isSmallIdentityImageElement(img, src)) return null;

  const view = getNodeWindow(img);
  if (view.top !== view) return null;

  const rect = img.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4 || rect.width > 240 || rect.height > 120) return null;
  if (rect.left < 0 || rect.top < 0 || rect.right > view.innerWidth || rect.bottom > view.innerHeight) {
    return null;
  }

  const computed = getComputedStyleFor(img);
  if (computed.display === "none" || computed.visibility === "hidden") return null;
  if (Number.parseFloat(computed.opacity || "1") <= 0.01) return null;

  return {
    x: rect.left,
    y: rect.top,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  };
}

function isSmallIdentityImageElement(img: HTMLImageElement, src: string): boolean {
  const identity = [
    getElementIdentity(img),
    img.alt,
    img.title,
    img.getAttribute("aria-label") || "",
    src,
  ].join(" ");

  return /(^|[-_/.\s])(logo|brand|avatar|portrait|head|icon|symbol|favicon|userpic|profile|图标|头像|标识)([-_/.\s]|$)/i.test(identity);
}

function createIconFontGlyphCanvas(
  element: Element,
  glyphText: string,
  rect: DOMRect,
): HTMLCanvasElement | null {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const view = getNodeWindow(element);
  const scale = Math.max(1, Math.min(3, view.devicePixelRatio || 1));
  const canvas = getNodeDocument(element).createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const computed = getComputedStyleFor(element);
  ctx.scale(scale, scale);
  ctx.font = getCanvasFontForElement(computed, height);
  ctx.fillStyle = isVisiblePaint(computed.color) ? computed.color : "rgb(18, 18, 18)";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.direction = computed.direction === "rtl" ? "rtl" : "ltr";

  const metrics = ctx.measureText(glyphText);
  const left = Number.isFinite(metrics.actualBoundingBoxLeft) ? metrics.actualBoundingBoxLeft : 0;
  const right = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : metrics.width;
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) && metrics.actualBoundingBoxAscent > 0
    ? metrics.actualBoundingBoxAscent
    : height * 0.75;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
    ? metrics.actualBoundingBoxDescent
    : height * 0.25;
  const glyphWidth = Math.max(1, left + right, metrics.width);
  const glyphHeight = Math.max(1, ascent + descent);
  const x = (width - glyphWidth) / 2 + left;
  const y = (height - glyphHeight) / 2 + ascent;

  ctx.fillText(glyphText, x, y);
  return canvas;
}

function getCanvasFontForElement(computed: CSSStyleDeclaration, fallbackHeight: number): string {
  if (computed.font && computed.font !== "normal") {
    return computed.font;
  }

  const fontStyle = computed.fontStyle && computed.fontStyle !== "normal" ? computed.fontStyle : "";
  const fontVariant = computed.fontVariant && computed.fontVariant !== "normal" ? computed.fontVariant : "";
  const fontWeight = computed.fontWeight || "400";
  const fontSize = computed.fontSize || `${roundPx(Math.max(1, fallbackHeight))}px`;
  const fontFamily = computed.fontFamily || "sans-serif";
  return [fontStyle, fontVariant, fontWeight, fontSize, fontFamily].filter(Boolean).join(" ");
}

function normalizeExcessiveBorderRadii(
  styles: Record<string, string>,
  rect: { width: number; height: number },
): void {
  if (rect.width <= 0 || rect.height <= 0) return;

  const maxUsefulRadius = Math.max(0, Math.min(rect.width, rect.height) / 2);
  if (maxUsefulRadius <= 0) return;

  for (const corner of ["TopLeft", "TopRight", "BottomRight", "BottomLeft"] as const) {
    const key = `border${corner}Radius`;
    const value = styles[key];
    if (!value || value === "0px") continue;

    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) continue;
    if (!/px$/i.test(value.trim())) continue;
    if (parsed <= maxUsefulRadius * 2 && !/[eE][+-]?\d+/.test(value)) continue;

    styles[key] = `${roundPx(maxUsefulRadius)}px`;
  }
}

function normalizeInsetClipPathElement(
  styles: Record<string, string>,
  rect: ElementRect,
): boolean {
  const inset = parseInsetClipPath(styles.clipPath || "", rect.width, rect.height);
  if (!inset) return false;

  const visibleWidth = rect.width - inset.left - inset.right;
  const visibleHeight = rect.height - inset.top - inset.bottom;
  if (visibleWidth <= 0 || visibleHeight <= 0) return false;

  const changed =
    inset.top > 0.01 ||
    inset.right > 0.01 ||
    inset.bottom > 0.01 ||
    inset.left > 0.01 ||
    Boolean(inset.radius);
  if (!changed) return false;

  rect.x = roundPx(rect.x + inset.left);
  rect.y = roundPx(rect.y + inset.top);
  rect.width = roundPx(visibleWidth);
  rect.height = roundPx(visibleHeight);
  rect.cssWidth = Math.round(rect.width);
  rect.cssHeight = Math.round(rect.height);

  styles.width = `${roundPx(rect.width)}px`;
  styles.height = `${roundPx(rect.height)}px`;
  styles.overflow = "hidden";
  styles.overflowX = "hidden";
  styles.overflowY = "hidden";
  delete styles.clipPath;

  if (inset.radius) {
    styles.borderTopLeftRadius = inset.radius;
    styles.borderTopRightRadius = inset.radius;
    styles.borderBottomRightRadius = inset.radius;
    styles.borderBottomLeftRadius = inset.radius;
  }

  return true;
}

function parseInsetClipPath(
  value: string,
  width: number,
  height: number,
): { top: number; right: number; bottom: number; left: number; radius?: string } | null {
  const match = value.trim().match(/^inset\((.*)\)$/i);
  if (!match) return null;

  const [insetPartRaw, radiusPartRaw] = match[1].split(/\s+round\s+/i);
  if (!insetPartRaw || /calc\(/i.test(insetPartRaw)) return null;

  const parts = insetPartRaw.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return null;

  const [topToken, rightToken = topToken, bottomToken = topToken, leftToken = rightToken] = parts;
  const top = parseCssInsetLength(topToken, height);
  const right = parseCssInsetLength(rightToken, width);
  const bottom = parseCssInsetLength(bottomToken, height);
  const left = parseCssInsetLength(leftToken, width);
  if (![top, right, bottom, left].every((part) => Number.isFinite(part) && part >= 0)) return null;

  const radius = parseInsetClipRadius(radiusPartRaw, Math.min(width - left - right, height - top - bottom));
  return { top, right, bottom, left, radius };
}

function parseCssInsetLength(value: string, axisSize: number): number {
  const trimmed = value.trim();
  const parsed = parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return NaN;
  if (trimmed.endsWith("%")) return axisSize * parsed / 100;
  if (/^-?\d*\.?\d+(?:px)?$/i.test(trimmed)) return parsed;
  return NaN;
}

function parseInsetClipRadius(value: string | undefined, boxSize: number): string | undefined {
  if (!value) return undefined;
  if (/calc\(/i.test(value)) return undefined;

  const token = value.trim().split(/\s+|\/+/).find(Boolean);
  if (!token) return undefined;

  const parsed = parseFloat(token);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;

  const radius = token.endsWith("%")
    ? Math.max(0, boxSize) * parsed / 100
    : parsed;
  return radius > 0 ? `${roundPx(radius)}px` : undefined;
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

function preserveFloatingMenuSurfaceStyles(element: Element, styles: Record<string, string>): void {
  const computed = getComputedStyleFor(element);
  if (!isFloatingMenuContentCandidate(element, computed)) return;

  const surfaceAncestor = findFloatingMenuSurfaceAncestor(element);
  if (surfaceAncestor) {
    copyCompactToolbarActionSurfaceStyles(getComputedStyleFor(surfaceAncestor), styles);
  }
  copyCompactToolbarActionSurfaceStyles(computed, styles);
}

function findFloatingMenuSurfaceAncestor(element: Element): Element | null {
  const elementRect = element.getBoundingClientRect();
  let ancestor = element.parentElement;
  let depth = 0;

  while (ancestor && depth < 5) {
    const tag = ancestor.tagName.toUpperCase();
    if (tag === "HTML" || tag === "BODY") break;

    const rect = ancestor.getBoundingClientRect();
    if (isCloseSurfaceRect(rect, elementRect)) {
      const computed = getComputedStyleFor(ancestor);
      if (isFloatingMenuSurfaceCandidate(ancestor, computed)) {
        return ancestor;
      }
    }

    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return null;
}

function isFloatingMenuContentCandidate(element: Element, computed: CSSStyleDeclaration): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "HTML" || tag === "BODY") return false;
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 48 || rect.height < 32 || rect.width > 720 || rect.height > 820) return false;

  const role = element.getAttribute("role")?.toLowerCase() || "";
  const hasMenuRole = /^(menu|listbox|tree)$/i.test(role);
  const menuItemCount = element.querySelectorAll(
    '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="treeitem"]',
  ).length;
  if (!hasMenuRole && menuItemCount < 2) return false;

  return hasDirectVisibleText(element) || hasVisibleTextDescendant(element);
}

function isFloatingMenuSurfaceCandidate(element: Element, computed: CSSStyleDeclaration): boolean {
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 48 || rect.height < 32 || rect.width > 760 || rect.height > 860) return false;

  const role = element.getAttribute("role")?.toLowerCase() || "";
  const identity = getElementIdentity(element);
  const looksFloating =
    /^(menu|listbox|tree|dialog|alertdialog)$/i.test(role) ||
    computed.position === "absolute" ||
    computed.position === "fixed" ||
    (computed.transform && computed.transform !== "none") ||
    /(^|[-_\s])(popover|popper|popup|floating|dropdown|menu|dialog|portal|content|surface)([-_\s]|$)/i.test(identity);
  if (!looksFloating) return false;

  return (
    isVisiblePaint(computed.backgroundColor) ||
    hasVisibleBorderStyles(computed) ||
    Boolean(computed.boxShadow && computed.boxShadow !== "none") ||
    hasRoundedCorners(computed, 4)
  );
}

function isCloseSurfaceRect(
  outer: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  inner: { left: number; top: number; right: number; bottom: number; width: number; height: number },
): boolean {
  if (outer.width <= 0 || outer.height <= 0 || inner.width <= 0 || inner.height <= 0) return false;
  if (inner.left < outer.left - 24 || inner.top < outer.top - 24) return false;
  if (inner.right > outer.right + 24 || inner.bottom > outer.bottom + 24) return false;
  return outer.width <= inner.width + 96 && outer.height <= inner.height + 96;
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
  const normalized = normalizeCssColorFunctions(color || "").trim().toLowerCase();
  if (!normalized || normalized === "transparent" || normalized === "rgba(0, 0, 0, 0)") return false;

  const rgbaMatch = normalized.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)$/);
  if (rgbaMatch) {
    const alpha = parseFloat(rgbaMatch[1]);
    return !Number.isFinite(alpha) || alpha > 0.01;
  }

  return true;
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
  displayText: string;
  hasIcon: boolean;
  rect?: DOMRect;
  textRect?: DOMRect;
  styleElement?: Element;
  surfaceElement?: Element | null;
  preserveSource?: boolean;
}

interface StructuralTabGroup {
  tabList: Element;
  tabs: Element[];
  rect: DOMRect;
}

function appendCompactToolbarActionOverlays(rootSnapshot: ElementSnapshot, rootElement: Element): void {
  const rootRect = rootElement.getBoundingClientRect();
  const offsetX = rootSnapshot.rect.x - rootRect.x;
  const offsetY = rootSnapshot.rect.y - rootRect.y;

  appendCompactToolbarActionOverlaysForRoot(rootSnapshot, rootElement, offsetX, offsetY);
  appendIframeCompactToolbarActionOverlays(rootSnapshot, rootElement, offsetX, offsetY);
}

function appendCompactToolbarActionOverlaysForRoot(
  rootSnapshot: ElementSnapshot,
  rootElement: Element,
  offsetX: number,
  offsetY: number,
): void {
  const captureRect = getVisibleCaptureRect(rootElement);
  const actions = collectCompactToolbarActions(rootElement, captureRect);
  if (actions.length === 0) return;

  const overlays: Array<{ sourceId: string; overlay: ElementSnapshot }> = [];
  for (const action of actions) {
    const overlay = createCompactToolbarActionOverlayForAction(action);
    if (!overlay) continue;

    offsetSnapshotNode(overlay, offsetX, offsetY);
    anchorSnapshotToParent(overlay, rootSnapshot.rect);
    overlays.push({ sourceId: action.preserveSource ? "" : generateNodeId(action.element), overlay });
  }
  if (overlays.length === 0) return;

  const actionIds = new Set(overlays.map(({ sourceId }) => sourceId).filter(Boolean));
  actionIds.delete(rootSnapshot.id);
  pruneSnapshotsByIds(rootSnapshot, actionIds);

  for (const { overlay } of overlays) {
    rootSnapshot.childNodes.push(overlay);
  }
}

function appendIframeCompactToolbarActionOverlays(
  rootSnapshot: ElementSnapshot,
  rootElement: Element,
  offsetX: number,
  offsetY: number,
): void {
  const iframes = rootElement.tagName.toUpperCase() === "IFRAME"
    ? [rootElement]
    : Array.from(rootElement.querySelectorAll("iframe"));

  for (const iframe of iframes) {
    const iframeRect = iframe.getBoundingClientRect();
    if (iframeRect.width <= 0 || iframeRect.height <= 0) continue;
    if (!isRectNearCaptureRect(iframeRect, getVisibleCaptureRect(rootElement))) continue;

    const frameDocument = getReadableIframeDocument(iframe);
    if (!frameDocument?.documentElement) continue;

    const frameElement = iframe as HTMLElement;
    const frameOffsetX = offsetX + iframeRect.x + frameElement.clientLeft;
    const frameOffsetY = offsetY + iframeRect.y + frameElement.clientTop;
    appendCompactToolbarActionOverlaysForRoot(
      rootSnapshot,
      frameDocument.documentElement,
      frameOffsetX,
      frameOffsetY,
    );
  }
}

function collectCompactToolbarActions(rootElement: Element, captureRect: DOMRect): CompactToolbarAction[] {
  const roots = [rootElement, ...Array.from(rootElement.querySelectorAll("*"))];
  const collected: CompactToolbarAction[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!isElementVisibleInDocument(root)) continue;

    const rootRect = root.getBoundingClientRect();
    if (!isRectNearCaptureRect(rootRect, captureRect)) continue;

    const actions = getDirectCompactToolbarActions(root, rootRect, captureRect);
    if (!isCompactToolbarRoot(root, rootRect, actions)) continue;

    for (const action of actions) {
      const key = getCompactToolbarActionSeenKey(action);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(action);
    }
  }

  for (const action of collectCompactToolbarActionRows(rootElement, captureRect)) {
    const key = getCompactToolbarActionSeenKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    collected.push(action);
  }

  for (const action of collectTextRangeCompactToolbarActionRows(rootElement, captureRect)) {
    const key = getCompactToolbarActionSeenKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    collected.push(action);
  }

  return collected;
}

function collectCompactToolbarActionRows(rootElement: Element, captureRect: DOMRect): CompactToolbarAction[] {
  const candidates: CompactToolbarAction[] = [];

  for (const element of Array.from(rootElement.querySelectorAll("*"))) {
    const action = getStandaloneCompactToolbarAction(element, captureRect);
    if (action) candidates.push(action);
  }

  const deduped = dedupeCompactToolbarActionCandidates(candidates);
  const rows = groupCompactToolbarActionCandidatesByRow(deduped);
  const actions: CompactToolbarAction[] = [];

  for (const row of rows) {
    if (!isCompactToolbarActionRow(row, captureRect)) continue;
    actions.push(...row);
  }

  return actions;
}

function collectTextRangeCompactToolbarActionRows(rootElement: Element, captureRect: DOMRect): CompactToolbarAction[] {
  const candidates = collectTextRangeCompactToolbarActionCandidates(rootElement, captureRect);
  const deduped = dedupeCompactToolbarActionCandidates(candidates);
  const rows = groupCompactToolbarActionCandidatesByRow(deduped);
  const actions: CompactToolbarAction[] = [];

  for (const row of rows) {
    if (!isCompactToolbarActionRow(row, captureRect)) continue;
    actions.push(...row);
  }

  return actions;
}

function collectTextRangeCompactToolbarActionCandidates(
  rootElement: Element,
  captureRect: DOMRect,
): CompactToolbarAction[] {
  const ownerDocument = getNodeDocument(rootElement);
  const walker = ownerDocument.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT);
  const actions: CompactToolbarAction[] = [];
  let current = walker.nextNode();

  while (current) {
    const textNode = current as Text;
    const parent = textNode.parentElement;
    if (!parent || !isElementLocallyVisible(parent)) {
      current = walker.nextNode();
      continue;
    }

    const rawText = textNode.textContent || "";
    for (const segment of extractToolbarActionTextSegments(rawText)) {
      const textRect = getTextNodeSubstringRect(textNode, segment.start, segment.end);
      if (!textRect) continue;
      if (!isRectNearCaptureRect(textRect, captureRect, 16)) continue;
      if (textRect.width < 12 || textRect.height < 8 || textRect.height > 36) continue;

      const surfaceElement = findCompactToolbarActionSurfaceElement(parent, textRect);
      const surfaceRect = surfaceElement?.getBoundingClientRect() ?? null;
      const rect = surfaceRect ?? getPaddedToolbarActionTextRect(textRect);
      if (rect.width < 40 || rect.width > 240 || rect.height < 20 || rect.height > 44) continue;
      if (!isRectNearCaptureRect(rect, captureRect, 16)) continue;

      actions.push({
        element: surfaceElement ?? parent,
        text: segment.text,
        displayText: segment.text,
        hasIcon: Boolean(surfaceElement && findToolbarActionSvg(surfaceElement)),
        rect,
        textRect,
        styleElement: parent,
        surfaceElement,
        preserveSource: !surfaceElement,
      });
    }

    current = walker.nextNode();
  }

  return actions;
}

function getDirectCompactToolbarActions(root: Element, rootRect: DOMRect, captureRect: DOMRect): CompactToolbarAction[] {
  const actions: CompactToolbarAction[] = [];

  for (const child of Array.from(root.children)) {
    const action = getCompactToolbarAction(child, rootRect, captureRect);
    if (action) actions.push(action);
  }

  return actions;
}

function getStandaloneCompactToolbarAction(element: Element, captureRect: DOMRect): CompactToolbarAction | null {
  if (!isElementLocallyVisible(element)) return null;

  const tag = element.tagName.toUpperCase();
  if (["INPUT", "SELECT", "TEXTAREA", "OPTION"].includes(tag)) return null;
  const role = element.getAttribute("role") || "";
  if (/^(tab|tablist|option|listbox|combobox)$/i.test(role)) return null;

  const sourceRect = element.getBoundingClientRect();
  const surfaceElement =
    findTopRightCompactToolbarActionSurfaceElement(element, sourceRect, captureRect) ??
    findCompactToolbarActionSurfaceElement(element, sourceRect);
  const actionElement = surfaceElement ?? element;
  const rect = actionElement.getBoundingClientRect();
  if (!isRectNearCaptureRect(rect, captureRect, 16)) return null;
  if (rect.width < 40 || rect.width > 220 || rect.height < 20 || rect.height > 42) return null;
  if (!isElementTopVisibleAtCenter(actionElement, rect)) return null;

  const displayText = getElementVisibleText(actionElement);
  const text = normalizeToolbarActionText(displayText);
  if (!text || text.length > 32) return null;

  const hasIcon = Boolean(findToolbarActionSvg(actionElement));
  if (
    !hasIcon &&
    !isPlainCompactToolbarButton(actionElement) &&
    !isTopRightCompactToolbarButton(actionElement, rect, captureRect) &&
    !isLikelyCompactToolbarActionButton(actionElement, text)
  ) {
    return null;
  }

  return { element: actionElement, text, displayText, hasIcon };
}

function getCompactToolbarAction(element: Element, rootRect: DOMRect, captureRect: DOMRect): CompactToolbarAction | null {
  if (!isElementVisibleInDocument(element)) return null;

  const tag = element.tagName.toUpperCase();
  if (["INPUT", "SELECT", "TEXTAREA", "OPTION"].includes(tag)) return null;
  const role = element.getAttribute("role") || "";
  if (/^(tab|tablist|option|listbox|combobox)$/i.test(role)) return null;

  const rect = element.getBoundingClientRect();
  if (!isRectNearCaptureRect(rect, captureRect)) return null;
  if (!isElementTopVisibleAtCenter(element, rect)) return null;
  if (rect.width < 16 || rect.width > 220 || rect.height < 12 || rect.height > 36) return null;
  if (Math.abs(getRectCenterY(rect) - getRectCenterY(rootRect)) > 12) return null;

  const displayText = getElementVisibleText(element);
  const text = normalizeToolbarActionText(displayText);
  if (!text || text.length > 32) return null;
  const hasIcon = Boolean(findToolbarActionSvg(element));
  if (!hasIcon && !isPlainCompactToolbarButton(element)) return null;

  return { element, text, displayText, hasIcon };
}

function dedupeCompactToolbarActionCandidates(actions: CompactToolbarAction[]): CompactToolbarAction[] {
  const selected: CompactToolbarAction[] = [];
  const ordered = [...actions].sort((a, b) => {
    const aArea = getCompactToolbarActionRectArea(a);
    const bArea = getCompactToolbarActionRectArea(b);
    if (aArea !== bArea) return aArea - bArea;
    return compareElementsByDocumentPosition(a.element, b.element);
  });

  for (const action of ordered) {
    const duplicate = selected.some((existing) => isSameCompactToolbarActionCandidate(existing, action));
    if (duplicate) continue;
    selected.push(action);
  }

  return selected.sort((a, b) => {
    const aRect = getCompactToolbarActionRect(a);
    const bRect = getCompactToolbarActionRect(b);
    if (Math.abs(aRect.top - bRect.top) > 1) return aRect.top - bRect.top;
    return aRect.left - bRect.left;
  });
}

function getCompactToolbarActionRectArea(action: CompactToolbarAction): number {
  const rect = getCompactToolbarActionRect(action);
  return Math.max(1, rect.width * rect.height);
}

function compareElementsByDocumentPosition(a: Element, b: Element): number {
  if (a === b) return 0;
  const position = a.compareDocumentPosition(b);
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  return 0;
}

function isSameCompactToolbarActionCandidate(a: CompactToolbarAction, b: CompactToolbarAction): boolean {
  if (a.element === b.element) return true;
  if (!a.element.contains(b.element) && !b.element.contains(a.element)) return false;

  const aText = normalizeToolbarActionText(a.displayText);
  const bText = normalizeToolbarActionText(b.displayText);
  if (aText !== bText && !aText.includes(bText) && !bText.includes(aText)) return false;

  const overlap = getRectOverlapRatio(
    getCompactToolbarActionRect(a),
    getCompactToolbarActionRect(b),
  );
  return overlap >= 0.72;
}

function getRectOverlapRatio(a: DOMRect, b: DOMRect): number {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return 0;

  const intersectionArea = (right - left) * (bottom - top);
  const aArea = Math.max(1, a.width * a.height);
  const bArea = Math.max(1, b.width * b.height);
  return intersectionArea / Math.min(aArea, bArea);
}

function groupCompactToolbarActionCandidatesByRow(actions: CompactToolbarAction[]): CompactToolbarAction[][] {
  const rows: Array<{ centerY: number; actions: CompactToolbarAction[] }> = [];

  for (const action of actions) {
    const rect = getCompactToolbarActionRect(action);
    const centerY = getRectCenterY(rect);
    const row = rows.find((candidate) => Math.abs(candidate.centerY - centerY) <= 6);
    if (row) {
      row.actions.push(action);
      row.centerY = row.actions.reduce((sum, item) => sum + getRectCenterY(getCompactToolbarActionRect(item)), 0) / row.actions.length;
    } else {
      rows.push({ centerY, actions: [action] });
    }
  }

  return rows.map((row) => row.actions.sort((a, b) => {
    const aRect = getCompactToolbarActionRect(a);
    const bRect = getCompactToolbarActionRect(b);
    return aRect.left - bRect.left;
  }));
}

function isCompactToolbarActionRow(actions: CompactToolbarAction[], captureRect: DOMRect): boolean {
  if (actions.length < 3 || actions.length > 12) return false;

  const rects = actions.map(getCompactToolbarActionRect);
  const bounds = unionDOMRects(rects);
  if (!bounds) return false;
  if (!isRectNearCaptureRect(bounds, captureRect, 16)) return false;
  if (bounds.width < 120 || bounds.width > 900 || bounds.height < 20 || bounds.height > 56) return false;

  const centers = rects.map(getRectCenterY);
  if (Math.max(...centers) - Math.min(...centers) > 8) return false;

  let previousRight = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    if (rect.left < previousRight - 2) return false;
    previousRight = Math.max(previousRight, rect.right);
  }

  return true;
}

function isCompactToolbarRoot(root: Element, rootRect: DOMRect, actions: CompactToolbarAction[]): boolean {
  if (actions.length < 2 || actions.length > 12) return false;
  if (!actions.some((action) => action.hasIcon) && actions.length < 3) return false;
  if (rootRect.width < 40 || rootRect.width > 900 || rootRect.height < 12 || rootRect.height > 48) return false;

  const centers = actions.map((action) => getRectCenterY(getCompactToolbarActionRect(action)));
  if (Math.max(...centers) - Math.min(...centers) > 8) return false;

  const bounds = unionDOMRects(actions.map(getCompactToolbarActionRect));
  if (!bounds) return false;
  if (bounds.left < rootRect.left - 4 || bounds.right > rootRect.right + 4) return false;
  if (bounds.top < rootRect.top - 4 || bounds.bottom > rootRect.bottom + 4) return false;

  const rootText = normalizeToolbarActionText(getElementVisibleText(root));
  const actionText = actions.map((action) => action.text).join("");
  return rootText.includes(actionText);
}

function isLikelyCompactToolbarActionButton(element: Element, text: string): boolean {
  if (!isToolbarActionText(text)) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 40 || rect.width > 240 || rect.height < 20 || rect.height > 44) return false;

  const computed = getComputedStyleFor(element);
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;

  const hasButtonSurface =
    isVisiblePaint(computed.backgroundColor) ||
    Boolean(computed.backgroundImage && computed.backgroundImage !== "none") ||
    hasVisibleBorderStyles(computed) ||
    Boolean(computed.boxShadow && computed.boxShadow !== "none");
  if (!hasButtonSurface) return false;

  return hasRoundedCorners(computed, 1) ||
    hasVisibleBorderStyles(computed) ||
    Boolean(computed.boxShadow && computed.boxShadow !== "none");
}

function isToolbarActionText(text: string): boolean {
  if (!text || text.length > 32) return false;
  return TOOLBAR_ACTION_TEXT_PATTERN.test(text);
}

function countToolbarActionTextHits(text: string): number {
  const matches = text.match(TOOLBAR_ACTION_TEXT_HIT_PATTERN);
  return matches ? new Set(matches).size : 0;
}

function getCompactToolbarActionRect(action: CompactToolbarAction): DOMRect {
  return action.rect ?? action.element.getBoundingClientRect();
}

function getCompactToolbarActionSeenKey(action: CompactToolbarAction): string {
  if (!action.rect) return generateNodeId(action.element);

  const rect = action.rect;
  return [
    action.text,
    Math.round(rect.left),
    Math.round(rect.top),
    Math.round(rect.width),
    Math.round(rect.height),
  ].join(":");
}

function isPlainCompactToolbarButton(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  const role = element.getAttribute("role") || "";
  const identity = getElementIdentity(element);
  if (tag !== "BUTTON" && !/^button$/i.test(role) && !/(^|[-_\s])(btn|button)([-_\s]|$)/i.test(identity)) {
    return false;
  }
  if (/(^|[-_\s])(tab|tabs|tabpane|menuitem|option|select|dropdown-item)([-_\s]|$)/i.test(identity)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 40 || rect.width > 220 || rect.height < 20 || rect.height > 40) return false;

  const computed = getComputedStyleFor(element);
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;

  const hasButtonSurface =
    isVisiblePaint(computed.backgroundColor) ||
    Boolean(computed.backgroundImage && computed.backgroundImage !== "none") ||
    hasVisibleBorderStyles(computed) ||
    Boolean(computed.boxShadow && computed.boxShadow !== "none");
  return hasButtonSurface && (hasRoundedCorners(computed, 1) || hasVisibleBorderStyles(computed));
}

function isTopRightCompactToolbarButton(
  element: Element,
  rect: DOMRect,
  captureRect: DOMRect,
): boolean {
  if (!isTopRightCompactToolbarRect(rect, captureRect)) return false;

  const tag = element.tagName.toUpperCase();
  const role = element.getAttribute("role") || "";
  const identity = getElementIdentity(element);
  if (["INPUT", "SELECT", "TEXTAREA", "OPTION"].includes(tag)) return false;
  if (/^(tab|tablist|option|listbox|combobox)$/i.test(role)) return false;
  if (/(^|[-_\s])(tab|tabs|tabpane|menuitem|option|select|dropdown-item)([-_\s]|$)/i.test(identity)) {
    return false;
  }

  const computed = getComputedStyleFor(element);
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;

  const hasVisibleBackground =
    isVisiblePaint(computed.backgroundColor) ||
    Boolean(computed.backgroundImage && computed.backgroundImage !== "none");
  const hasBorder = hasVisibleBorderStyles(computed);
  const hasShadow = Boolean(computed.boxShadow && computed.boxShadow !== "none");
  const hasRadius = hasRoundedCorners(computed, 1);
  const hasActionIdentity =
    tag === "BUTTON" ||
    tag === "A" ||
    /^(button|link)$/i.test(role) ||
    /(^|[-_\s])(btn|button|action|operation|toolbar)([-_\s]|$)/i.test(identity) ||
    computed.cursor === "pointer";
  const hasButtonSurface = hasVisibleBackground || hasBorder || hasShadow;
  if (!hasButtonSurface) return false;

  // Some legacy systems render action controls as plain div/span nodes without
  // role/button classes. For those, require a rounded/shadowed visual button
  // surface so table headers or compact filter labels do not become actions.
  return hasActionIdentity
    ? (hasRadius || hasBorder || hasShadow)
    : (hasRadius || hasShadow);
}

function findTopRightCompactToolbarActionSurfaceElement(
  source: Element,
  sourceRect: DOMRect,
  captureRect: DOMRect,
): Element | null {
  let best: { element: Element; area: number } | null = null;
  let candidate: Element | null = source;

  for (let depth = 0; candidate && depth < 8; depth += 1) {
    if (isElementLocallyVisible(candidate) && isCompactToolbarActionSurfaceElement(candidate, sourceRect)) {
      const rect = candidate.getBoundingClientRect();
      if (isTopRightCompactToolbarButton(candidate, rect, captureRect)) {
        const area = rect.width * rect.height;
        if (!best || area < best.area) {
          best = { element: candidate, area };
        }
      }
    }

    candidate = candidate.parentElement;
  }

  return best?.element ?? null;
}

function isTopRightCompactToolbarRect(rect: DOMRect, captureRect: DOMRect): boolean {
  if (rect.width < 40 || rect.width > 240 || rect.height < 20 || rect.height > 44) return false;
  if (!isRectNearCaptureRect(rect, captureRect, 16)) return false;

  const topBand = captureRect.top + Math.min(260, Math.max(120, captureRect.height * 0.32));
  if (rect.top > topBand) return false;

  const rightHalf = captureRect.left + captureRect.width * 0.5;
  return rect.left >= rightHalf;
}

function isElementLocallyVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const computed = getComputedStyleFor(element);
  if (computed.display === "none" || computed.visibility === "hidden") return false;
  const opacity = Number.parseFloat(computed.opacity || "1");
  return !Number.isFinite(opacity) || opacity > 0.01;
}

function normalizeToolbarActionText(value: string): string {
  return value.replace(/[\uE000-\uF8FF]/g, "").replace(/[\u200b-\u200f\ufeff]/g, "").replace(/\s+/g, "").trim();
}

interface ToolbarActionTextSegment {
  text: string;
  start: number;
  end: number;
}

function extractToolbarActionTextSegments(rawText: string): ToolbarActionTextSegment[] {
  const trimmedFull = getTrimmedTextSegment(rawText, 0, rawText.length);
  if (!trimmedFull) return [];

  const normalizedFull = normalizeToolbarActionText(trimmedFull.text);
  if (isToolbarActionText(normalizedFull) && normalizedFull.length <= 12) {
    return [{ ...trimmedFull, text: normalizedFull }];
  }

  const starts = Array.from(rawText.matchAll(TOOLBAR_ACTION_TEXT_START_PATTERN))
    .map((match) => match.index ?? -1)
    .filter((index) => index >= trimmedFull.start && index < trimmedFull.end);
  if (starts.length < 2) return [];

  const segments: ToolbarActionTextSegment[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? trimmedFull.end;
    const segment = getTrimmedTextSegment(rawText, start, end);
    if (!segment) continue;

    const text = normalizeToolbarActionText(segment.text);
    if (!isToolbarActionText(text)) continue;
    if (text.length < 2 || text.length > 12) continue;
    if (/[并和与及、，,。:：]$/.test(text)) continue;

    segments.push({ ...segment, text });
  }

  return segments;
}

function getTrimmedTextSegment(rawText: string, start: number, end: number): ToolbarActionTextSegment | null {
  let segmentStart = Math.max(0, start);
  let segmentEnd = Math.min(rawText.length, end);

  while (segmentStart < segmentEnd && /[\s\u200b-\u200f\ufeff]/.test(rawText[segmentStart] || "")) {
    segmentStart += 1;
  }
  while (segmentEnd > segmentStart && /[\s\u200b-\u200f\ufeff]/.test(rawText[segmentEnd - 1] || "")) {
    segmentEnd -= 1;
  }
  if (segmentEnd <= segmentStart) return null;

  return {
    text: rawText.slice(segmentStart, segmentEnd),
    start: segmentStart,
    end: segmentEnd,
  };
}

function getTextNodeSubstringRect(textNode: Text, start: number, end: number): DOMRect | null {
  if (start < 0 || end <= start || end > (textNode.textContent || "").length) return null;

  const doc = textNode.ownerDocument;
  const range = doc.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);

  try {
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return null;
    return unionDOMRects(rects);
  } finally {
    range.detach();
  }
}

function getPaddedToolbarActionTextRect(textRect: DOMRect): DOMRect {
  const horizontalPadding = Math.max(12, Math.min(24, textRect.height * 0.75));
  const verticalPadding = Math.max(6, Math.min(10, textRect.height * 0.35));
  return new DOMRect(
    textRect.x - horizontalPadding,
    textRect.y - verticalPadding,
    textRect.width + horizontalPadding * 2,
    textRect.height + verticalPadding * 2,
  );
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

function getVisibleCaptureRect(rootElement: Element, rootRect = rootElement.getBoundingClientRect()): DOMRect {
  const ownerWindow = getNodeWindow(rootElement);
  const viewportRect = new DOMRect(0, 0, ownerWindow.innerWidth, ownerWindow.innerHeight);
  const ownerDocument = getNodeDocument(rootElement);

  if (rootElement === ownerDocument.documentElement || rootElement === ownerDocument.body) {
    return viewportRect;
  }

  return intersectDOMRects(rootRect, viewportRect) ?? rootRect;
}

function intersectDOMRects(a: DOMRect, b: DOMRect): DOMRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);

  if (right <= left || bottom <= top) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

function isRectNearCaptureRect(
  rect: { left: number; top: number; right: number; bottom: number },
  captureRect: { left: number; top: number; right: number; bottom: number },
  margin = 128,
): boolean {
  return rect.right >= captureRect.left - margin &&
    rect.left <= captureRect.right + margin &&
    rect.bottom >= captureRect.top - margin &&
    rect.top <= captureRect.bottom + margin;
}

function appendContentHeaderTabOverlays(rootSnapshot: ElementSnapshot, rootElement: Element): void {
  const rootRect = rootElement.getBoundingClientRect();
  const captureRect = getVisibleCaptureRect(rootElement, rootRect);
  const primaryGroup = findPrimaryContentTabGroup(rootElement, captureRect);
  if (!primaryGroup) return;

  const secondaryGroup = findSecondaryContentTabGroup(rootElement, primaryGroup);
  const primaryTabs = collectTabGroupOverlays(primaryGroup, "primary");
  if (primaryTabs.length < Math.min(4, primaryGroup.tabs.length)) return;

  const secondaryTabs = secondaryGroup ? collectTabGroupOverlays(secondaryGroup, "secondary") : [];
  const topSurfaceRect = findConnectedTopSurfaceRect(rootElement, primaryGroup.rect);
  const offsetX = rootSnapshot.rect.x - rootRect.x;
  const offsetY = rootSnapshot.rect.y - rootRect.y;
  const surfaceRect = getConnectedTabSurfaceBaseRect(primaryGroup.rect, captureRect, topSurfaceRect);
  const snapshotSurfaceRect = offsetDOMRect(surfaceRect, offsetX, offsetY);

  normalizeConnectedTabSurfaceSnapshots(rootSnapshot, snapshotSurfaceRect);

  if (secondaryGroup && secondaryTabs.length > 0) {
    const pruneIds = new Set([generateNodeId(secondaryGroup.tabList)]);
    pruneIds.delete(rootSnapshot.id);
    pruneSnapshotsByIds(rootSnapshot, pruneIds);
  }

  const band = hasExistingConnectedTabSurfaceSnapshot(rootSnapshot, snapshotSurfaceRect)
    ? null
    : createConnectedTabSurfaceBackground(surfaceRect, secondaryTabs);
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

function findPrimaryContentTabGroup(rootElement: Element, captureRect: DOMRect): StructuralTabGroup | null {
  const candidates = Array.from(rootElement.querySelectorAll('[role="tablist"]'));
  let best: StructuralTabGroup | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const group = getStructuralTabGroup(candidate);
    if (!group || !isPrimaryContentTabGroup(group)) continue;
    if (!isRectNearCaptureRect(group.rect, captureRect)) continue;

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
  if (!isElementTopVisibleAtCenter(tab, rect)) return false;

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

function getConnectedTabSurfaceBaseRect(
  mainTabRect: DOMRect,
  rootRect: DOMRect,
  topSurfaceRect: DOMRect | null,
): DOMRect {
  const rootRight = rootRect.right;
  const rootBottom = rootRect.bottom;
  const left = Math.max(rootRect.left, topSurfaceRect ? topSurfaceRect.left : mainTabRect.left - 16);
  const right = Math.min(rootRight, topSurfaceRect ? topSurfaceRect.right : mainTabRect.right + 16);
  const top = Math.max(rootRect.top, topSurfaceRect ? topSurfaceRect.top : mainTabRect.top - 8);
  const bottom = topSurfaceRect ? rootBottom : mainTabRect.bottom + 88;

  return new DOMRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
}

function offsetDOMRect(rect: DOMRect, dx: number, dy: number): DOMRect {
  return new DOMRect(rect.x + dx, rect.y + dy, rect.width, rect.height);
}

function createConnectedTabSurfaceBackground(
  baseRect: DOMRect,
  overlays: ElementSnapshot[],
): ElementSnapshot | null {
  if (baseRect.width <= 0 || baseRect.height <= 0) return null;

  let bottom = baseRect.bottom;

  for (const overlay of overlays) {
    bottom = Math.max(bottom, overlay.rect.y + overlay.rect.height + 8);
  }

  const height = Math.max(1, bottom - baseRect.top);
  const rect = new DOMRect(baseRect.left, baseRect.top, baseRect.width, height);
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

function normalizeConnectedTabSurfaceSnapshots(rootSnapshot: ElementSnapshot, surfaceRect: DOMRect): void {
  for (const child of rootSnapshot.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    if (isConnectedTabSurfaceSnapshotCandidate(child, surfaceRect)) {
      child.styles.backgroundColor = "rgb(255, 255, 255)";
      delete child.styles.backgroundImage;
    }

    normalizeConnectedTabSurfaceSnapshots(child, surfaceRect);
  }
}

function hasExistingConnectedTabSurfaceSnapshot(rootSnapshot: ElementSnapshot, surfaceRect: DOMRect): boolean {
  for (const child of rootSnapshot.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;
    if (isExistingConnectedTabSurfaceSnapshot(child, surfaceRect)) return true;
    if (hasExistingConnectedTabSurfaceSnapshot(child, surfaceRect)) return true;
  }

  return false;
}

function isExistingConnectedTabSurfaceSnapshot(node: ElementSnapshot, surfaceRect: DOMRect): boolean {
  if (node.attributes["data-h2d-connected-tab-surface"] === "true") return false;

  const rect = node.rect;
  if (rect.width < surfaceRect.width - 8) return false;
  if (rect.x > surfaceRect.x + 4) return false;
  if (rect.x + rect.width < surfaceRect.x + surfaceRect.width - 4) return false;
  if (rect.y > surfaceRect.y + 4) return false;
  if (rect.y + rect.height < surfaceRect.y + surfaceRect.height - 32) return false;

  return isNearWhitePaint(node.styles.backgroundColor || "") ||
    isWhiteDominantLinearGradient(node.styles.backgroundImage || "");
}

function isConnectedTabSurfaceSnapshotCandidate(node: ElementSnapshot, surfaceRect: DOMRect): boolean {
  if (node.attributes["data-h2d-connected-tab-surface"] === "true") return false;
  if (!isWhiteDominantLinearGradient(node.styles.backgroundImage || "")) return false;

  const rect = node.rect;
  if (rect.width < surfaceRect.width - 4 || rect.width > surfaceRect.width + 96) return false;
  if (Math.abs(rect.x - surfaceRect.x) > 20) return false;
  if (rect.y > surfaceRect.y + 20) return false;

  const rectBottom = rect.y + rect.height;
  const surfaceBottom = surfaceRect.y + surfaceRect.height;
  return rectBottom >= surfaceRect.y + surfaceRect.height * 0.7 || rectBottom >= surfaceBottom - 48;
}

function isWhiteDominantLinearGradient(backgroundImage: string): boolean {
  if (!/linear-gradient/i.test(backgroundImage)) return false;
  return /rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(?:1|1\.0+)\s*\)|#fff(?:fff)?\b|\bwhite\b/i.test(backgroundImage);
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

function removeGeneratedToolbarActionOverlays(rootSnapshot: ElementSnapshot): void {
  rootSnapshot.childNodes = rootSnapshot.childNodes.filter((child) => {
    if (!isElementNodeSnapshot(child)) return true;
    if (child.attributes["data-h2d-toolbar-action"]) return false;

    removeGeneratedToolbarActionOverlays(child);
    return true;
  });
}

function createCompactToolbarActionOverlayForAction(action: CompactToolbarAction): ElementSnapshot | null {
  if (!action.rect || !action.textRect) {
    return createCompactToolbarActionOverlay(action.element, action.displayText);
  }

  return createCompactToolbarActionOverlayFromRects(action);
}

function createCompactToolbarActionOverlayFromRects(action: CompactToolbarAction): ElementSnapshot | null {
  if (!action.rect || !action.textRect) return null;

  const styleSource = action.styleElement ?? action.element;
  const computed = getComputedStyleFor(styleSource);
  const surfaceComputed = action.surfaceElement ? getComputedStyleFor(action.surfaceElement) : null;
  const fontSize = parsePx(computed.fontSize, 12);
  const lineHeight = parseLineHeight(computed.lineHeight, fontSize);
  const textRect = action.textRect;
  const rect = action.rect;

  const childNodes: SnapshotNode[] = [{
    nodeType: NODE_TYPES.TEXT_NODE,
    id: generateNodeId(null),
    text: action.displayText,
    rect: {
      x: textRect.x,
      y: textRect.y,
      width: Math.max(textRect.width, estimateTextWidth(action.displayText, fontSize)),
      height: textRect.height,
    },
    lineCount: 1,
  }];

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
  if (surfaceComputed) {
    copyCompactToolbarActionSurfaceStyles(surfaceComputed, styles);
  }

  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: generateNodeId(null),
    tag: "DIV",
    attributes: { "data-h2d-toolbar-action": "true" },
    styles,
    rect: toElementRect(rect),
    childNodes,
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function createCompactToolbarActionOverlay(source: Element, text: string): ElementSnapshot | null {
  const computed = getComputedStyleFor(source);
  const sourceRect = source.getBoundingClientRect();
  const surface = findCompactToolbarActionSurfaceElement(source, sourceRect);
  const surfaceRect = surface?.getBoundingClientRect() ?? null;
  const surfaceComputed = surface ? getComputedStyleFor(surface) : null;
  const svg = findToolbarActionSvg(source);
  const textRect = getElementTextRangeRect(source) ?? getFallbackTextRect(sourceRect, computed, text);
  if (textRect.width <= 0 || textRect.height <= 0) return null;

  const svgRect = svg?.getBoundingClientRect() ?? null;
  const fontSize = parsePx(computed.fontSize, 12);
  const lineHeight = parseLineHeight(computed.lineHeight, fontSize);
  const baseRect = surfaceRect ?? sourceRect;
  const left = Math.min(baseRect.left, sourceRect.left, textRect.x, svgRect?.left ?? sourceRect.left);
  const top = Math.min(baseRect.top, sourceRect.top, textRect.y, svgRect?.top ?? sourceRect.top);
  const right = Math.max(baseRect.right, sourceRect.right, textRect.x + textRect.width, svgRect?.right ?? sourceRect.right);
  const bottom = Math.max(baseRect.bottom, sourceRect.bottom, textRect.y + textRect.height, svgRect?.bottom ?? sourceRect.bottom);
  const rect = new DOMRect(left, top, Math.max(1, right - left), Math.max(sourceRect.height, bottom - top));
  const childNodes: SnapshotNode[] = [];

  if (svg && svgRect && svgRect.width > 0 && svgRect.height > 0) {
    const svgColor = getComputedStyleFor(svg).color || computed.color;
    childNodes.push({
      nodeType: NODE_TYPES.ELEMENT_NODE,
      id: generateNodeId(null),
      tag: "SVG",
      attributes: { "data-h2d-toolbar-icon": "true" },
      styles: {
        display: "block",
        position: "absolute",
        left: `${roundPx(svgRect.left - rect.left)}px`,
        top: `${roundPx(svgRect.top - rect.top)}px`,
        width: `${roundPx(svgRect.width)}px`,
        height: `${roundPx(svgRect.height)}px`,
        color: svgColor,
        overflow: "visible",
        boxSizing: "border-box",
      },
      rect: toElementRect(svgRect),
      childNodes: [],
      content: serializeToolbarActionSvg(svg, svgColor),
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
  if (surfaceComputed) {
    copyCompactToolbarActionSurfaceStyles(surfaceComputed, styles);
  }

  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: generateNodeId(null),
    tag: "DIV",
    attributes: { "data-h2d-toolbar-action": "true" },
    styles,
    rect: toElementRect(rect),
    childNodes,
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function findCompactToolbarActionSurfaceElement(source: Element, sourceRect: DOMRect): Element | null {
  let best: { element: Element; area: number } | null = null;
  const candidates: Element[] = [source, ...Array.from(source.querySelectorAll("*"))];

  let ancestor = source.parentElement;
  for (let depth = 0; ancestor && depth < 3; depth += 1) {
    candidates.push(ancestor);
    ancestor = ancestor.parentElement;
  }

  for (const candidate of candidates) {
    if (!isElementVisibleInDocument(candidate)) continue;
    if (!isCompactToolbarActionSurfaceElement(candidate, sourceRect)) continue;

    const rect = candidate.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (!best || area < best.area) {
      best = { element: candidate, area };
    }
  }

  return best?.element ?? null;
}

function isCompactToolbarActionSurfaceElement(element: Element, sourceRect: DOMRect): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < Math.max(24, sourceRect.width * 0.65)) return false;
  if (rect.height < Math.max(18, sourceRect.height * 0.65)) return false;
  if (rect.width > Math.max(sourceRect.width + 96, sourceRect.width * 3)) return false;
  if (rect.height > Math.max(sourceRect.height + 24, sourceRect.height * 2.2)) return false;
  if (rect.left > sourceRect.left + 4 || rect.right < sourceRect.right - 4) return false;
  if (rect.top > sourceRect.top + 4 || rect.bottom < sourceRect.bottom - 4) return false;

  const computed = getComputedStyleFor(element);
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;

  const hasBackground =
    isVisiblePaint(computed.backgroundColor) ||
    Boolean(computed.backgroundImage && computed.backgroundImage !== "none");
  const hasBorder = hasVisibleBorderStyles(computed);
  const hasShadow = Boolean(computed.boxShadow && computed.boxShadow !== "none");
  const hasRadius = hasRoundedCorners(computed, 1);

  return (hasBackground || hasBorder || hasShadow) && (hasRadius || hasBorder || hasShadow);
}

function copyCompactToolbarActionSurfaceStyles(
  computed: CSSStyleDeclaration,
  styles: Record<string, string>,
): void {
  if (isVisiblePaint(computed.backgroundColor)) {
    styles.backgroundColor = computed.backgroundColor;
  }
  if (computed.backgroundImage && computed.backgroundImage !== "none") {
    styles.backgroundImage = computed.backgroundImage;
  }
  if (computed.boxShadow && computed.boxShadow !== "none") {
    styles.boxShadow = computed.boxShadow;
  }

  for (const corner of ["TopLeft", "TopRight", "BottomRight", "BottomLeft"] as const) {
    const value = computed[`border${corner}Radius` as keyof CSSStyleDeclaration] as string;
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

function serializeToolbarActionSvg(svg: SVGElement, color: string): string {
  let content = new XMLSerializer().serializeToString(svg);
  if (!/\sxmlns=/.test(content)) {
    content = content.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (/currentColor/i.test(content) && isVisiblePaint(color)) {
    content = content.replace(/currentColor/gi, escapeSvgAttribute(color));
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

function isElementTopVisibleAtCenter(element: Element, rect = element.getBoundingClientRect()): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;

  const doc = getNodeDocument(element);
  const view = getNodeWindow(element);
  const x = Math.max(0, Math.min(view.innerWidth - 1, rect.left + rect.width / 2));
  const y = Math.max(0, Math.min(view.innerHeight - 1, rect.top + rect.height / 2));
  if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return false;

  const hits = typeof doc.elementsFromPoint === "function"
    ? doc.elementsFromPoint(x, y)
    : [doc.elementFromPoint(x, y)].filter((hit): hit is Element => Boolean(hit));
  const hit = hits.find((candidate) => !isTransparentHitTestOverlay(candidate));
  if (!hit) return false;
  return hit === element || element.contains(hit);
}

function isTransparentHitTestOverlay(element: Element): boolean {
  const identity = getElementIdentity(element);
  if (/watermark/i.test(identity)) return true;
  if (element.getAttribute("data-name") === "__beisen_watermark__") return true;

  const computed = getComputedStyleFor(element);
  return computed.pointerEvents === "none";
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

function extendFullPageFixedBackgrounds(rootSnapshot: ElementSnapshot, viewportHeight: number): void {
  extendFullPageFixedBackgroundsInner(rootSnapshot, rootSnapshot.rect, viewportHeight);
}

function extendFullPageFixedBackgroundsInner(
  node: ElementSnapshot,
  pageRect: ElementRect,
  viewportHeight: number,
): void {
  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    if (isFullPageFixedBackgroundSnapshot(child, pageRect, viewportHeight)) {
      const oldRect = { ...child.rect };
      anchorSnapshotToParent(child, pageRect);
      child.rect.x = pageRect.x;
      child.rect.y = pageRect.y;
      child.rect.width = pageRect.width;
      child.rect.height = pageRect.height;
      child.rect.cssWidth = Math.round(child.rect.width);
      child.rect.cssHeight = Math.round(child.rect.height);
      child.styles.left = "0px";
      child.styles.top = "0px";
      child.styles.width = `${roundPx(child.rect.width)}px`;
      child.styles.height = `${roundPx(child.rect.height)}px`;
      child.styles.minHeight = `${roundPx(child.rect.height)}px`;
      child.styles.overflow = "hidden";
      child.styles.overflowX = "hidden";
      child.styles.overflowY = "hidden";
      rebaseBottomAnchoredDescendants(child, oldRect, child.rect);
    }

    extendFullPageFixedBackgroundsInner(child, pageRect, viewportHeight);
  }
}

function isFullPageFixedBackgroundSnapshot(
  node: ElementSnapshot,
  pageRect: ElementRect,
  viewportHeight: number,
): boolean {
  if (node.styles.position !== "fixed") return false;
  if (node.rect.x > pageRect.x + 2 || node.rect.y > pageRect.y + 2) return false;
  if (node.rect.width < pageRect.width * 0.75) return false;
  if (node.rect.height < viewportHeight * 0.5) return false;
  if (!hasSnapshotBackgroundPaint(node.styles)) return false;

  const zIndex = parseInt(node.styles.zIndex || "", 10);
  if (Number.isFinite(zIndex) && zIndex > 2) return false;

  const identity = `${node.tag} ${node.attributes.id || ""} ${node.attributes.class || ""}`;
  return /(^|[-_\s])(bg|background|layout-bg|page-bg|root-bg)([-_\s]|$)/i.test(identity) ||
    node.rect.width >= pageRect.width - 2;
}

function hasSnapshotBackgroundPaint(styles: Record<string, string>): boolean {
  if (styles.backgroundImage && styles.backgroundImage !== "none") return true;
  return Boolean(styles.backgroundColor && isVisiblePaint(styles.backgroundColor));
}

function rebaseBottomAnchoredDescendants(
  node: ElementSnapshot,
  oldParentRect: ElementRect,
  newParentRect: ElementRect,
): void {
  const oldBottom = oldParentRect.y + oldParentRect.height;
  const newBottom = newParentRect.y + newParentRect.height;
  const deltaY = newBottom - oldBottom;
  if (Math.abs(deltaY) <= 0.5) return;

  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    if (isBottomAnchoredSnapshot(child)) {
      offsetSnapshotNode(child, 0, deltaY);
      child.styles.top = `${roundPx(child.rect.y - newParentRect.y)}px`;
      continue;
    }

    rebaseBottomAnchoredDescendants(child, oldParentRect, newParentRect);
  }
}

function isBottomAnchoredSnapshot(node: ElementSnapshot): boolean {
  const position = node.styles.position || "";
  if (position !== "absolute" && position !== "fixed") return false;

  const bottom = parsePx(node.styles.bottom || "", NaN);
  return Number.isFinite(bottom);
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

    anchorFullPageSidebarSnapshot(candidate, snapshot, rootSnapshot);
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

  const computed = getComputedStyleFor(element);
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;

  const identity = getElementIdentity(element);
  const looksLikeSidebar = /(^|[-_\s])(aside|sidebar|side-bar|sider|layout-sider|side-menu|el-menu|ant-menu|nav|menu)([-_\s]|$)/i.test(identity);
  const pinnedToViewport = computed.position === "fixed" || computed.position === "sticky";
  const fillsViewport = rect.height >= view.innerHeight * 0.85;
  if (!looksLikeSidebar && !pinnedToViewport && !fillsViewport) return false;
  if (!hasExtendableSidebarPaint(computed) && !(looksLikeSidebar && hasSidebarSurfacePaint(computed))) return false;

  if (snapshot.rect.x > rootSnapshot.rect.x + 8) return false;
  const allowedTopOffset = (looksLikeSidebar || pinnedToViewport || fillsViewport)
    ? Math.max(32, Math.min(96, view.innerHeight * 0.18))
    : 32;
  if (snapshot.rect.y > rootSnapshot.rect.y + allowedTopOffset) return false;

  return true;
}

function anchorFullPageSidebarSnapshot(
  element: Element,
  snapshot: ElementSnapshot,
  rootSnapshot: ElementSnapshot,
): void {
  const view = getNodeWindow(element);
  if (rootSnapshot.rect.height <= view.innerHeight + 4) return;

  const computed = getComputedStyleFor(element);
  const identity = getElementIdentity(element);
  const shouldAnchor = computed.position === "fixed" ||
    computed.position === "sticky" ||
    /(^|[-_\s])(aside|sidebar|side-bar|sider|layout-sider|side-menu|el-menu|ant-menu|nav|menu)([-_\s]|$)/i.test(identity);
  if (!shouldAnchor) return;

  anchorSnapshotToParent(snapshot, rootSnapshot.rect);
}

function hasExtendableSidebarPaint(computed: CSSStyleDeclaration): boolean {
  if (computed.backgroundImage && computed.backgroundImage !== "none") return true;
  if (!isVisiblePaint(computed.backgroundColor)) return false;
  return !isNearWhitePaint(computed.backgroundColor);
}

function hasSidebarSurfacePaint(computed: CSSStyleDeclaration): boolean {
  if (computed.backgroundImage && computed.backgroundImage !== "none") return true;
  if (isVisiblePaint(computed.backgroundColor)) return true;
  return hasVisibleBorderStyles(computed);
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
  return normalizeCssColorFunctions(value).match(/rgba?\([^)]+\)/)?.[0];
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

function stabilizeMeasuredInlineTextGroup(
  element: Element,
  styles: Record<string, string>,
  rect: ElementRect,
  childNodes: SnapshotNode[],
): boolean {
  if (rect.width < 24 || rect.width > 640 || rect.height < 8 || rect.height > 80) return false;
  if (childNodes.length < 2 || childNodes.length > 4) return false;

  const computed = getComputedStyleFor(element);
  const display = styles.display || computed.display;
  if (display !== "flex" && display !== "inline-flex") return false;

  const flexDirection = styles.flexDirection || computed.flexDirection || "row";
  if (!flexDirection.startsWith("row")) return false;

  const flexWrap = styles.flexWrap || computed.flexWrap || "nowrap";
  if (flexWrap === "nowrap") return false;

  const textChildren = childNodes.filter(isCompactTextGroupSnapshot);
  if (textChildren.length !== childNodes.length) return false;

  const fontSizes = textChildren
    .map((child) => getSnapshotMaxFontSize(child))
    .filter((fontSize) => Number.isFinite(fontSize) && fontSize > 0);
  if (fontSizes.length < 2) return false;

  const minFontSize = Math.min(...fontSizes);
  const maxFontSize = Math.max(...fontSizes);
  const fontSizeDelta = maxFontSize - minFontSize;
  if (fontSizeDelta < 6) return false;

  const measuredColumnGap = getMeasuredInlineColumnGap(textChildren);
  const largeTextWidthAllowance = Math.min(12, Math.max(6, fontSizeDelta * 0.45));
  const safeColumnGap = Math.max(
    measuredColumnGap,
    parsePx(styles.columnGap || computed.columnGap || "", 0),
    Math.min(14, Math.max(10, fontSizeDelta * 0.7)),
  );
  const followingTextShift = Math.max(0, safeColumnGap - measuredColumnGap) + largeTextWidthAllowance;

  styles.width = `${roundPx(rect.width)}px`;
  styles.height = `${roundPx(rect.height)}px`;
  styles.flexShrink = "0";
  styles.columnGap = `${roundPx(safeColumnGap)}px`;
  styles.gap = `${roundPx(safeColumnGap)}px`;

  let seenLargeText = false;
  for (const child of textChildren) {
    if (!isElementNodeSnapshot(child)) continue;
    const fontSize = getSnapshotMaxFontSize(child);
    const isLargeText = Number.isFinite(fontSize) && fontSize === maxFontSize;
    const widthAllowance = isLargeText
      ? largeTextWidthAllowance
      : 0;
    if (!isLargeText && seenLargeText && Number.isFinite(fontSize) && fontSize < maxFontSize && followingTextShift > 0) {
      offsetSnapshotNode(child, followingTextShift, 0);
    }
    if (isLargeText) {
      seenLargeText = true;
    }
    child.styles.width = `${roundPx(child.rect.width + widthAllowance)}px`;
    child.styles.height = `${roundPx(child.rect.height)}px`;
    child.styles.flexShrink = "0";
    child.layoutSizingHorizontal = "FIXED";
    child.layoutSizingVertical = "FIXED";
  }

  return true;
}

function getMeasuredInlineColumnGap(nodes: SnapshotNode[]): number {
  let maxGap = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1];
    const current = nodes[index];
    const previousRight = previous.rect.x + previous.rect.width;
    const gap = current.rect.x - previousRight;
    if (Number.isFinite(gap) && gap > maxGap) {
      maxGap = gap;
    }
  }
  return maxGap;
}

function isCompactTextGroupSnapshot(node: SnapshotNode): boolean {
  if (node.nodeType === NODE_TYPES.TEXT_NODE) {
    return Boolean(node.text.trim()) && node.rect.width > 0 && node.rect.height > 0;
  }
  if (!isElementNodeSnapshot(node)) return false;
  if (node.rect.width <= 0 || node.rect.height <= 0) return false;
  if (node.tag === "SVG" || node.tag === "IMG" || node.tag === "CANVAS" || node.tag === "VIDEO") return false;
  return Boolean(getSnapshotText(node));
}

function getSnapshotMaxFontSize(node: SnapshotNode): number {
  if (!isElementNodeSnapshot(node)) return NaN;

  let maxFontSize = parsePx(node.styles.fontSize || "", NaN);
  for (const child of node.childNodes) {
    const childFontSize = getSnapshotMaxFontSize(child);
    if (Number.isFinite(childFontSize)) {
      maxFontSize = Number.isFinite(maxFontSize)
        ? Math.max(maxFontSize, childFontSize)
        : childFontSize;
    }
  }

  return maxFontSize;
}

function isTableMeasurementSnapshot(
  element: Element,
  rect: ElementRect,
  childNodes: SnapshotNode[],
): boolean {
  if (rect.height > 0.5) return false;
  if (!hasSnapshotText(childNodes)) return false;
  if (!element.closest(".ant-table, [class*=\"ant-table\"]")) return false;

  const tag = element.tagName.toUpperCase();
  if (tag === "TR" && element.getAttribute("aria-hidden") === "true") return true;
  if ((tag === "TD" || tag === "TH") && element.closest("tr[aria-hidden=\"true\"]")) return true;

  const identity = getElementIdentity(element);
  if (/(^|[-_\s])(measure|measurement|measure-row|measure-cell|resize-observer)([-_\s]|$)/i.test(identity)) {
    return true;
  }

  if (element.closest(".ant-table-measure-row, .ant-table-measure-cell, [class*=\"measure-row\"], [class*=\"measure-cell\"]")) {
    return true;
  }

  return false;
}

function hasSnapshotText(childNodes: SnapshotNode[]): boolean {
  return childNodes.some((child) => getSnapshotText(child).length > 0);
}

// ---------------------------------------------------------------------------
// Pseudo-element materialization
// ---------------------------------------------------------------------------

function absorbFullCoverBackgroundPseudos(
  element: Element,
  styles: Record<string, string>,
): Set<"::before" | "::after"> {
  const absorbed = new Set<"::before" | "::after">();
  if (hasHostBackgroundPaint(styles)) return absorbed;

  for (const pseudo of ["::before", "::after"] as const) {
    const computed = getComputedStyleFor(element, pseudo);
    if (!isFullCoverBackgroundPseudo(element, pseudo, computed)) continue;

    copyFullCoverPseudoBackgroundStyles(computed, styles);
    absorbed.add(pseudo);
  }

  return absorbed;
}

function hasHostBackgroundPaint(styles: Record<string, string>): boolean {
  return (
    isVisiblePaint(styles.backgroundColor || "") ||
    Boolean(styles.backgroundImage && styles.backgroundImage !== "none")
  );
}

function isFullCoverBackgroundPseudo(
  element: Element,
  pseudo: "::before" | "::after",
  computed: CSSStyleDeclaration,
): boolean {
  if (computed.display === "none" || computed.visibility === "hidden") return false;
  if (parseFloat(computed.opacity || "1") <= 0.01) return false;
  if (computed.position !== "absolute" && computed.position !== "fixed") return false;
  if (computed.transform && computed.transform !== "none") return false;

  const zIndex = parseFloat(computed.zIndex || "");
  if (!Number.isFinite(zIndex) || zIndex >= 0) return false;

  const text = parseCssTextContent(computed.content);
  if (text && text.trim()) return false;
  if (!hasPseudoBackgroundPaint(computed)) return false;

  const hostRect = element.getBoundingClientRect();
  if (hostRect.width <= 0 || hostRect.height <= 0) return false;

  const width = parsePx(computed.width, NaN);
  const height = parsePx(computed.height, NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;

  const pseudoRect = computePaintPseudoRect(pseudo, hostRect, computed, width, height);
  return rectApproximatelyCovers(pseudoRect, hostRect, 1.5);
}

function hasPseudoBackgroundPaint(computed: CSSStyleDeclaration): boolean {
  return (
    isVisiblePaint(computed.backgroundColor) ||
    Boolean(computed.backgroundImage && computed.backgroundImage !== "none") ||
    hasVisibleBorderStyles(computed)
  );
}

function rectApproximatelyCovers(inner: DOMRect, outer: DOMRect, tolerance: number): boolean {
  return (
    Math.abs(inner.x - outer.x) <= tolerance &&
    Math.abs(inner.y - outer.y) <= tolerance &&
    Math.abs(inner.width - outer.width) <= tolerance &&
    Math.abs(inner.height - outer.height) <= tolerance
  );
}

function copyFullCoverPseudoBackgroundStyles(
  computed: CSSStyleDeclaration,
  styles: Record<string, string>,
): void {
  if (isVisiblePaint(computed.backgroundColor)) {
    styles.backgroundColor = normalizeCssColorFunctions(computed.backgroundColor);
  }

  if (computed.backgroundImage && computed.backgroundImage !== "none") {
    styles.backgroundImage = normalizeCssColorFunctions(computed.backgroundImage);
    copyComputedStyleIfPresent(computed, styles, "backgroundSize");
    copyComputedStyleIfPresent(computed, styles, "backgroundPosition");
    copyComputedStyleIfPresent(computed, styles, "backgroundPositionX");
    copyComputedStyleIfPresent(computed, styles, "backgroundPositionY");
    copyComputedStyleIfPresent(computed, styles, "backgroundRepeat");
    copyComputedStyleIfPresent(computed, styles, "backgroundOrigin");
    copyComputedStyleIfPresent(computed, styles, "backgroundClip");
    copyComputedStyleIfPresent(computed, styles, "backgroundBlendMode");
  }

  copyPaintPseudoBorderStyles(computed, styles);
  copyPaintPseudoRadiusStyles(computed, styles);
}

function copyComputedStyleIfPresent(
  computed: CSSStyleDeclaration,
  styles: Record<string, string>,
  key: keyof CSSStyleDeclaration,
): void {
  const value = computed[key] as string;
  if (value && value !== "normal" && value !== "initial") {
    styles[key as string] = normalizeCssColorFunctions(value);
  }
}

function materializePseudoElements(
  element: Element,
  childNodes: SnapshotNode[],
  ignoredPseudos: Set<"::before" | "::after"> = new Set(),
): Set<string> {
  const materialized = new Set<string>();

  for (const pseudo of ["::before", "::after"] as const) {
    if (ignoredPseudos.has(pseudo)) continue;
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
  if (!isPaintPseudoCandidate(element, before, "::before") || !isPaintPseudoCandidate(element, after, "::after")) return null;
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
  const borderTriangle = snapshotCssBorderTrianglePseudo(element, pseudo, computed);
  if (borderTriangle) return borderTriangle;

  const clippedCornerMarker = snapshotClippedCornerMarkerPseudo(element, pseudo, computed);
  if (clippedCornerMarker) return clippedCornerMarker;

  if (!isPaintPseudoCandidate(element, computed, pseudo)) return null;

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

type BorderSide = "Top" | "Right" | "Bottom" | "Left";
type CornerPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

interface CssBorderTriangle {
  side: BorderSide;
  color: string;
  borderTop: number;
  borderRight: number;
  borderBottom: number;
  borderLeft: number;
}

function materializeLinearGradientCornerMarker(
  element: Element,
  styles: Record<string, string>,
  childNodes: SnapshotNode[],
): void {
  const marker = getLinearGradientCornerMarkerInfo(element, styles);
  if (!marker) return;

  const rect = element.getBoundingClientRect();
  childNodes.unshift(createCornerMarkerSnapshot(rect, marker.corner, marker.color, generateNodeId(null), {
    "data-h2d-css-gradient-corner": marker.corner,
  }));

  clearBackgroundImageStyles(styles);
}

function getLinearGradientCornerMarkerInfo(
  element: Element,
  styles: Record<string, string>,
): { corner: CornerPosition; color: string } | null {
  const backgroundImage = styles.backgroundImage || getComputedStyleFor(element).backgroundImage;
  if (!backgroundImage || !/^linear-gradient\(/i.test(backgroundImage.trim())) return null;
  if (hasDirectVisibleText(element) || hasVisibleTextDescendant(element)) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4 || rect.width > 48 || rect.height > 48) return null;

  const angle = getLinearGradientAngle(backgroundImage);
  if (angle == null) return null;
  if (!/50(?:\.0+)?%/.test(backgroundImage)) return null;

  const stops = getLinearGradientColorStops(backgroundImage);
  const transparentIndex = stops.findIndex((color) => !isVisibleGradientColor(color));
  const visibleIndex = stops.findIndex((color) => isVisibleGradientColor(color));
  if (transparentIndex < 0 || visibleIndex < 0 || transparentIndex === visibleIndex) return null;

  return {
    corner: getGradientCornerPosition(angle, visibleIndex > transparentIndex),
    color: stops[visibleIndex],
  };
}

function getLinearGradientAngle(backgroundImage: string): number | null {
  const angleMatch = backgroundImage.match(/^linear-gradient\(\s*(-?\d+(?:\.\d+)?)deg\s*,/i);
  if (angleMatch) {
    return normalizeAngle(Number(angleMatch[1]));
  }

  const directionMatch = backgroundImage.match(/^linear-gradient\(\s*to\s+(top|bottom)(?:\s+(left|right))?\s*,/i) ||
    backgroundImage.match(/^linear-gradient\(\s*to\s+(left|right)(?:\s+(top|bottom))?\s*,/i);
  if (!directionMatch) return null;

  const direction = directionMatch[0].toLowerCase();
  if (direction.includes("top") && direction.includes("left")) return 315;
  if (direction.includes("top") && direction.includes("right")) return 45;
  if (direction.includes("bottom") && direction.includes("left")) return 225;
  if (direction.includes("bottom") && direction.includes("right")) return 135;
  if (direction.includes("top")) return 0;
  if (direction.includes("right")) return 90;
  if (direction.includes("bottom")) return 180;
  if (direction.includes("left")) return 270;
  return null;
}

function getLinearGradientColorStops(backgroundImage: string): string[] {
  const matches = backgroundImage.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}\b|transparent\b/gi);
  return matches ?? [];
}

function isVisibleGradientColor(color: string): boolean {
  if (!isVisiblePaint(color)) return false;
  const rgbaMatch = color.match(/^rgba\((.+)\)$/i);
  if (!rgbaMatch) return true;

  const parts = rgbaMatch[1].split(",").map((part) => part.trim());
  const alpha = Number(parts[3]);
  return !Number.isFinite(alpha) || alpha > 0;
}

function getGradientCornerPosition(angle: number, visibleAfterMidpoint: boolean): CornerPosition {
  const radians = normalizeAngle(angle) * Math.PI / 180;
  const directionX = Math.sin(radians);
  const directionY = -Math.cos(radians);
  const x = visibleAfterMidpoint ? directionX : -directionX;
  const y = visibleAfterMidpoint ? directionY : -directionY;

  if (x <= 0 && y <= 0) return "top-left";
  if (x > 0 && y <= 0) return "top-right";
  if (x <= 0 && y > 0) return "bottom-left";
  return "bottom-right";
}

function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

function clearBackgroundImageStyles(styles: Record<string, string>): void {
  delete styles.backgroundImage;
  delete styles.backgroundAttachment;
  delete styles.backgroundBlendMode;
  delete styles.backgroundClip;
  delete styles.backgroundOrigin;
  delete styles.backgroundPositionX;
  delete styles.backgroundPositionY;
  delete styles.backgroundRepeat;
  delete styles.backgroundSize;
}

function snapshotClippedCornerMarkerElement(element: Element): ElementSnapshot | null {
  const parent = element.parentElement;
  if (!parent) return null;

  const computed = getComputedStyleFor(element);
  const marker = getClippedCornerMarkerInfo(computed);
  if (!marker) return null;
  if (!isElementVisuallyEmpty(element)) return null;

  const parentComputed = getComputedStyleFor(parent);
  if (!isClippingOverflow(parentComputed)) return null;

  const rect = element.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const corner = getCornerPosition(rect, parentRect);
  if (!corner) return null;

  const visibleRect = intersectDOMRects(rect, parentRect);
  if (!visibleRect || !isReasonableCornerMarkerRect(visibleRect)) return null;

  return createCornerMarkerSnapshot(visibleRect, corner, marker.color, generateNodeId(element));
}

function snapshotClippedCornerMarkerPseudo(
  element: Element,
  pseudo: "::before" | "::after",
  computed: CSSStyleDeclaration,
): ElementSnapshot | null {
  const marker = getClippedCornerMarkerInfo(computed);
  if (!marker) return null;

  const hostComputed = getComputedStyleFor(element);
  if (!isClippingOverflow(hostComputed)) return null;

  const width = parsePx(computed.width, NaN);
  const height = parsePx(computed.height, NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0 || width > 40 || height > 40) return null;

  const hostRect = element.getBoundingClientRect();
  if (hostRect.width <= 0 || hostRect.height <= 0) return null;

  const rect = computePaintPseudoRect(pseudo, hostRect, computed, width, height);
  const corner = getCornerPosition(rect, hostRect);
  if (!corner) return null;

  const visibleRect = intersectDOMRects(rect, hostRect);
  if (!visibleRect || !isReasonableCornerMarkerRect(visibleRect)) return null;

  return createCornerMarkerSnapshot(visibleRect, corner, marker.color, generateNodeId(null), {
    "data-h2d-pseudo": pseudo === "::before" ? "before" : "after",
  });
}

function getClippedCornerMarkerInfo(computed: CSSStyleDeclaration): { color: string } | null {
  if (!isVisiblePaint(computed.backgroundColor)) return null;

  const width = parsePx(computed.width, NaN);
  const height = parsePx(computed.height, NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 6 || height < 6 || width > 40 || height > 40) return null;
  if (Math.abs(width - height) > Math.max(4, Math.min(width, height) * 0.25)) return null;

  if (!isApproximatelyDiagonalRotation(computed.transform)) return null;
  return { color: computed.backgroundColor };
}

function isElementVisuallyEmpty(element: Element): boolean {
  if (hasDirectVisibleText(element) || hasVisibleTextDescendant(element)) return false;
  return !Array.from(element.children).some((child) => isNodeVisible(child));
}

function isClippingOverflow(computed: CSSStyleDeclaration): boolean {
  return /^(hidden|clip)$/i.test(computed.overflow) ||
    /^(hidden|clip)$/i.test(computed.overflowX) ||
    /^(hidden|clip)$/i.test(computed.overflowY);
}

function isApproximatelyDiagonalRotation(transform: string): boolean {
  const angle = getTransformRotationAngle(transform);
  if (!Number.isFinite(angle)) return false;

  const normalized = ((Math.abs(angle) % 90) + 90) % 90;
  return Math.abs(normalized - 45) <= 8;
}

function getCornerPosition(rect: DOMRect, container: DOMRect): CornerPosition | null {
  const margin = 6;
  const nearLeft = rect.left <= container.left + margin;
  const nearRight = rect.right >= container.right - margin;
  const nearTop = rect.top <= container.top + margin;
  const nearBottom = rect.bottom >= container.bottom - margin;

  if (nearLeft && nearTop) return "top-left";
  if (nearRight && nearTop) return "top-right";
  if (nearLeft && nearBottom) return "bottom-left";
  if (nearRight && nearBottom) return "bottom-right";
  return null;
}

function isReasonableCornerMarkerRect(rect: DOMRect): boolean {
  return rect.width >= 4 && rect.height >= 4 && rect.width <= 36 && rect.height <= 36;
}

function createCornerMarkerSnapshot(
  rect: DOMRect,
  corner: CornerPosition,
  color: string,
  id: string,
  extraAttributes: Record<string, string> = {},
): ElementSnapshot {
  const fill = escapeSvgAttribute(color);
  const points = getCornerMarkerPoints(rect, corner)
    .map(([x, y]) => `${roundPx(x)},${roundPx(y)}`)
    .join(" ");

  return {
    nodeType: Node.ELEMENT_NODE as 1,
    id,
    tag: "SVG",
    attributes: {
      "data-h2d-corner-marker": corner,
      ...extraAttributes,
    },
    styles: {
      display: "block",
      position: "absolute",
      left: "0px",
      top: "0px",
      width: `${roundPx(rect.width)}px`,
      height: `${roundPx(rect.height)}px`,
      overflow: "visible",
      boxSizing: "border-box",
    },
    rect: toElementRect(rect),
    childNodes: [],
    content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${roundPx(rect.width)} ${roundPx(rect.height)}" preserveAspectRatio="none"><polygon points="${points}" fill="${fill}"/></svg>`,
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function getCornerMarkerPoints(rect: DOMRect, corner: CornerPosition): Array<[number, number]> {
  switch (corner) {
    case "top-left":
      return [[0, 0], [rect.width, 0], [0, rect.height]];
    case "top-right":
      return [[rect.width, 0], [rect.width, rect.height], [0, 0]];
    case "bottom-left":
      return [[0, rect.height], [0, 0], [rect.width, rect.height]];
    case "bottom-right":
      return [[rect.width, rect.height], [0, rect.height], [rect.width, 0]];
  }
}

function snapshotCssBorderTriangleElement(element: Element): ElementSnapshot | null {
  if (!isBorderTriangleElementCandidate(element)) return null;

  const computed = getComputedStyleFor(element);
  const triangle = getCssBorderTriangle(computed);
  if (!triangle) return null;

  const rect = element.getBoundingClientRect();
  if (!isReasonableBorderTriangleRect(rect)) return null;

  return createCssBorderTriangleSnapshot(rect, triangle, generateNodeId(element));
}

function snapshotCssBorderTrianglePseudo(
  element: Element,
  pseudo: "::before" | "::after",
  computed: CSSStyleDeclaration,
): ElementSnapshot | null {
  const triangle = getCssBorderTriangle(computed);
  if (!triangle) return null;

  const hostRect = element.getBoundingClientRect();
  if (hostRect.width <= 0 && hostRect.height <= 0) return null;

  const width = triangle.borderLeft + triangle.borderRight;
  const height = triangle.borderTop + triangle.borderBottom;
  if (width <= 0 || height <= 0 || width > 48 || height > 48) return null;

  const rect = computePaintPseudoRect(pseudo, hostRect, computed, width, height);
  if (!isReasonableBorderTriangleRect(rect)) return null;

  return createCssBorderTriangleSnapshot(rect, triangle, generateNodeId(null), {
    "data-h2d-pseudo": pseudo === "::before" ? "before" : "after",
  });
}

function isBorderTriangleElementCandidate(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  if (["INPUT", "TEXTAREA", "SELECT", "OPTION", "IMG", "CANVAS", "VIDEO", "SVG"].includes(tag)) return false;

  const computed = getComputedStyleFor(element);
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;

  const width = parsePx(computed.width, 0);
  const height = parsePx(computed.height, 0);
  if (width > 1 || height > 1) return false;

  if (hasDirectVisibleText(element) || hasVisibleTextDescendant(element)) return false;
  if (Array.from(element.children).some((child) => isNodeVisible(child))) return false;

  return true;
}

function getCssBorderTriangle(computed: CSSStyleDeclaration): CssBorderTriangle | null {
  const borders = {
    Top: getBorderSide(computed, "Top"),
    Right: getBorderSide(computed, "Right"),
    Bottom: getBorderSide(computed, "Bottom"),
    Left: getBorderSide(computed, "Left"),
  } as const;

  const visible = (Object.keys(borders) as BorderSide[]).filter((side) => borders[side].visible);
  if (visible.length !== 1) return null;

  const side = visible[0];
  const totalWidth = borders.Left.width + borders.Right.width;
  const totalHeight = borders.Top.width + borders.Bottom.width;
  if (totalWidth <= 0 || totalHeight <= 0) return null;

  const hasTransparentSupport = (Object.keys(borders) as BorderSide[]).some((borderSide) => (
    borderSide !== side &&
    borders[borderSide].width > 0 &&
    !borders[borderSide].visible
  ));
  if (!hasTransparentSupport) return null;

  return {
    side,
    color: borders[side].color,
    borderTop: borders.Top.width,
    borderRight: borders.Right.width,
    borderBottom: borders.Bottom.width,
    borderLeft: borders.Left.width,
  };
}

function getBorderSide(computed: CSSStyleDeclaration, side: BorderSide): { width: number; color: string; visible: boolean } {
  const width = parsePx(computed[`border${side}Width` as keyof CSSStyleDeclaration] as string, 0);
  const style = computed[`border${side}Style` as keyof CSSStyleDeclaration] as string;
  const color = computed[`border${side}Color` as keyof CSSStyleDeclaration] as string;
  return {
    width,
    color,
    visible: width > 0 && style !== "none" && style !== "hidden" && isVisiblePaint(color),
  };
}

function isReasonableBorderTriangleRect(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0 && rect.width <= 64 && rect.height <= 64;
}

function createCssBorderTriangleSnapshot(
  rect: DOMRect,
  triangle: CssBorderTriangle,
  id: string,
  extraAttributes: Record<string, string> = {},
): ElementSnapshot {
  const points = getCssBorderTrianglePoints(rect, triangle)
    .map(([x, y]) => `${roundPx(x)},${roundPx(y)}`)
    .join(" ");
  const fill = escapeSvgAttribute(triangle.color);
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);

  return {
    nodeType: Node.ELEMENT_NODE as 1,
    id,
    tag: "SVG",
    attributes: {
      "data-h2d-css-border-triangle": triangle.side.toLowerCase(),
      ...extraAttributes,
    },
    styles: {
      display: "block",
      position: "absolute",
      left: "0px",
      top: "0px",
      width: `${roundPx(width)}px`,
      height: `${roundPx(height)}px`,
      overflow: "visible",
      boxSizing: "border-box",
    },
    rect: toElementRect(new DOMRect(rect.x, rect.y, width, height)),
    childNodes: [],
    content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${roundPx(width)} ${roundPx(height)}" preserveAspectRatio="none"><polygon points="${points}" fill="${fill}"/></svg>`,
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function getCssBorderTrianglePoints(rect: DOMRect, triangle: CssBorderTriangle): Array<[number, number]> {
  const boxWidth = Math.max(1, triangle.borderLeft + triangle.borderRight);
  const boxHeight = Math.max(1, triangle.borderTop + triangle.borderBottom);
  const cx = clampNumber((triangle.borderLeft / boxWidth) * rect.width, 0, rect.width);
  const cy = clampNumber((triangle.borderTop / boxHeight) * rect.height, 0, rect.height);

  switch (triangle.side) {
    case "Top":
      return [[0, 0], [rect.width, 0], [cx, cy]];
    case "Right":
      return [[rect.width, 0], [rect.width, rect.height], [cx, cy]];
    case "Bottom":
      return [[rect.width, rect.height], [0, rect.height], [cx, cy]];
    case "Left":
      return [[0, rect.height], [0, 0], [cx, cy]];
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isPaintPseudoCandidate(
  element: Element,
  computed: CSSStyleDeclaration,
  pseudo?: "::before" | "::after",
): boolean {
  const hostTag = element.tagName.toUpperCase();
  const isIconHost = hostTag === "I" || hostTag === "SPAN";
  const isControlSurface = isControlSurfacePseudoCandidate(element, computed);
  const hostRect = element.getBoundingClientRect();
  if (isIconHost && (hostRect.width > 48 || hostRect.height > 48)) return false;

  const text = parseCssTextContent(computed.content);
  if (text && text.trim()) return false;

  const width = parsePx(computed.width, NaN);
  const height = parsePx(computed.height, NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  const isLeadingIcon = isLeadingIconPseudoCandidate(element, pseudo, computed, hostRect, width, height);
  if (!isIconHost && !isSmallMarkerPseudoCandidate(element, computed) && !isControlSurface && !isLeadingIcon) return false;

  const maxWidth = isControlSurface ? Math.max(32, hostRect.width + 16) : 32;
  const maxHeight = isControlSurface ? Math.max(32, hostRect.height + 16) : 32;
  const effectiveMaxWidth = isLeadingIcon ? Math.max(maxWidth, 40) : maxWidth;
  const effectiveMaxHeight = isLeadingIcon ? Math.max(maxHeight, 40) : maxHeight;
  if (width <= 0 || height <= 0 || width > effectiveMaxWidth || height > effectiveMaxHeight) return false;

  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") {
    return false;
  }

  return (
    isVisiblePaint(computed.backgroundColor) ||
    hasVisibleBorderStyles(computed) ||
    Boolean(computed.backgroundImage && computed.backgroundImage !== "none")
  );
}

function isLeadingIconPseudoCandidate(
  element: Element,
  pseudo: "::before" | "::after" | undefined,
  computed: CSSStyleDeclaration,
  hostRect: DOMRect,
  width: number,
  height: number,
): boolean {
  if (pseudo !== "::before") return false;
  if (hostRect.width <= 0 || hostRect.height <= 0 || hostRect.height > 80) return false;
  if (width < 8 || height < 8 || width > 40 || height > 40) return false;

  const aspectRatio = width / height;
  if (aspectRatio < 0.5 || aspectRatio > 2) return false;
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;
  if (!isVisiblePaint(computed.backgroundColor) && !hasVisibleBorderStyles(computed) && (!computed.backgroundImage || computed.backgroundImage === "none")) {
    return false;
  }

  const hasText = Boolean((element.textContent || "").replace(/\s+/g, " ").trim());
  if (!hasText) return false;

  const left = parsePx(computed.left, NaN);
  const top = parsePx(computed.top, NaN);
  const bottom = parsePx(computed.bottom, NaN);
  if (computed.position === "absolute" || computed.position === "fixed") {
    if (!Number.isFinite(left) || left < -48 || left > 56) return false;
    return Number.isFinite(top) || Number.isFinite(bottom) || hostRect.height <= 40;
  }

  const firstAnchorRect = getFirstDirectTextRect(element) ?? getFirstDirectChildVisualRect(element);
  if (!firstAnchorRect) return false;
  const availableLeadingSpace = firstAnchorRect.x - hostRect.x;
  return availableLeadingSpace >= Math.min(width, 12) || hostRect.width > width + firstAnchorRect.width;
}

function isControlSurfacePseudoCandidate(element: Element, computed: CSSStyleDeclaration): boolean {
  const hostRect = element.getBoundingClientRect();
  if (hostRect.width <= 0 || hostRect.height <= 0 || hostRect.width > 360 || hostRect.height > 80) return false;
  if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;
  if (!isVisiblePaint(computed.backgroundColor) && !hasVisibleBorderStyles(computed)) return false;

  const role = element.getAttribute("role")?.toLowerCase() || "";
  const hasSelectedState =
    element.getAttribute("aria-selected") === "true" ||
    element.getAttribute("aria-pressed") === "true" ||
    element.getAttribute("aria-current") === "true";
  if (!hasSelectedState || (role && role !== "tab" && role !== "button" && role !== "switch")) return false;

  const width = parsePx(computed.width, NaN);
  const height = parsePx(computed.height, NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;

  return (
    width >= hostRect.width * 0.5 &&
    height >= hostRect.height * 0.5 &&
    width <= hostRect.width + 16 &&
    height <= hostRect.height + 16
  );
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
  const isTabMarker = isInlineTabMarkerPseudoCandidate(element, pseudo, computed, width, height);
  const isLeadingIcon = isInlineLeadingIconPseudoCandidate(element, pseudo, computed, width, height);
  if (!isTabMarker && !isLeadingIcon) {
    return null;
  }

  const textRect = getFirstDirectTextRect(element) ?? (isLeadingIcon ? getFirstDirectChildVisualRect(element) : null);
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

function isInlineLeadingIconPseudoCandidate(
  element: Element,
  pseudo: "::before" | "::after",
  computed: CSSStyleDeclaration,
  width: number,
  height: number,
): boolean {
  if (pseudo !== "::before") return false;
  if (computed.position === "absolute" || computed.position === "fixed") return false;
  if (width < 8 || height < 8 || width > 40 || height > 40) return false;
  if (!isVisiblePaint(computed.backgroundColor) && !hasVisibleBorderStyles(computed) && (!computed.backgroundImage || computed.backgroundImage === "none")) {
    return false;
  }

  const hostRect = element.getBoundingClientRect();
  if (hostRect.width <= 0 || hostRect.height <= 0 || hostRect.height > 80) return false;
  if (!(element.textContent || "").trim()) return false;
  return Boolean(getFirstDirectTextRect(element) ?? getFirstDirectChildVisualRect(element));
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

function getFirstDirectChildVisualRect(element: Element): { x: number; y: number; width: number; height: number } | null {
  const rect = getDirectChildVisualRects(element)[0];
  if (!rect) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
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
    styles.backgroundColor = normalizeCssColorFunctions(computed.backgroundColor);
  }
  if (computed.backgroundImage && computed.backgroundImage !== "none") {
    styles.backgroundImage = normalizeCssColorFunctions(computed.backgroundImage);
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
    styles[`border${side}Color`] = normalizeCssColorFunctions(color);
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
  const rect = computePseudoTextRect(element, pseudo, text, hostRect, computed, width, height, fontSize);
  const styles = getPseudoTextStyles(computed, fontSize, lineHeight);
  styles.left = `${roundPx(rect.x - hostRect.x)}px`;
  styles.top = `${roundPx(rect.y - hostRect.y)}px`;

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
  text: string,
  hostRect: DOMRect,
  computed: CSSStyleDeclaration,
  width: number,
  height: number,
  fontSize: number,
): DOMRect {
  const inlineRect = computeInlinePseudoTextRect(element, pseudo, text, computed, width, height);
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
  text: string,
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
  const requiredAsteriskGap = isRequiredFormAsteriskPseudo(element, pseudo, text)
    ? 4
    : 0;
  const x = pseudo === "::before"
    ? anchor.x - width - marginRight - requiredAsteriskGap + marginLeft
    : anchor.right + marginLeft;
  const y = anchor.y + Math.max(0, (anchor.height - height) / 2) + marginTop;

  return new DOMRect(x, y, width, height);
}

function isRequiredFormAsteriskPseudo(element: Element, pseudo: "::before" | "::after", text: string): boolean {
  if (pseudo !== "::before" || text.trim() !== "*") return false;

  const identity = getElementIdentity(element);
  const ancestor = element.closest(
    ".el-form-item, .ant-form-item, .form-item, .el-form, .ant-form, form, [class~='form'], [class*='-form'], [class*='form-'], [class*='_form'], [class*='form_']",
  );
  return /(^|[-_\s])(label|form-item__label|form-label)([-_\s]|$)/i.test(identity) || Boolean(ancestor);
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

function applyNegativeVirtualScrollOffsetToElementRect(element: Element, rect: ElementRect): ElementRect {
  const offset = getNegativeVirtualScrollOffset(element);
  if (!offset) return rect;

  rect.x = roundPx(rect.x + offset.x);
  rect.y = roundPx(rect.y + offset.y);
  if (rect.quad) {
    rect.quad.p1.x = roundPx(rect.quad.p1.x + offset.x);
    rect.quad.p1.y = roundPx(rect.quad.p1.y + offset.y);
    rect.quad.p2.x = roundPx(rect.quad.p2.x + offset.x);
    rect.quad.p2.y = roundPx(rect.quad.p2.y + offset.y);
    rect.quad.p3.x = roundPx(rect.quad.p3.x + offset.x);
    rect.quad.p3.y = roundPx(rect.quad.p3.y + offset.y);
    rect.quad.p4.x = roundPx(rect.quad.p4.x + offset.x);
    rect.quad.p4.y = roundPx(rect.quad.p4.y + offset.y);
  }

  return rect;
}

function applyNegativeVirtualScrollOffsetToRect(element: Element | null, rect: Rect): Rect {
  const offset = element ? getNegativeVirtualScrollOffset(element) : null;
  if (!offset) return rect;

  return {
    ...rect,
    x: roundPx(rect.x + offset.x),
    y: roundPx(rect.y + offset.y),
  };
}

function getNegativeVirtualScrollOffset(element: Element): { x: number; y: number } | null {
  let current: Element | null = element;
  let depth = 0;

  while (current && depth < 12) {
    const offset = getOwnNegativeVirtualScrollOffset(current);
    if (offset) return offset;

    current = current.parentElement;
    depth += 1;
  }

  return null;
}

function getOwnNegativeVirtualScrollOffset(element: Element): { x: number; y: number } | null {
  if (!isInstanceOfOwner<HTMLElement>(element, element, "HTMLElement")) return null;

  const tag = element.tagName.toUpperCase();
  if (tag === "HTML" || tag === "BODY") return null;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const clientHeight = element.clientHeight;
  const scrollHeight = element.scrollHeight;
  if (clientHeight < 80) return null;
  if (scrollHeight <= clientHeight + 200) return null;
  if (Math.abs(rect.height - clientHeight) > 2) return null;

  const hiddenAbove = scrollHeight - clientHeight;
  if (hiddenAbove < 200 || rect.y >= -32) return null;

  const ownerWindow = getNodeWindow(element);
  if (rect.right <= -32 || rect.left >= ownerWindow.innerWidth + 32) return null;

  const shiftedTop = rect.y + hiddenAbove;
  const shiftedBottom = shiftedTop + rect.height;
  if (shiftedTop > ownerWindow.innerHeight + 96 || shiftedBottom < -96) return null;

  const computed = getComputedStyleFor(element);
  if (computed.display === "none" || computed.visibility === "hidden") return null;
  if (Number.parseFloat(computed.opacity || "1") <= 0.01) return null;

  return { x: 0, y: hiddenAbove };
}

function toElementRect(rect: { x: number; y: number; width: number; height: number }): ElementRect {
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
  normalizeExpandedIframeDocumentShell(serialized, frameRect);
  rasterizeEmptyIframeShells(serialized, assetCollector);
  lockSnapshotGeometry(serialized, frameRect);
  childNodes.push(serialized);
  return true;
}

function normalizeExpandedIframeDocumentShell(
  node: SnapshotNode,
  frameRect: { x: number; y: number; width: number; height: number },
): void {
  if (!isElementNodeSnapshot(node)) return;

  node.rect.x = frameRect.x;
  node.rect.y = frameRect.y;
  node.rect.width = Math.max(node.rect.width, frameRect.width);
  node.rect.height = Math.max(node.rect.height, frameRect.height);
  node.rect.cssWidth = Math.round(node.rect.width);
  node.rect.cssHeight = Math.round(node.rect.height);
  node.styles.width = `${roundPx(node.rect.width)}px`;
  node.styles.height = `${roundPx(node.rect.height)}px`;

  expandIframeViewportShellDescendants(node, frameRect, 0);
}

function expandIframeViewportShellDescendants(
  node: ElementSnapshot,
  frameRect: { x: number; y: number; width: number; height: number },
  depth: number,
): void {
  if (depth > 6) return;

  for (const child of node.childNodes) {
    if (!isElementNodeSnapshot(child)) continue;

    const visibleBounds = getSnapshotDescendantVisibleBounds(child.childNodes, frameRect);
    if (visibleBounds && isIframeViewportShellSnapshot(child, frameRect, depth)) {
      const visibleRight = Math.min(frameRect.x + frameRect.width, visibleBounds.x + visibleBounds.width);
      const visibleBottom = Math.min(frameRect.y + frameRect.height, visibleBounds.y + visibleBounds.height);
      const nextWidth = Math.max(child.rect.width, visibleRight - child.rect.x);
      const nextHeight = Math.max(child.rect.height, visibleBottom - child.rect.y);

      child.rect.width = Math.max(1, nextWidth);
      child.rect.height = Math.max(1, nextHeight);
      child.rect.cssWidth = Math.round(child.rect.width);
      child.rect.cssHeight = Math.round(child.rect.height);
      child.styles.width = `${roundPx(child.rect.width)}px`;
      child.styles.height = `${roundPx(child.rect.height)}px`;
    }

    expandIframeViewportShellDescendants(child, frameRect, depth + 1);
  }
}

function isIframeViewportShellSnapshot(
  node: ElementSnapshot,
  frameRect: { x: number; y: number; width: number; height: number },
  depth: number,
): boolean {
  if (node.tag === "HTML" || node.tag === "BODY") return true;
  if (depth > 4) return false;
  if (isSnapshotOverflowClipContainer(node.styles)) return false;
  if (Math.abs(node.rect.x - frameRect.x) > 2 || Math.abs(node.rect.y - frameRect.y) > 2) return false;
  return node.rect.width >= frameRect.width * 0.5;
}

function getSnapshotDescendantVisibleBounds(
  childNodes: SnapshotNode[],
  clipRect: { x: number; y: number; width: number; height: number },
): Rect | null {
  const rects: Rect[] = [];
  collectSnapshotVisibleDescendantRects(childNodes, clipRect, rects);
  return unionSnapshotRects(rects);
}

function collectSnapshotVisibleDescendantRects(
  childNodes: SnapshotNode[],
  clipRect: { x: number; y: number; width: number; height: number },
  rects: Rect[],
): void {
  for (const child of childNodes) {
    if (isElementNodeSnapshot(child) && isSnapshotVisuallyHidden(child)) continue;

    const visibleRect = intersectSnapshotRect(child.rect, clipRect);
    if (visibleRect) rects.push(visibleRect);

    if (isElementNodeSnapshot(child)) {
      collectSnapshotVisibleDescendantRects(child.childNodes, clipRect, rects);
    }
  }
}

function isSnapshotVisuallyHidden(node: ElementSnapshot): boolean {
  const opacity = Number.parseFloat(node.styles.opacity || "1");
  return node.styles.display === "none" ||
    node.styles.visibility === "hidden" ||
    node.styles.visibility === "collapse" ||
    (Number.isFinite(opacity) && opacity <= 0.01);
}

function intersectSnapshotRect(
  rect: { x: number; y: number; width: number; height: number },
  clipRect: { x: number; y: number; width: number; height: number },
): Rect | null {
  if (rect.width <= 0 || rect.height <= 0) return null;

  const left = Math.max(rect.x, clipRect.x);
  const top = Math.max(rect.y, clipRect.y);
  const right = Math.min(rect.x + rect.width, clipRect.x + clipRect.width);
  const bottom = Math.min(rect.y + rect.height, clipRect.y + clipRect.height);
  if (right <= left || bottom <= top) return null;

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function getEmptyIframeViewportCropRect(
  element: Element,
  rect: ElementRect,
  childNodes: SnapshotNode[],
): ElementRect | null {
  if (element.tagName.toUpperCase() !== "IFRAME") return null;
  if (childNodes.length > 0) return null;
  if (element.ownerDocument !== document) return null;
  return getLargeVisibleElementViewportIntersectionRect(element, rect);
}

function rasterizeEmptyIframeShells(
  node: SnapshotNode,
  assetCollector: ResourceResolver,
  ancestors: ElementSnapshot[] = [],
): void {
  if (!isElementNodeSnapshot(node)) return;

  if (node.tag === "IFRAME" && node.childNodes.length === 0) {
    const cropRect = getLargeVisibleSnapshotViewportIntersectionRect(node.rect, ancestors);
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

  const nextAncestors = [...ancestors, node];
  for (const child of node.childNodes) {
    rasterizeEmptyIframeShells(child, assetCollector, nextAncestors);
  }
}

function getLargeVisibleViewportIntersectionRect(rect: Rect): ElementRect | null {
  return getLargeVisibleRectIntersection(rect, new DOMRect(0, 0, window.innerWidth, window.innerHeight));
}

function getLargeVisibleElementViewportIntersectionRect(element: Element, rect: Rect): ElementRect | null {
  let visibleRect = getLargeVisibleRectIntersection(rect, new DOMRect(0, 0, window.innerWidth, window.innerHeight));
  if (!visibleRect) return null;

  let ancestor = element.parentElement;
  while (ancestor) {
    const computed = getComputedStyleFor(ancestor);
    if (isOverflowClipContainer(computed)) {
      visibleRect = getLargeVisibleRectIntersection(visibleRect, ancestor.getBoundingClientRect());
      if (!visibleRect) return null;
    }
    ancestor = ancestor.parentElement;
  }

  return visibleRect;
}

function getLargeVisibleSnapshotViewportIntersectionRect(rect: Rect, ancestors: ElementSnapshot[]): ElementRect | null {
  let visibleRect = getLargeVisibleRectIntersection(rect, new DOMRect(0, 0, window.innerWidth, window.innerHeight));
  if (!visibleRect) return null;

  for (const ancestor of ancestors) {
    if (!isSnapshotOverflowClipContainer(ancestor.styles)) continue;
    visibleRect = getLargeVisibleRectIntersection(
      visibleRect,
      new DOMRect(ancestor.rect.x, ancestor.rect.y, ancestor.rect.width, ancestor.rect.height),
    );
    if (!visibleRect) return null;
  }

  return visibleRect;
}

function getLargeVisibleRectIntersection(rect: Rect, clipRect: DOMRect): ElementRect | null {
  if (rect.width < 120 || rect.height < 120) return null;

  const left = Math.max(clipRect.left, rect.x);
  const top = Math.max(clipRect.top, rect.y);
  const right = Math.min(clipRect.right, rect.x + rect.width);
  const bottom = Math.min(clipRect.bottom, rect.y + rect.height);
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

function isOverflowClipContainer(computed: CSSStyleDeclaration): boolean {
  return /^(hidden|clip|auto|scroll)$/i.test(computed.overflow) ||
    /^(hidden|clip|auto|scroll)$/i.test(computed.overflowX) ||
    /^(hidden|clip|auto|scroll)$/i.test(computed.overflowY);
}

function isSnapshotOverflowClipContainer(styles: Record<string, string>): boolean {
  return /^(hidden|clip|auto|scroll)(?:\s+(hidden|clip|auto|scroll))?$/i.test(styles.overflow || "") ||
    /^(hidden|clip|auto|scroll)$/i.test(styles.overflowX || "") ||
    /^(hidden|clip|auto|scroll)$/i.test(styles.overflowY || "");
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
  const shouldPreserveExternalPseudoOverflow = node.attributes["data-h2d-external-pseudo-overflow"] === "true";
  const shouldPreserveExternalControlOverflow = node.attributes["data-h2d-external-control-overflow"] === "true";
  const shouldPreserveExternalRuleOverflow = node.attributes["data-h2d-external-rule-overflow"] === "true";
  if (
    isZeroSizeVisibleWrapper(node) ||
    shouldPreservePopupActionOverflow ||
    shouldPreserveExternalPseudoOverflow ||
    shouldPreserveExternalControlOverflow ||
    shouldPreserveExternalRuleOverflow
  ) {
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

function relaxExternalPseudoElementClipping(
  styles: Record<string, string>,
  rect: { x: number; y: number; width: number; height: number },
  childNodes: SnapshotNode[],
): boolean {
  if (!hasExternalMaterializedPseudoChild(childNodes, rect)) return false;

  styles.overflow = "visible";
  styles.overflowX = "visible";
  styles.overflowY = "visible";
  return true;
}

function relaxExternalMaterializedControlClipping(
  styles: Record<string, string>,
  rect: { x: number; y: number; width: number; height: number },
  childNodes: SnapshotNode[],
): boolean {
  if (!hasExternalMaterializedControlChild(childNodes, rect)) return false;

  styles.overflow = "visible";
  styles.overflowX = "visible";
  styles.overflowY = "visible";
  return true;
}

function relaxExternalRuleElementClipping(
  styles: Record<string, string>,
  rect: { x: number; y: number; width: number; height: number },
  childNodes: SnapshotNode[],
): boolean {
  if (!hasExternalDecorativeRuleChild(childNodes, rect)) return false;

  styles.overflow = "visible";
  styles.overflowX = "visible";
  styles.overflowY = "visible";
  return true;
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

function hasExternalDecorativeRuleChild(
  childNodes: SnapshotNode[],
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  let hasRule = false;

  for (const child of childNodes) {
    if (child.rect.width <= 0.5 || child.rect.height <= 0.5) continue;
    if (!isSnapshotRectOutsideRect(child.rect, rect)) continue;

    if (!isElementNodeSnapshot(child) || !isExternalDecorativeRuleSnapshot(child, rect)) {
      return false;
    }

    hasRule = true;
  }

  return hasRule;
}

function isExternalDecorativeRuleSnapshot(
  node: ElementSnapshot,
  parentRect: { x: number; y: number; width: number; height: number },
): boolean {
  if (getSnapshotText(node).trim().length > 0) return false;
  if (!hasSnapshotVisibleBackground(node.styles) && !hasSnapshotVisibleBorderStyles(node.styles)) return false;

  const parentRight = parentRect.x + parentRect.width;
  const parentBottom = parentRect.y + parentRect.height;
  const nodeRight = node.rect.x + node.rect.width;
  const nodeBottom = node.rect.y + node.rect.height;

  const overlapsParentX = nodeRight > parentRect.x && node.rect.x < parentRight;
  const overlapsParentY = nodeBottom > parentRect.y && node.rect.y < parentBottom;
  const spillsParentX = node.rect.x < parentRect.x - 0.5 || nodeRight > parentRight + 0.5;
  const spillsParentY = node.rect.y < parentRect.y - 0.5 || nodeBottom > parentBottom + 0.5;

  const horizontalRule =
    node.rect.height <= 3 &&
    node.rect.width >= Math.min(parentRect.width + 8, parentRect.width * 1.05) &&
    overlapsParentX &&
    overlapsParentY &&
    spillsParentX;
  if (horizontalRule) return true;

  return (
    node.rect.width <= 3 &&
    node.rect.height >= Math.min(parentRect.height + 8, parentRect.height * 1.05) &&
    overlapsParentX &&
    overlapsParentY &&
    spillsParentY
  );
}

function hasExternalMaterializedControlChild(
  childNodes: SnapshotNode[],
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  for (const child of childNodes) {
    if (!isElementNodeSnapshot(child)) continue;
    if (!isSnapshotRectOutsideRect(child.rect, rect)) continue;
    if (!isCloseExternalSnapshotRect(child.rect, rect)) continue;
    if (hasMaterializedFormControlSnapshot(child)) return true;
  }

  return false;
}

function hasMaterializedFormControlSnapshot(node: ElementSnapshot): boolean {
  if (
    node.attributes["data-h2d-select-control"] === "true" ||
    node.attributes["data-h2d-radio-control"] === "true"
  ) {
    return true;
  }

  return node.childNodes.some((child) => (
    isElementNodeSnapshot(child) && hasMaterializedFormControlSnapshot(child)
  ));
}

function hasExternalMaterializedPseudoChild(
  childNodes: SnapshotNode[],
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  for (const child of childNodes) {
    if (!isElementNodeSnapshot(child)) continue;
    if (!child.attributes["data-h2d-pseudo"]) continue;
    if (!isSnapshotRectOutsideRect(child.rect, rect)) continue;
    if (!isCloseExternalSnapshotRect(child.rect, rect)) continue;

    const pseudoText = getSnapshotText(child);
    const pseudoKind = child.attributes["data-h2d-pseudo-kind"] || "text";
    if (pseudoKind === "text" && pseudoText.length <= 8) return true;
    if (pseudoKind === "paint" && child.rect.width <= 48 && child.rect.height <= 48) return true;
  }

  return false;
}

function isCloseExternalSnapshotRect(
  child: { x: number; y: number; width: number; height: number },
  parent: { x: number; y: number; width: number; height: number },
): boolean {
  if (child.width <= 0 || child.height <= 0 || parent.width <= 0 || parent.height <= 0) return false;

  const parentRight = parent.x + parent.width;
  const parentBottom = parent.y + parent.height;
  const childRight = child.x + child.width;
  const childBottom = child.y + child.height;
  const maxOvershoot = Math.max(
    parent.x - child.x,
    childRight - parentRight,
    parent.y - child.y,
    childBottom - parentBottom,
    0,
  );
  if (maxOvershoot > 32) return false;

  const closeEnough =
    childRight > parent.x - 32 &&
    child.x < parentRight + 32 &&
    childBottom > parent.y - 32 &&
    child.y < parentBottom + 32;
  return closeEnough;
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
  const { lineCount, ...rawRectWithoutLineCount } = getTextRect(nodeOrNodes);
  const rectWithoutLineCount = applyNegativeVirtualScrollOffsetToRect(
    getTextNodeParentElement(nodeOrNodes),
    rawRectWithoutLineCount,
  );

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
