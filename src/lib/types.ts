/**
 * Shared type definitions for the DOM capture pipeline.
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Quad {
  p1: Point;
  p2: Point;
  p3: Point;
  p4: Point;
}

export interface ElementRect extends Rect {
  cssWidth: number;
  cssHeight: number;
  quad?: Quad;
}

export interface SimpleMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface AssetEntry {
  url: string;
  blob: Blob | null;
  error?: string;
}

export interface Base64Asset {
  type: string;
  base64Blob: string;
}

export interface AssetCollectorOptions {
  skipRemoteAssetSerialization?: boolean;
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export interface FontUsage {
  fontWeight: string;
  fontStyle: string;
  fontStretch: string;
  fontSize: string;
}

export interface FontFaceData {
  stretch: string;
  style: string;
  weight: string;
}

export interface FontData {
  familyName: string;
  faces: FontFaceData[];
  usages: FontUsage[];
}

export type FontMap = Record<string, FontData>;

// ---------------------------------------------------------------------------
// React Fiber (loosely typed - internal API)
// ---------------------------------------------------------------------------

export interface ReactFiber {
  tag: number;
  type: unknown;
  child: ReactFiber | null;
  sibling: ReactFiber | null;
  return: ReactFiber | null;
  stateNode: Node | null;
  pendingProps: Record<string, unknown> | null;
  memoizedProps: Record<string, unknown> | null;
  _debugOwner?: ReactFiber;
  _debugSource?: { fileName: string; lineNumber: number };
}

// ---------------------------------------------------------------------------
// Source annotations
// ---------------------------------------------------------------------------

export type AnnotationType = "element" | "text" | "expression";

interface BaseAnnotation {
  sourceId: string;
  fileGuid: string;
  filePath: string;
  fileVersion: string;
  line: number;
  column: number;
  pos: number;
  len: number;
}

export interface ElementAnnotation extends BaseAnnotation {
  type: "element";
  name: string;
  childTypes?: string[];
  isComponentDefinition?: true;
  assetKey?: string;
  makeLibraryId?: string;
  libraryId?: string;
  componentId?: string;
  isLibraryInstance?: true;
}

export interface TextAnnotation extends BaseAnnotation {
  type: "text";
}

export interface ExpressionAnnotation extends BaseAnnotation {
  type: "expression";
}

export type SourceAnnotation =
  | ElementAnnotation
  | TextAnnotation
  | ExpressionAnnotation;

// ---------------------------------------------------------------------------
// Serialized fiber tree
// ---------------------------------------------------------------------------

export interface SerializedFiberNode {
  h2dId: string | undefined;
  name: string | undefined;
  fiberTag: number | null;
  props: Record<string, unknown> | undefined;
  children: SerializedFiberNode[];
}

export interface TruncatedPropValue {
  truncated: true;
  value: string;
  originalLength: number;
}

export interface PropRefValue {
  ref: string;
}

// ---------------------------------------------------------------------------
// Serialized snapshot nodes
// ---------------------------------------------------------------------------

export type LayoutSizing = "FILL" | "HUG" | "FIXED";

export interface ElementSnapshot {
  nodeType: 1;
  id: string;
  tag: string;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  rect: ElementRect;
  childNodes: SnapshotNode[];
  content?: string;
  placeholderUrl?: string;
  pseudoElementStyles?: Record<string, Record<string, string>>;
  owningReactComponent?: string;
  sources?: SourceAnnotation[];
  selectionSourceId?: string;
  relativeTransform?: SimpleMatrix;
  declaredStyles?: Record<string, string>;
  /** Auto Layout sizing hint for the horizontal axis. */
  layoutSizingHorizontal?: LayoutSizing;
  /** Auto Layout sizing hint for the vertical axis. */
  layoutSizingVertical?: LayoutSizing;
}

export interface TextSnapshot {
  nodeType: 3;
  id: string;
  text: string;
  rect: Rect;
  lineCount: number;
  sources?: SourceAnnotation[];
}

export type SnapshotNode = ElementSnapshot | TextSnapshot;

// ---------------------------------------------------------------------------
// Capture tree (top-level result)
// ---------------------------------------------------------------------------

export interface CaptureTree {
  root: ElementSnapshot;
  documentTitle?: string;
  experimental?: {
    reactFiberTree: SerializedFiberNode | null;
  };
  documentRect: Rect;
  viewportRect: Rect;
  devicePixelRatio: number;
  assets: Map<string, AssetEntry>;
  fonts: FontMap;
}

// ---------------------------------------------------------------------------
// Serialization options
// ---------------------------------------------------------------------------

export type CaptureMode = "viewport" | "full-page";

export interface CapturePageOptions {
  captureMode?: CaptureMode;
}

export interface CaptureOptions {
  assertLayoutValid?: boolean;
  skipRemoteAssetSerialization?: boolean;
  includeReactFiberTree?: boolean;
  captureDeclaredStyles?: boolean;
  captureMode?: CaptureMode;
  timeoutSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Serialization context (internal)
// ---------------------------------------------------------------------------

export interface CaptureContext {
  captureDeclaredStyles: boolean;
  declaredStylesCache: Map<Document, StylesheetCache> | undefined;
  svgSpriteCache?: Map<string, Document>;
}

export interface StylesheetCache {
  entries: GridRuleEntry[];
  matchMediaCache: Map<string, boolean>;
}

export type GridRuleEntry =
  | { type: "style"; rule: CSSStyleRule }
  | { type: "media"; mediaText: string; inner: GridRuleEntry[] };

// ---------------------------------------------------------------------------
// Hash params
// ---------------------------------------------------------------------------

export interface HashParamsCapture {
  shouldCapture: true;
  captureId?: string;
  endpoint?: string;
  delay?: number;
  selector?: string;
  logPayload?: boolean;
  logVerbose?: boolean;
}

export interface HashParamsNoCapture {
  shouldCapture: false;
}

export type HashParams = HashParamsCapture | HashParamsNoCapture;

// ---------------------------------------------------------------------------
// Submit response
// ---------------------------------------------------------------------------

export interface SubmitResult {
  claimUrl: string | undefined;
  nextCaptureId: string | undefined;
}

// ---------------------------------------------------------------------------
// Window augmentation
// ---------------------------------------------------------------------------

export interface DomCaptureAPI {
  capturePage: (selector?: string, options?: CapturePageOptions) => Promise<string>;
  submitCapture: (
    json: string,
    captureId: string,
    endpoint: string,
    captureIndex?: number,
  ) => Promise<SubmitResult>;
  writeToClipboard: (json: string) => Promise<void>;
  wrapForClipboard: (json: string) => Promise<Blob>;
  isValidFigmaEndpoint: (url: string) => boolean;
  parseHashParams: () => HashParams;
  setVerbose: (enabled: boolean) => void;
  useHtmlClipboardEncoding?: boolean;
}

declare global {
  interface Window {
    figma?: Partial<DomCaptureAPI>;
  }
}
