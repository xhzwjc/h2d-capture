import type { ElementRect, ElementSnapshot, SnapshotNode, TextSnapshot } from '../types.js';
import { getComputedStyleFor } from './dom.js';
import { NODE_TYPES, getTextRect, isNodeVisible } from './walker.js';

type IdFactory = (node: Node | null) => string;

type PlaceholderSource = "visible text" | "placeholder element" | "input.placeholder" | "aria-placeholder" | "title" | "empty";

interface SelectDisplayText {
  text: string;
  source: PlaceholderSource;
  sourceElement?: Element;
  isPlaceholder: boolean;
}

interface SelectControl {
  root: Element;
  visualBox: Element;
  input?: HTMLInputElement;
  displayText: SelectDisplayText;
  arrow?: Element;
  arrowRect: DOMRect;
  arrowInside: boolean;
  hideArrow?: boolean;
}

interface RadioControl {
  root: Element;
  input: HTMLInputElement;
  iconElement: Element;
  textNodes: Node[];
  text: string;
  checked: boolean;
}

const SELECT_ROOT_CLASS_PATTERN =
  /(^|[-_\s])(select(?![-_](?:none|text|all|auto)(?:[-_\s]|$))|picker|cascader|combobox)([-_\s]|$)/i;
const DROPDOWN_CLASS_PATTERN = /(^|[-_\s])dropdown([-_\s]|$)/i;
const SELECT_VISUAL_CLASS_PATTERN =
  /(^|[-_\s])(selector|selection|control|wrapper|trigger|field)([-_\s]|$)/i;
const SELECT_INTERNAL_CLASS_PATTERN =
  /(^|[-_\s])(placeholder|search|rendered|arrow|suffix|prefix|caret|icon|clear|item|option|menu|list)([-_\s]|$)/i;
const PLACEHOLDER_CLASS_PATTERN = /(^|[-_\s])placeholder([-_\s]|$)/i;
const ARROW_CLASS_PATTERN = /(^|[-_\s])(arrow|suffix|caret|chevron|icon)([-_\s]|$)/i;
const SELECT_ARIA_POPUPS = new Set(["listbox", "menu", "tree", "grid", "dialog"]);

let debugLoggedCount = 0;
let debugLoggedControls = new WeakSet<Element>();

export function resetFormControlDebugState(): void {
  debugLoggedCount = 0;
  debugLoggedControls = new WeakSet<Element>();
}

export function snapshotSelectControl(element: Element, createId: IdFactory): ElementSnapshot | null {
  const nativeControl = detectNativeSelectControl(element);
  if (nativeControl) {
    return createSelectSnapshot(nativeControl, createId);
  }

  const control = detectSelectControl(element);
  if (!control) return null;

  logSelectControlDebug(control);
  return createSelectSnapshot(control, createId);
}

export function snapshotRadioControl(element: Element, createId: IdFactory): ElementSnapshot | null {
  const control = detectRadioControl(element);
  if (!control) return null;

  return createRadioSnapshot(control, createId);
}

export function detectSelectControl(element: Element): SelectControl | null {
  const root = findSelectControlRoot(element);
  if (!root) return null;

  const visualBox = findSelectVisualBox(root);
  const visualRect = visualBox.getBoundingClientRect();
  if (!isReasonableControlRect(visualRect)) return null;
  if (isOffscreenSyntheticControlCandidate(root, visualRect)) return null;

  if (hasCanonicalSelectAncestor(root, visualBox)) return null;

  const displayText = extractSelectDisplayText(root);
  const input = findSelectInput(root);
  if (!displayText.text && !input) return null;
  if (isCompactInlineFilterSelectTrigger(root, visualBox, displayText)) return null;
  if (hasExpandedCompositeSelectContent(root, visualBox)) return null;
  if (isMultilineDisclosureSelectTrigger(root, visualBox, displayText, input)) return null;

  const arrow = findSelectArrow(root, visualBox);
  if (isSplitActionPicker(root, visualBox, displayText, arrow)) return null;

  const arrowRect = computeArrowRect(arrow, visualBox);

  return {
    root,
    visualBox,
    input,
    displayText,
    arrow,
    arrowRect,
    arrowInside: arrow ? isRectInside(arrow.getBoundingClientRect(), visualRect) : false,
  };
}

function detectNativeSelectControl(element: Element): SelectControl | null {
  if (element.tagName.toUpperCase() !== "SELECT") return null;
  if (!isNodeVisible(element)) return null;

  const select = element as HTMLSelectElement;
  const visualRect = select.getBoundingClientRect();
  if (!isReasonableControlRect(visualRect)) return null;

  const text = getNativeSelectDisplayText(select);
  if (!text) return null;

  return {
    root: select,
    visualBox: select,
    displayText: {
      text,
      source: "visible text",
      sourceElement: select,
      isPlaceholder: false,
    },
    arrowRect: new DOMRect(visualRect.right, visualRect.y, 0, visualRect.height),
    arrowInside: false,
    hideArrow: true,
  };
}

function getNativeSelectDisplayText(select: HTMLSelectElement): string {
  const selectedOption = select.selectedOptions?.[0] || select.options.item(select.selectedIndex);
  const selectedText = (selectedOption?.textContent || "").replace(/\s+/g, " ").trim();
  if (selectedText) return selectedText;
  return (select.value || "").replace(/\s+/g, " ").trim();
}

function detectRadioControl(element: Element): RadioControl | null {
  if (!isRadioRootCandidate(element)) return null;

  const input = getRadioInputs(element)[0];
  if (!input) return null;

  const iconElement = findRadioIconElement(element, input);
  if (!iconElement) return null;

  const iconRect = iconElement.getBoundingClientRect();
  const rootRect = element.getBoundingClientRect();
  if (rootRect.width <= 0 || rootRect.height <= 0 || iconRect.width <= 0 || iconRect.height <= 0) {
    return null;
  }

  const textNodes = getRadioTextNodes(element, iconElement);
  const text = textNodes.map((node) => node.textContent || "").join("").replace(/\s+/g, " ").trim();
  if (!text) return null;

  return {
    root: element,
    input,
    iconElement,
    textNodes,
    text,
    checked: input.checked || input.hasAttribute("checked") || element.getAttribute("aria-checked") === "true",
  };
}

function isRadioRootCandidate(element: Element): boolean {
  if (!isNodeVisible(element)) return false;
  if (element.tagName.toUpperCase() === "INPUT") return false;

  const inputs = getRadioInputs(element);
  if (inputs.length !== 1) return false;

  const tag = element.tagName.toUpperCase();
  const identity = getElementIdentity(element);
  const role = element.getAttribute("role")?.toLowerCase() || "";
  const isLabel = tag === "LABEL";
  const hasRadioSignal = isLabel || role === "radio" || /(^|[-_\s])radio([-_\s]|$)/i.test(identity);
  if (!hasRadioSignal) return false;

  if (!isLabel && element.querySelector("label input[type='radio'], label input[type=\"radio\"]")) {
    return false;
  }

  const nearestLabel = inputs[0].closest("label");
  if (nearestLabel && nearestLabel !== element) return false;

  return true;
}

function getRadioInputs(element: Element): HTMLInputElement[] {
  return Array.from(element.querySelectorAll("input[type='radio'], input[type=\"radio\"]")) as HTMLInputElement[];
}

function findRadioIconElement(root: Element, input: HTMLInputElement): Element | null {
  const sibling = input.nextElementSibling;
  if (sibling && isRadioIconCandidate(sibling)) return sibling;

  const parent = input.parentElement;
  if (parent && parent !== root && isRadioIconCandidate(parent)) return parent;

  for (const candidate of Array.from(root.querySelectorAll("*"))) {
    if (candidate === input || candidate.contains(input)) continue;
    if (isRadioIconCandidate(candidate)) return candidate;
  }

  return input;
}

function isRadioIconCandidate(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8 || rect.width > 28 || rect.height > 28) return false;

  const computed = getComputedStyleFor(element);
  const identity = getElementIdentity(element);
  return (
    /(^|[-_\s])radio([-_\s]|$)/i.test(identity) ||
    hasVisibleRadius(computed) ||
    isVisibleColor(computed.backgroundColor) ||
    hasVisibleBorder(computed)
  );
}

function getRadioTextNodes(root: Element, iconElement: Element): Node[] {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];

  let node = walker.nextNode();
  while (node) {
    const text = node.textContent || "";
    const parent = node.parentElement;
    if (
      text.trim() &&
      parent &&
      !iconElement.contains(parent) &&
      parent !== iconElement &&
      isNodeVisible(parent)
    ) {
      nodes.push(node);
    }
    node = walker.nextNode();
  }

  return nodes;
}

function createRadioSnapshot(control: RadioControl, createId: IdFactory): ElementSnapshot {
  const rootRect = control.root.getBoundingClientRect();
  const iconSourceRect = control.iconElement.getBoundingClientRect();
  const rootComputed = getComputedStyleFor(control.root);
  const iconComputed = getComputedStyleFor(control.iconElement);
  const textRectData = getTextRect(control.textNodes);
  const textRect = new DOMRect(textRectData.x, textRectData.y, textRectData.width, textRectData.height);
  const iconRect = normalizeRadioIconRect(iconSourceRect);
  const checkedColor = getRadioCheckedColor(iconComputed, rootComputed);
  const uncheckedBorder = hasVisibleBorder(iconComputed)
    ? firstVisibleColor(
      iconComputed.borderTopColor,
      iconComputed.borderRightColor,
      iconComputed.borderBottomColor,
      iconComputed.borderLeftColor,
      "rgb(217, 217, 217)",
    )
    : "rgb(217, 217, 217)";
  const checkedUsesFilledOuter = control.checked && isVisibleColor(iconComputed.backgroundColor) && !isNearWhiteColor(iconComputed.backgroundColor);
  const outerBackground = control.checked && checkedUsesFilledOuter ? checkedColor : "rgb(255, 255, 255)";
  const innerColor = checkedUsesFilledOuter ? "rgb(255, 255, 255)" : checkedColor;
  const innerSize = Math.max(5, Math.round(iconRect.width * 0.38));
  const outerRadius = `${roundPx(iconRect.width / 2)}px`;
  const innerRadius = `${roundPx(innerSize / 2)}px`;

  const outer: ElementSnapshot = {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: createId(control.iconElement),
    tag: "DIV",
    attributes: { "data-h2d-radio-icon": control.checked ? "checked" : "unchecked" },
    styles: {
      display: "block",
      position: "absolute",
      left: `${roundPx(iconRect.x - rootRect.x)}px`,
      top: `${roundPx(iconRect.y - rootRect.y)}px`,
      width: `${roundPx(iconRect.width)}px`,
      height: `${roundPx(iconRect.height)}px`,
      boxSizing: "border-box",
      borderRadius: outerRadius,
      borderTopLeftRadius: outerRadius,
      borderTopRightRadius: outerRadius,
      borderBottomRightRadius: outerRadius,
      borderBottomLeftRadius: outerRadius,
      backgroundColor: outerBackground,
      borderTopWidth: "1px",
      borderRightWidth: "1px",
      borderBottomWidth: "1px",
      borderLeftWidth: "1px",
      borderTopStyle: "solid",
      borderRightStyle: "solid",
      borderBottomStyle: "solid",
      borderLeftStyle: "solid",
      borderTopColor: control.checked ? checkedColor : uncheckedBorder,
      borderRightColor: control.checked ? checkedColor : uncheckedBorder,
      borderBottomColor: control.checked ? checkedColor : uncheckedBorder,
      borderLeftColor: control.checked ? checkedColor : uncheckedBorder,
      overflow: "hidden",
    },
    rect: toElementRect(iconRect),
    childNodes: [],
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };

  if (control.checked) {
    const innerRect = new DOMRect(
      iconRect.x + (iconRect.width - innerSize) / 2,
      iconRect.y + (iconRect.height - innerSize) / 2,
      innerSize,
      innerSize,
    );
    outer.childNodes.push({
      nodeType: NODE_TYPES.ELEMENT_NODE,
      id: createId(null),
      tag: "DIV",
      attributes: { "data-h2d-radio-inner": "true" },
      styles: {
        display: "block",
        position: "absolute",
        left: `${roundPx(innerRect.x - iconRect.x)}px`,
        top: `${roundPx(innerRect.y - iconRect.y)}px`,
        width: `${roundPx(innerRect.width)}px`,
        height: `${roundPx(innerRect.height)}px`,
        borderRadius: innerRadius,
        borderTopLeftRadius: innerRadius,
        borderTopRightRadius: innerRadius,
        borderBottomRightRadius: innerRadius,
        borderBottomLeftRadius: innerRadius,
        backgroundColor: innerColor,
        boxSizing: "border-box",
      },
      rect: toElementRect(innerRect),
      childNodes: [],
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
    });
  }

  const textNode: TextSnapshot = {
    nodeType: NODE_TYPES.TEXT_NODE,
    id: createId(control.textNodes.length === 1 ? control.textNodes[0] : null),
    text: control.text,
    rect: {
      x: textRect.x,
      y: textRect.y,
      width: textRect.width,
      height: textRect.height,
    },
    lineCount: Math.max(1, textRectData.lineCount),
  };

  const textComputed = control.textNodes[0]?.parentElement
    ? getComputedStyleFor(control.textNodes[0].parentElement)
    : rootComputed;
  const textLayer: ElementSnapshot = {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: createId(null),
    tag: "DIV",
    attributes: { "data-h2d-radio-text": "true" },
    styles: {
      display: "block",
      position: "absolute",
      left: `${roundPx(textRect.x - rootRect.x)}px`,
      top: `${roundPx(textRect.y - rootRect.y)}px`,
      width: `${roundPx(textRect.width)}px`,
      height: `${roundPx(textRect.height)}px`,
      overflow: "visible",
      color: firstVisibleColor(textComputed.color, rootComputed.color, "rgb(31, 35, 41)"),
      fontFamily: textComputed.fontFamily || rootComputed.fontFamily,
      fontSize: textComputed.fontSize || rootComputed.fontSize,
      fontWeight: textComputed.fontWeight || rootComputed.fontWeight,
      lineHeight: `${roundPx(textRect.height)}px`,
      whiteSpace: "nowrap",
      boxSizing: "border-box",
    },
    rect: toElementRect(textRect),
    childNodes: [textNode],
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };

  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: createId(control.root),
    tag: "DIV",
    attributes: {
      "data-h2d-radio-control": "true",
      role: "radio",
      "aria-checked": control.checked ? "true" : "false",
    },
    styles: {
      display: "block",
      position: "relative",
      width: `${roundPx(rootRect.width)}px`,
      height: `${roundPx(rootRect.height)}px`,
      overflow: "visible",
      boxSizing: "border-box",
      color: rootComputed.color,
      fontFamily: rootComputed.fontFamily,
      fontSize: rootComputed.fontSize,
      fontWeight: rootComputed.fontWeight,
      lineHeight: rootComputed.lineHeight,
    },
    rect: toElementRect(rootRect),
    childNodes: [outer, textLayer],
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function normalizeRadioIconRect(rect: DOMRect): DOMRect {
  const size = clamp(Math.max(rect.width, rect.height), 10, 18);
  return new DOMRect(
    rect.x + (rect.width - size) / 2,
    rect.y + (rect.height - size) / 2,
    size,
    size,
  );
}

function getRadioCheckedColor(iconComputed: CSSStyleDeclaration, rootComputed: CSSStyleDeclaration): string {
  const visibleBorderColor = hasVisibleBorder(iconComputed)
    ? firstVisibleColor(
      iconComputed.borderTopColor,
      iconComputed.borderRightColor,
      iconComputed.borderBottomColor,
      iconComputed.borderLeftColor,
    )
    : "";
  const controlColor = isLikelyAccentColor(iconComputed.color) ? iconComputed.color : "";
  const inheritedColor = isLikelyAccentColor(rootComputed.color) ? rootComputed.color : "";

  return firstVisibleColor(
    !isNearWhiteColor(iconComputed.backgroundColor) ? iconComputed.backgroundColor : "",
    visibleBorderColor,
    controlColor,
    inheritedColor,
    "rgb(0, 143, 80)",
  );
}

function findSelectControlRoot(element: Element): Element | null {
  if (isSelectRootCandidate(element)) return element;

  const tag = element.tagName.toUpperCase();
  const identity = getElementIdentity(element);
  const canPromoteFromInnerNode =
    tag === "INPUT" ||
    PLACEHOLDER_CLASS_PATTERN.test(identity) ||
    SELECT_INTERNAL_CLASS_PATTERN.test(identity);

  if (!canPromoteFromInnerNode) return null;

  let ancestor = element.parentElement;
  let depth = 0;
  while (ancestor && depth < 6) {
    if (isSelectRootCandidate(ancestor)) return ancestor;
    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return null;
}

export function findSelectVisualBox(root: Element): Element {
  const rootRect = root.getBoundingClientRect();
  let best: { element: Element; score: number } | null = null;

  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (!canBeSelectVisualBox(element)) continue;

    const rect = element.getBoundingClientRect();
    if (!isReasonableControlRect(rect)) continue;

    const className = getElementIdentity(element);
    if (SELECT_INTERNAL_CLASS_PATTERN.test(className) && !/selection/i.test(className)) continue;

    const computed = getComputedStyleFor(element);
    const visualScore = getVisualBoxScore(element, computed, rootRect);
    if (visualScore <= 0) continue;

    if (!best || visualScore > best.score) {
      best = { element, score: visualScore };
    }
  }

  return best?.element ?? root;
}

function canBeSelectVisualBox(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "UL" || tag === "LI" || tag === "SVG" || tag === "I") {
    return false;
  }

  const identity = getElementIdentity(element);
  if (/(^|[-_\s])(search|rendered|placeholder|arrow|suffix|prefix|caret|icon|clear|item|option|menu|list)([-_\s]|$)/i.test(identity)) {
    return false;
  }

  return true;
}

export function extractSelectDisplayText(root: Element): SelectDisplayText {
  const selectedText = findSelectedVisibleText(root);
  if (selectedText.text) return selectedText;

  const placeholderElement = findPlaceholderElement(root);
  if (placeholderElement) {
    const text = getVisibleText(placeholderElement);
    if (text) {
      return {
        text,
        source: "placeholder element",
        sourceElement: placeholderElement,
        isPlaceholder: true,
      };
    }
  }

  const input = findSelectInput(root);
  if (input?.value) {
    return {
      text: input.value,
      source: "visible text",
      sourceElement: input,
      isPlaceholder: false,
    };
  }

  if (input?.placeholder) {
    return {
      text: input.placeholder,
      source: "input.placeholder",
      sourceElement: input,
      isPlaceholder: true,
    };
  }

  const ariaPlaceholder = root.getAttribute("aria-placeholder");
  if (ariaPlaceholder) {
    return { text: ariaPlaceholder, source: "aria-placeholder", isPlaceholder: true };
  }

  const title = root.getAttribute("title");
  if (title) {
    return { text: title, source: "title", isPlaceholder: true };
  }

  return { text: "", source: "empty", isPlaceholder: true };
}

export function findSelectArrow(root: Element, visualBox: Element): Element | undefined {
  const visualRect = visualBox.getBoundingClientRect();
  let best: { element: Element; score: number } | undefined;

  for (const element of Array.from(root.querySelectorAll("*"))) {
    const tag = element.tagName.toUpperCase();
    const className = getElementIdentity(element);
    const classMatch = ARROW_CLASS_PATTERN.test(className);
    const svgLike = tag === "SVG" || tag === "I";
    if (!classMatch && !svgLike) continue;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const rightDistance = Math.abs(visualRect.right - rect.right);
    const centerDelta = Math.abs((rect.top + rect.height / 2) - (visualRect.top + visualRect.height / 2));
    if (!classMatch && rightDistance > 40) continue;

    const score =
      (classMatch ? 60 : 0) +
      (svgLike ? 20 : 0) +
      Math.max(0, 40 - rightDistance) +
      Math.max(0, 20 - centerDelta);

    if (!best || score > best.score) {
      best = { element, score };
    }
  }

  return best?.element;
}

function createSelectSnapshot(control: SelectControl, createId: IdFactory): ElementSnapshot {
  const visualRect = control.visualBox.getBoundingClientRect();
  const visualComputed = getComputedStyleFor(control.visualBox);
  const textComputed = control.displayText.sourceElement
    ? getComputedStyleFor(control.displayText.sourceElement)
    : visualComputed;
  const rootRect = toElementRect(visualRect);
  const textRect = computeTextRect(control, visualComputed, textComputed);
  const arrowRect = clampArrowRect(control.arrowRect, visualRect);
  const border = getBorderStyles(control.visualBox, visualComputed);
  const childNodes: SnapshotNode[] = [];

  const textNode: TextSnapshot = {
    nodeType: NODE_TYPES.TEXT_NODE,
    id: createId(null),
    text: control.displayText.text,
    rect: {
      x: textRect.x,
      y: textRect.y,
      width: textRect.width,
      height: textRect.height,
    },
    lineCount: 1,
  };

  const textLayer: ElementSnapshot = {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: createId(null),
    tag: "DIV",
    attributes: { "data-h2d-select-text": control.displayText.source },
    styles: {
      display: "block",
      position: "absolute",
      left: `${roundPx(textRect.x - visualRect.x)}px`,
      top: `${roundPx(textRect.y - visualRect.y)}px`,
      width: `${roundPx(textRect.width)}px`,
      height: `${roundPx(textRect.height)}px`,
      overflow: "hidden",
      color: getDisplayTextColor(control, textComputed, visualComputed),
      fontFamily: textComputed.fontFamily || visualComputed.fontFamily,
      fontSize: textComputed.fontSize || visualComputed.fontSize,
      fontWeight: textComputed.fontWeight || visualComputed.fontWeight,
      lineHeight: `${roundPx(textRect.height)}px`,
      whiteSpace: "nowrap",
      boxSizing: "border-box",
    },
    rect: toElementRect(textRect),
    childNodes: control.displayText.text ? [textNode] : [],
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
  childNodes.push(textLayer);

  if (!control.hideArrow) {
    const arrowLayer: ElementSnapshot = {
      nodeType: NODE_TYPES.ELEMENT_NODE,
      id: createId(null),
      tag: "SVG",
      attributes: { "data-h2d-select-arrow": control.arrow ? "source" : "generated" },
      styles: {
        display: "block",
        position: "absolute",
        left: `${roundPx(arrowRect.x - visualRect.x)}px`,
        top: `${roundPx(arrowRect.y - visualRect.y)}px`,
        width: `${roundPx(arrowRect.width)}px`,
        height: `${roundPx(arrowRect.height)}px`,
        color: control.arrow ? getComputedStyleFor(control.arrow).color : firstVisibleColor(visualComputed.color, "rgb(134, 136, 143)"),
        overflow: "visible",
        boxSizing: "border-box",
      },
      rect: toElementRect(arrowRect),
      childNodes: [],
      content: createChevronSvg(control.arrow ? getComputedStyleFor(control.arrow).color : firstVisibleColor(visualComputed.color, "rgb(134, 136, 143)")),
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
    };
    childNodes.push(arrowLayer);
  }

  return {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    id: createId(control.root),
    tag: "DIV",
    attributes: {
      "data-h2d-select-control": "true",
      role: "combobox",
    },
    styles: {
      display: "block",
      position: "relative",
      boxSizing: "border-box",
      width: `${roundPx(visualRect.width)}px`,
      height: `${roundPx(visualRect.height)}px`,
      overflow: "hidden",
      backgroundColor: getBackgroundColor(visualComputed),
      ...border,
      borderTopLeftRadius: getRadius(visualComputed, "borderTopLeftRadius"),
      borderTopRightRadius: getRadius(visualComputed, "borderTopRightRadius"),
      borderBottomRightRadius: getRadius(visualComputed, "borderBottomRightRadius"),
      borderBottomLeftRadius: getRadius(visualComputed, "borderBottomLeftRadius"),
      fontFamily: visualComputed.fontFamily,
      fontSize: visualComputed.fontSize,
      fontWeight: visualComputed.fontWeight,
      lineHeight: visualComputed.lineHeight,
      color: visualComputed.color,
    },
    rect: rootRect,
    childNodes,
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
  };
}

function isSelectRootCandidate(element: Element): boolean {
  if (!isNodeVisible(element)) return false;
  if (isNonSelectPickerCandidate(element)) return false;

  const tag = element.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "SELECT") return false;
  if (tag === "SVG" || tag === "I" || tag === "UL" || tag === "LI") return false;

  const identity = getElementIdentity(element);
  const role = element.getAttribute("role")?.toLowerCase() || "";
  const ariaPopupValues = (element.getAttribute("aria-haspopup") || "").toLowerCase().split(/\s+/);
  const hasSelectClass = SELECT_ROOT_CLASS_PATTERN.test(identity);
  const hasDropdownClass = DROPDOWN_CLASS_PATTERN.test(identity);
  const hasSelectRole = role === "combobox";
  const input = findSelectInput(element);
  const arrow = findSelectArrow(element, element);
  const hasReadonlyInput = Boolean(input?.readOnly);
  const hasComboboxInput = Boolean(input?.getAttribute("role")?.toLowerCase() === "combobox");
  const hasFallbackVisualSelf = elementLooksLikeControlSurface(element);
  const hasDropdownFormContent = hasDropdownFormControlContent(element);
  const hasSelectPopup = ariaPopupValues.some((value) => value !== "menu" && SELECT_ARIA_POPUPS.has(value)) ||
    (ariaPopupValues.includes("menu") && hasFallbackVisualSelf && hasDropdownFormContent);
  const hasFormDropdownSignal =
    hasDropdownClass &&
    hasFallbackVisualSelf &&
    (hasReadonlyInput || hasComboboxInput || hasDropdownFormContent);
  const hasExplicitSelfSignal = hasSelectClass || hasSelectRole || hasSelectPopup || hasFormDropdownSignal;

  if (!hasExplicitSelfSignal && hasExplicitSelectDescendant(element)) {
    return false;
  }

  return (
    hasExplicitSelfSignal ||
    ((hasReadonlyInput || hasComboboxInput) && Boolean(arrow) && hasFallbackVisualSelf)
  );
}

function hasExplicitSelectDescendant(element: Element): boolean {
  return Array.from(element.querySelectorAll("*")).some((descendant) => {
    const tag = descendant.tagName.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "SELECT" || tag === "SVG" || tag === "I" || tag === "UL" || tag === "LI") {
      return false;
    }

    const identity = getElementIdentity(descendant);
    if (isInternalSelectIdentity(identity)) {
      return false;
    }

    const role = descendant.getAttribute("role")?.toLowerCase() || "";
    const ariaHasPopup = (descendant.getAttribute("aria-haspopup") || "").toLowerCase();
    return (
      SELECT_ROOT_CLASS_PATTERN.test(identity) ||
      role === "combobox" ||
      ariaHasPopup.split(/\s+/).some((value) => SELECT_ARIA_POPUPS.has(value))
    );
  });
}

function isInternalSelectIdentity(identity: string): boolean {
  return SELECT_INTERNAL_CLASS_PATTERN.test(identity) && !/(selector|selection|control|wrapper|trigger)/i.test(identity);
}

function isMultilineDisclosureSelectTrigger(
  root: Element,
  visualBox: Element,
  displayText: SelectDisplayText,
  input: HTMLInputElement | undefined,
): boolean {
  if (input) return false;
  if (displayText.isPlaceholder) return false;
  if (displayText.source !== "visible text") return false;

  const visualRect = visualBox.getBoundingClientRect();
  if (visualRect.height < 44) return false;

  const textRects = getVisibleTextNodeRects(root);
  if (textRects.length < 2) return false;

  const insideRects = textRects.filter((rect) => isRectMostlyInside(rect, visualRect));
  if (insideRects.length < 2) return false;

  const rowTops = new Set<number>();
  for (const rect of insideRects) {
    rowTops.add(Math.round(rect.top));
  }

  if (rowTops.size < 2) return false;

  const textTop = Math.min(...insideRects.map((rect) => rect.top));
  const textBottom = Math.max(...insideRects.map((rect) => rect.bottom));
  return textBottom - textTop >= Math.min(visualRect.height - 12, 28);
}

function isSplitActionPicker(
  root: Element,
  visualBox: Element,
  displayText: SelectDisplayText,
  arrow: Element | undefined,
): boolean {
  if (arrow) return false;
  if (displayText.source !== "visible text" || !displayText.sourceElement) return false;

  const placeholderElement = findPlaceholderElement(root);
  if (!placeholderElement) return false;

  const visualRect = visualBox.getBoundingClientRect();
  const placeholderRect = placeholderElement.getBoundingClientRect();
  const actionRect = displayText.sourceElement.getBoundingClientRect();
  if (!isRectMostlyInside(placeholderRect, visualRect) || !isRectMostlyInside(actionRect, visualRect)) return false;

  const placeholderCenterX = placeholderRect.left + placeholderRect.width / 2;
  const actionCenterX = actionRect.left + actionRect.width / 2;
  const leftZoneRight = visualRect.left + visualRect.width * 0.55;
  const rightZoneLeft = visualRect.left + visualRect.width * 0.55;
  const horizontallySeparated = placeholderCenterX < leftZoneRight && actionCenterX > rightZoneLeft;
  const actionIsCompact = actionRect.width <= Math.max(96, visualRect.width * 0.35);

  return horizontallySeparated && actionIsCompact;
}

function isCompactInlineFilterSelectTrigger(
  root: Element,
  visualBox: Element,
  displayText: SelectDisplayText,
): boolean {
  if (displayText.source !== "visible text" || displayText.isPlaceholder) return false;

  const rootRect = root.getBoundingClientRect();
  const visualRect = visualBox.getBoundingClientRect();
  const triggerRect = rootRect.width >= visualRect.width && rootRect.height >= visualRect.height
    ? rootRect
    : visualRect;
  if (triggerRect.width < 40 || triggerRect.width > 180) return false;
  if (triggerRect.height < 18 || triggerRect.height > 34) return false;

  const compactText = displayText.text.replace(/\s+/g, "");
  if (!compactText || compactText.length > 16) return false;
  if (/^(请选择|请输入|选择|搜索|全部)$/.test(compactText)) return false;

  return hasCompactInlineFilterRowContext(root, triggerRect);
}

function hasCompactInlineFilterRowContext(root: Element, triggerRect: DOMRect): boolean {
  let ancestor = root.parentElement;
  let depth = 0;

  while (ancestor && depth < 24) {
    const ancestorRect = ancestor.getBoundingClientRect();
    if (isCompactInlineFilterRowRect(ancestorRect, triggerRect)) {
      const rowEntries = getVisibleTextNodeEntries(ancestor).filter((entry) => (
        entry.rect.height > 0 &&
        entry.rect.height <= 24 &&
        Math.abs(getRectCenterY(entry.rect) - getRectCenterY(triggerRect)) <= 8
      ));
      const labels = new Set(rowEntries.map((entry) => entry.text.replace(/\s+/g, "")).filter(Boolean));
      if (labels.size >= 4) return true;

      if (countCompactInlineRowTriggers(ancestor, triggerRect) >= 3) return true;
    }

    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return false;
}

function isCompactInlineFilterRowRect(rowRect: DOMRect, triggerRect: DOMRect): boolean {
  if (rowRect.width < 240 || rowRect.width < triggerRect.width * 3) return false;
  if (rowRect.height < triggerRect.height || rowRect.height > 72) return false;
  if (triggerRect.top < rowRect.top - 2 || triggerRect.bottom > rowRect.bottom + 2) return false;
  return true;
}

function countCompactInlineRowTriggers(container: Element, triggerRect: DOMRect): number {
  const positions = new Set<number>();

  for (const candidate of Array.from(container.querySelectorAll("*"))) {
    if (!isNodeVisible(candidate)) continue;

    const rect = candidate.getBoundingClientRect();
    if (!isCompactInlineTriggerRect(rect, triggerRect)) continue;

    const text = getVisibleText(candidate).replace(/\s+/g, "");
    if (!text || text.length > 20) continue;
    if (/^(请选择|请输入|选择|搜索|全部)$/.test(text)) continue;

    positions.add(Math.round(rect.left / 4) * 4);
  }

  return positions.size;
}

function isCompactInlineTriggerRect(rect: DOMRect, triggerRect: DOMRect): boolean {
  if (rect.width < 32 || rect.width > 220) return false;
  if (rect.height < 16 || rect.height > 36) return false;
  if (Math.abs(getRectCenterY(rect) - getRectCenterY(triggerRect)) > 8) return false;
  return rect.right > triggerRect.left - 320 && rect.left < triggerRect.right + 720;
}

function getRectCenterY(rect: DOMRect): number {
  return rect.top + rect.height / 2;
}

function hasExpandedCompositeSelectContent(root: Element, visualBox: Element): boolean {
  const visualRect = visualBox.getBoundingClientRect();
  const textRects = getVisibleTextNodeRects(root)
    .filter((rect) => isRectSeparatedFromControl(rect, visualRect) && isRectInCurrentViewport(rect, root));

  if (hasExpandedRectDistribution(textRects, visualRect)) return true;

  const optionRects = getVisibleOptionLikeRects(root)
    .filter((rect) => isRectSeparatedFromControl(rect, visualRect) && isRectInCurrentViewport(rect, root));
  return hasExpandedRectDistribution(optionRects, visualRect);
}

function hasExpandedRectDistribution(rects: DOMRect[], visualRect: DOMRect): boolean {
  if (rects.length === 0) return false;

  const tallRect = rects.some((rect) => rect.height >= Math.max(48, visualRect.height * 1.25));
  if (tallRect) return true;

  const rowTops = new Set<number>();
  for (const rect of rects) {
    rowTops.add(Math.round(rect.top / 4) * 4);
  }

  if (rowTops.size < 3) return false;

  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return bottom - top >= Math.max(48, visualRect.height * 1.25);
}

function getVisibleOptionLikeRects(root: Element): DOMRect[] {
  const rects: DOMRect[] = [];

  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (!isNodeVisible(element) || isSelectDecorationElement(element)) continue;

    const tag = element.tagName.toUpperCase();
    const role = element.getAttribute("role")?.toLowerCase() || "";
    const identity = getElementIdentity(element);
    const optionLike =
      tag === "LI" ||
      role === "option" ||
      role === "menuitem" ||
      role === "treeitem" ||
      /(^|[-_\s])(option|menu-item|list-item|tree-node|treeitem)([-_\s]|$)/i.test(identity);

    if (!optionLike) continue;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    rects.push(rect);
  }

  return rects;
}

function isRectSeparatedFromControl(rect: DOMRect, visualRect: DOMRect): boolean {
  const margin = 4;
  return (
    rect.bottom <= visualRect.top - margin ||
    rect.top >= visualRect.bottom + margin ||
    rect.right <= visualRect.left - margin ||
    rect.left >= visualRect.right + margin
  );
}

function isRectInCurrentViewport(rect: DOMRect, root: Element): boolean {
  const view = root.ownerDocument.defaultView;
  if (!view) return true;

  const margin = 8;
  return (
    rect.right > -margin &&
    rect.left < view.innerWidth + margin &&
    rect.bottom > -margin &&
    rect.top < view.innerHeight + margin
  );
}

function getVisibleTextNodeRects(root: Element): DOMRect[] {
  return getVisibleTextNodeEntries(root).map((entry) => entry.rect);
}

function getVisibleTextNodeEntries(root: Element): Array<{ text: string; rect: DOMRect }> {
  const entries: Array<{ text: string; rect: DOMRect }> = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node) {
    const text = node.textContent || "";
    const normalizedText = text.replace(/\s+/g, " ").trim();
    const parent = node.parentElement;
    if (normalizedText && parent && isNodeVisible(parent) && !isSelectDecorationElement(parent)) {
      const rect = getTextRect(node);
      if (rect.width > 0 && rect.height > 0) {
        entries.push({
          text: normalizedText,
          rect: new DOMRect(rect.x, rect.y, rect.width, rect.height),
        });
      }
    }
    node = walker.nextNode();
  }

  return entries;
}

function isSelectDecorationElement(element: Element): boolean {
  const identity = getElementIdentity(element);
  if (ARROW_CLASS_PATTERN.test(identity)) return true;

  const tag = element.tagName.toUpperCase();
  return tag === "SVG" || tag === "I" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function isRectMostlyInside(rect: DOMRect, container: DOMRect): boolean {
  const left = Math.max(rect.left, container.left);
  const top = Math.max(rect.top, container.top);
  const right = Math.min(rect.right, container.right);
  const bottom = Math.min(rect.bottom, container.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return false;

  const area = rect.width * rect.height;
  return area <= 0 || (width * height) / area >= 0.6;
}

function elementLooksLikeControlSurface(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (!isReasonableControlRect(rect) || rect.height > 60) return false;

  const computed = getComputedStyleFor(element);
  return (
    SELECT_VISUAL_CLASS_PATTERN.test(getElementIdentity(element)) ||
    hasVisibleBorder(computed) ||
    Boolean(computed.boxShadow && computed.boxShadow !== "none") ||
    hasVisibleRadius(computed)
  );
}

function hasDropdownFormControlContent(element: Element): boolean {
  return Boolean(findSelectInput(element) || findPlaceholderElement(element));
}

function isNonSelectPickerCandidate(element: Element): boolean {
  const identity = getElementIdentity(element);
  if (/(^|[-_\s])(date|time|daterange|timerange|range|calendar|avatar|user)([-_\s]|$)/i.test(identity)) {
    return true;
  }

  if (isUploadLikeControl(element)) return true;

  if (isCompactMediaDropdown(element)) return true;

  if (isInsideDateTimePicker(element)) return true;

  const inputs = Array.from(element.querySelectorAll("input")).filter((input) => {
    const type = input.getAttribute("type")?.toLowerCase() || "text";
    return type !== "hidden";
  });
  if (inputs.length > 1) return true;

  const rect = element.getBoundingClientRect();
  const hasOnlyMediaAndArrow =
    rect.width <= 80 &&
    rect.height <= 80 &&
    (element.querySelector("img, picture, canvas") || /avatar|user/i.test(element.innerHTML));

  return Boolean(hasOnlyMediaAndArrow);
}

function isUploadLikeControl(element: Element): boolean {
  if (element.querySelector("input[type='file'], input[type=\"file\"]")) return true;

  const identity = getElementIdentity(element);
  const text = (element.textContent || "").replace(/\s+/g, "");
  if (!text) return false;

  const hasUploadIdentity = /(^|[-_\s])(upload|uploader|file-upload|attachment)([-_\s]|$)/i.test(identity);
  const hasUploadText = /点击上传|上传文件|选择文件|upload/i.test(text);
  const hasHelperText = /Excel|文件|表格|合并|分别上传|format/i.test(text);
  return hasUploadText && (hasUploadIdentity || hasHelperText);
}

function isCompactMediaDropdown(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width > 140 || rect.height > 90) return false;
  if (findSelectInput(element) || findPlaceholderElement(element)) return false;

  const hasImageLikeMedia = Boolean(element.querySelector("img, picture, canvas"));
  const hasOnlyIconAndText =
    !hasImageLikeMedia &&
    Boolean(element.querySelector("svg, i")) &&
    (element.textContent || "").trim().length <= 16 &&
    /avatar|user|profile|account|dropdown|trigger|admin|管理员/i.test(`${getElementIdentity(element)} ${element.textContent || ""}`);

  return hasImageLikeMedia || hasOnlyIconAndText;
}

function isInsideDateTimePicker(element: Element): boolean {
  const inputs = getVisibleInputs(element);
  const hasDateTimeInput = inputs.some(isDateTimeInput);
  const hasDateTimeIdentity = /(^|[-_\s])(date|time|daterange|timerange|range|calendar)([-_\s]|$)/i.test(getElementIdentity(element));
  if (hasDateTimeInput && (hasDateTimeIdentity || hasCalendarSignal(element))) return true;

  let ancestor = element.parentElement;
  let depth = 0;
  while (ancestor && depth < 4) {
    const ancestorInputs = getVisibleInputs(ancestor);
    const ancestorHasDateTimeInput = ancestorInputs.some(isDateTimeInput);
    const ancestorIdentity = getElementIdentity(ancestor);
    const ancestorRect = ancestor.getBoundingClientRect();
    const ancestorLooksLikeCompactControl = ancestorRect.width <= 640 && ancestorRect.height <= 80;
    const ancestorLooksLikeDatePicker =
      /(^|[-_\s])(date|time|daterange|timerange|range|calendar)([-_\s]|$)/i.test(ancestorIdentity) ||
      (/(^|[-_\s])picker([-_\s]|$)/i.test(ancestorIdentity) && ancestorHasDateTimeInput) ||
      (ancestorLooksLikeCompactControl && hasCalendarSignal(ancestor));

    if (ancestorHasDateTimeInput && ancestorLooksLikeDatePicker) return true;

    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return false;
}

function getVisibleInputs(element: Element): HTMLInputElement[] {
  return Array.from(element.querySelectorAll("input")).filter((input) => {
    const type = input.getAttribute("type")?.toLowerCase() || "text";
    return type !== "hidden";
  }) as HTMLInputElement[];
}

function isDateTimeInput(input: HTMLInputElement): boolean {
  const type = input.getAttribute("type")?.toLowerCase() || "text";
  if (/^(date|datetime-local|time|month|week)$/.test(type)) return true;

  const text = [
    input.placeholder,
    input.getAttribute("aria-label") || "",
    input.getAttribute("title") || "",
  ].join(" ");
  return /(日期|时间|开始|结束|date|time|start|end)/i.test(text);
}

function hasCalendarSignal(element: Element): boolean {
  return Array.from(element.querySelectorAll("*")).some((candidate) => {
    const tag = candidate.tagName.toUpperCase();
    const identity = getElementIdentity(candidate);
    const ariaLabel = candidate.getAttribute("aria-label") || "";
    const dataIcon = candidate.getAttribute("data-icon") || "";
    return (
      /(^|[-_\s])(calendar|datepicker|timepicker|picker-suffix)([-_\s]|$)/i.test(identity) ||
      /calendar|date|time/i.test(ariaLabel) ||
      /calendar|date|time/i.test(dataIcon) ||
      (tag === "SVG" && /calendar|date|time/i.test(`${ariaLabel} ${dataIcon} ${identity}`))
    );
  });
}

function hasCanonicalSelectAncestor(element: Element, visualBox: Element): boolean {
  if (element === visualBox) return false;

  let ancestor = element.parentElement;

  while (ancestor) {
    if (isSelectRootCandidate(ancestor)) {
      const ancestorVisualBox = findSelectVisualBox(ancestor);
      if (ancestorVisualBox === visualBox || ancestorVisualBox.contains(visualBox) || visualBox.contains(ancestorVisualBox)) {
        return true;
      }
    }
    ancestor = ancestor.parentElement;
  }

  return false;
}

function getVisualBoxScore(element: Element, computed: CSSStyleDeclaration, rootRect: DOMRect): number {
  const rect = element.getBoundingClientRect();
  const identity = getElementIdentity(element);
  const hasCommonClass = SELECT_VISUAL_CLASS_PATTERN.test(identity);
  const hasBorder = hasVisibleBorder(computed);
  const hasBackground = isVisibleColor(computed.backgroundColor);
  const hasRadius = hasVisibleRadius(computed);
  const hasShadow = computed.boxShadow && computed.boxShadow !== "none";
  const closeToRoot = rect.width >= rootRect.width * 0.7 && rect.height <= Math.max(rootRect.height + 4, 36);
  const containsDisplay = Boolean(findPlaceholderElement(element) || findSelectInput(element));
  const containsArrow = Boolean(findSelectArrow(element, element));

  let score = 0;
  if (element === (element.ownerDocument?.documentElement ?? null)) score -= 100;
  if (hasCommonClass) score += 60;
  if (hasBorder) score += 50;
  if (hasShadow) score += 35;
  if (hasRadius) score += 20;
  if (hasBackground) score += 10;
  if (closeToRoot) score += 20;
  if (containsDisplay) score += 12;
  if (containsArrow) score += 12;
  if (SELECT_ROOT_CLASS_PATTERN.test(identity)) score += 8;

  if (!hasCommonClass && !hasBorder && !hasShadow && !hasRadius && !hasBackground) return 0;
  return score;
}

function findSelectedVisibleText(root: Element): SelectDisplayText {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    const identity = getElementIdentity(element);
    if (PLACEHOLDER_CLASS_PATTERN.test(identity)) continue;
    if (SELECT_INTERNAL_CLASS_PATTERN.test(identity) && !/selected|value|label|rendered/i.test(identity)) continue;
    if (findPlaceholderElement(element)) continue;
    if (!isNodeVisible(element)) continue;

    const text = getVisibleText(element);
    if (!text || isOnlyArrowText(text)) continue;

    return {
      text,
      source: "visible text",
      sourceElement: element,
      isPlaceholder: false,
    };
  }

  return { text: "", source: "empty", isPlaceholder: false };
}

function findPlaceholderElement(root: Element): Element | undefined {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (!PLACEHOLDER_CLASS_PATTERN.test(getElementIdentity(element))) continue;
    if (!isNodeVisible(element)) continue;
    if (getVisibleText(element)) return element;
  }

  return undefined;
}

function findSelectInput(root: Element): HTMLInputElement | undefined {
  return Array.from(root.querySelectorAll("input")).find((input) => {
    const type = input.getAttribute("type")?.toLowerCase() || "text";
    return type !== "hidden";
  }) as HTMLInputElement | undefined;
}

function computeTextRect(
  control: SelectControl,
  visualComputed: CSSStyleDeclaration,
  textComputed: CSSStyleDeclaration,
): DOMRect {
  const visualRect = control.visualBox.getBoundingClientRect();
  const sourceRect = control.displayText.sourceElement?.getBoundingClientRect();
  const lineHeight = getLineHeight(textComputed, visualRect.height);

  if (sourceRect && sourceRect.width > 0 && sourceRect.height > 0) {
    if (control.displayText.source === "input.placeholder") {
      const fontSize = parsePx(textComputed.fontSize, 14);
      const textHeight = Math.min(visualRect.height, Math.max(fontSize * 1.2, fontSize));
      const arrowSpace = Math.max(32, control.arrowRect.width + 16);
      const width = Math.max(0, Math.min(sourceRect.width, visualRect.right - sourceRect.x - arrowSpace));
      const y = visualRect.y + Math.max(0, (visualRect.height - textHeight) / 2) + getSelectTextYOffset(visualRect);
      return new DOMRect(sourceRect.x, y, width, textHeight);
    }

    const sourceLooksLikeWholeBox =
      Math.abs(sourceRect.x - visualRect.x) <= 2 &&
      Math.abs(sourceRect.width - visualRect.width) <= 4;
    const fontSize = parsePx(textComputed.fontSize, parsePx(visualComputed.fontSize, 14));
    const textHeight = Math.min(visualRect.height, Math.max(fontSize * 1.2, Math.min(lineHeight, fontSize * 1.6)));
    const arrowSpace = Math.max(32, control.arrowRect.width + 16);
    const paddingLeft = getSelectTextPaddingLeft(visualComputed);
    const sourceX = sourceLooksLikeWholeBox ? visualRect.x + paddingLeft : Math.max(sourceRect.x, visualRect.x + paddingLeft);
    const width = sourceLooksLikeWholeBox
      ? Math.max(0, visualRect.width - paddingLeft - parsePx(visualComputed.paddingRight, 8) - arrowSpace)
      : Math.max(0, Math.min(sourceRect.right, visualRect.right - arrowSpace) - sourceX);
    const y = visualRect.y + Math.max(0, (visualRect.height - textHeight) / 2) + getSelectTextYOffset(visualRect);
    return new DOMRect(sourceX, y, width, textHeight);
  }

  const paddingLeft = getSelectTextPaddingLeft(visualComputed);
  const paddingRight = getSelectTextPaddingRight(visualComputed);
  const arrowSpace = Math.max(32, control.arrowRect.width + 16);
  const x = visualRect.x + paddingLeft;
  const y = visualRect.y + Math.max(0, (visualRect.height - lineHeight) / 2) + getSelectTextYOffset(visualRect);
  const width = Math.max(0, visualRect.width - paddingLeft - paddingRight - arrowSpace);
  const height = Math.min(visualRect.height, lineHeight);

  return new DOMRect(x, y, width, height);
}

function computeArrowRect(arrow: Element | undefined, visualBox: Element): DOMRect {
  const visualRect = visualBox.getBoundingClientRect();
  if (arrow) {
    return normalizeArrowRect(arrow.getBoundingClientRect(), visualRect);
  }

  return normalizeArrowRect(undefined, visualRect);
}

function normalizeArrowRect(sourceRect: DOMRect | undefined, visualRect: DOMRect): DOMRect {
  const sourceSize = sourceRect ? Math.max(sourceRect.width, sourceRect.height) : 0;
  const size = Math.min(16, Math.max(14, sourceSize || visualRect.height - 18));
  const rightInset = sourceRect ? clamp(visualRect.right - sourceRect.right, 6, 12) : 8;
  return clampArrowRect(
    new DOMRect(
      visualRect.right - rightInset - size,
      visualRect.y + (visualRect.height - size) / 2,
      size,
      size,
    ),
    visualRect,
  );
}

function clampArrowRect(rect: DOMRect, visualRect: DOMRect): DOMRect {
  const width = Math.max(8, Math.min(rect.width || 12, Math.max(8, visualRect.width - 8)));
  const height = Math.max(8, Math.min(rect.height || 12, Math.max(8, visualRect.height - 4)));
  const x = clamp(rect.x, visualRect.x + 4, visualRect.right - width - 8);
  const y = clamp(rect.y, visualRect.y + 2, visualRect.bottom - height - 2);
  return new DOMRect(x, y, width, height);
}

function getBorderStyles(element: Element, computed: CSSStyleDeclaration): Record<string, string> {
  if (hasVisibleBorder(computed)) {
    return {
      borderTopWidth: computed.borderTopWidth,
      borderRightWidth: computed.borderRightWidth,
      borderBottomWidth: computed.borderBottomWidth,
      borderLeftWidth: computed.borderLeftWidth,
      borderTopStyle: computed.borderTopStyle,
      borderRightStyle: computed.borderRightStyle,
      borderBottomStyle: computed.borderBottomStyle,
      borderLeftStyle: computed.borderLeftStyle,
      borderTopColor: computed.borderTopColor,
      borderRightColor: computed.borderRightColor,
      borderBottomColor: computed.borderBottomColor,
      borderLeftColor: computed.borderLeftColor,
    };
  }

  const color = findNearbyInputBorderColor(element) || "rgb(230, 231, 235)";
  return {
    borderTopWidth: "1px",
    borderRightWidth: "1px",
    borderBottomWidth: "1px",
    borderLeftWidth: "1px",
    borderTopStyle: "solid",
    borderRightStyle: "solid",
    borderBottomStyle: "solid",
    borderLeftStyle: "solid",
    borderTopColor: color,
    borderRightColor: color,
    borderBottomColor: color,
    borderLeftColor: color,
  };
}

function getDisplayTextColor(control: SelectControl, textComputed: CSSStyleDeclaration, visualComputed: CSSStyleDeclaration): string {
  if (control.displayText.source === "input.placeholder" && control.input) {
    const placeholderComputed = getComputedStyleFor(control.input, "::placeholder");
    return firstVisibleColor(placeholderComputed.color, "rgb(134, 144, 156)");
  }

  if (control.displayText.isPlaceholder) {
    return firstVisibleColor(textComputed.color, "rgb(176, 178, 184)");
  }

  const color = firstVisibleColor(textComputed.color, visualComputed.color);
  if (!isMutedPlaceholderLikeColor(color)) return color;

  return firstStrongTextColor(
    getAncestorTextColor(control.displayText.sourceElement),
    getAncestorTextColor(control.visualBox),
    control.visualBox.ownerDocument?.body ? getComputedStyleFor(control.visualBox.ownerDocument.body).color : "",
    "rgb(31, 35, 41)",
  );
}

function getAncestorTextColor(element: Element | undefined): string {
  let current = element?.parentElement;
  let depth = 0;
  while (current && depth < 6) {
    const color = getComputedStyleFor(current).color;
    if (!isMutedPlaceholderLikeColor(color)) return color;
    current = current.parentElement;
    depth += 1;
  }

  return "";
}

function findNearbyInputBorderColor(element: Element): string | undefined {
  const doc = element.ownerDocument ?? document;
  const rect = element.getBoundingClientRect();
  let best: { color: string; distance: number } | undefined;

  for (const candidate of Array.from(doc.querySelectorAll("input, textarea, select"))) {
    if (!(candidate instanceof Element) || candidate === element || !isNodeVisible(candidate)) continue;

    const candidateRect = candidate.getBoundingClientRect();
    if (!isReasonableControlRect(candidateRect)) continue;

    const computed = getComputedStyleFor(candidate);
    if (!hasVisibleBorder(computed)) continue;

    const color = firstVisibleColor(computed.borderTopColor, computed.borderRightColor, computed.borderBottomColor, computed.borderLeftColor);
    const distance =
      Math.abs(candidateRect.x + candidateRect.width / 2 - (rect.x + rect.width / 2)) +
      Math.abs(candidateRect.y + candidateRect.height / 2 - (rect.y + rect.height / 2));

    if (!best || distance < best.distance) {
      best = { color, distance };
    }
  }

  return best?.color;
}

function logSelectControlDebug(control: SelectControl): void {
  const view = control.root.ownerDocument.defaultView ?? window;
  if (!(view as Window & { __H2D_DEBUG_FORM_CONTROLS?: boolean }).__H2D_DEBUG_FORM_CONTROLS) return;
  if (debugLoggedCount >= 20 || debugLoggedControls.has(control.root)) return;

  debugLoggedControls.add(control.root);
  debugLoggedCount += 1;

  const input = control.input;
  const arrow = control.arrow;
  console.debug("[H2D form-control]", {
    index: debugLoggedCount,
    root: describeElement(control.root),
    visualBox: {
      ...describeElement(control.visualBox),
      computedWidth: getComputedStyleFor(control.visualBox).width,
      computedHeight: getComputedStyleFor(control.visualBox).height,
    },
    input: input
      ? {
        value: input.value,
        placeholder: input.placeholder,
        readonly: input.readOnly,
        rect: rectToPlain(input.getBoundingClientRect()),
      }
      : null,
    placeholderSource: control.displayText,
    arrow: arrow
      ? {
        className: getClassName(arrow),
        tagName: arrow.tagName,
        rect: rectToPlain(arrow.getBoundingClientRect()),
        insideVisualBox: control.arrowInside,
      }
      : {
        generated: true,
        rect: rectToPlain(control.arrowRect),
        insideVisualBox: true,
      },
  });
}

function describeElement(element: Element): Record<string, unknown> {
  const computed = getComputedStyleFor(element);
  return {
    tagName: element.tagName,
    className: getClassName(element),
    role: element.getAttribute("role"),
    ariaHasPopup: element.getAttribute("aria-haspopup"),
    rect: rectToPlain(element.getBoundingClientRect()),
    computed: {
      display: computed.display,
      position: computed.position,
      boxSizing: computed.boxSizing,
      padding: `${computed.paddingTop} ${computed.paddingRight} ${computed.paddingBottom} ${computed.paddingLeft}`,
      border: `${computed.borderTopWidth} ${computed.borderTopStyle} ${computed.borderTopColor}`,
      borderRadius: `${computed.borderTopLeftRadius} ${computed.borderTopRightRadius} ${computed.borderBottomRightRadius} ${computed.borderBottomLeftRadius}`,
      background: computed.backgroundColor,
      lineHeight: computed.lineHeight,
      fontSize: computed.fontSize,
    },
  };
}

function getVisibleText(element: Element): string {
  return Array.from(element.childNodes)
    .map((node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
      if (node.nodeType === Node.ELEMENT_NODE) {
        const child = node as Element;
        if (!isNodeVisible(child)) return "";
        if (ARROW_CLASS_PATTERN.test(getElementIdentity(child))) return "";
        return getVisibleText(child);
      }
      return "";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function getElementIdentity(element: Element): string {
  return `${getClassName(element)} ${element.id || ""} ${element.getAttribute("data-role") || ""}`;
}

function getClassName(element: Element): string {
  return String((element as HTMLElement | SVGElement).className || "");
}

function isReasonableControlRect(rect: DOMRect): boolean {
  return rect.width >= 40 && rect.height >= 16 && rect.height <= 120;
}

function isOffscreenSyntheticControlCandidate(root: Element, rect: DOMRect): boolean {
  if (rect.left >= -1 && rect.top >= -1) return false;
  if (rect.width > 220 || rect.height > 32) return false;

  const view = root.ownerDocument.defaultView;
  if (!view) return false;

  const visibleLeft = Math.max(rect.left, 0);
  const visibleTop = Math.max(rect.top, 0);
  const visibleRight = Math.min(rect.right, view.innerWidth);
  const visibleBottom = Math.min(rect.bottom, view.innerHeight);
  const visibleWidth = Math.max(0, visibleRight - visibleLeft);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  const visibleArea = visibleWidth * visibleHeight;
  const totalArea = rect.width * rect.height;
  if (totalArea <= 0) return true;

  return visibleArea / totalArea < 0.75;
}

function hasVisibleBorder(computed: CSSStyleDeclaration): boolean {
  return [
    [computed.borderTopWidth, computed.borderTopStyle],
    [computed.borderRightWidth, computed.borderRightStyle],
    [computed.borderBottomWidth, computed.borderBottomStyle],
    [computed.borderLeftWidth, computed.borderLeftStyle],
  ].some(([width, style]) => parsePx(width, 0) > 0 && style !== "none" && style !== "hidden");
}

function hasVisibleRadius(computed: CSSStyleDeclaration): boolean {
  return [
    computed.borderTopLeftRadius,
    computed.borderTopRightRadius,
    computed.borderBottomRightRadius,
    computed.borderBottomLeftRadius,
  ].some((radius) => parsePx(radius, 0) > 0);
}

function isVisibleColor(color: string): boolean {
  return Boolean(color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)");
}

function isNearWhiteColor(color: string): boolean {
  const channels = parseRgbChannels(color);
  if (!channels) return false;

  const [red, green, blue, alpha] = channels;
  if (alpha != null && alpha < 0.1) return false;
  return red >= 245 && green >= 245 && blue >= 245;
}

function isLikelyAccentColor(color: string): boolean {
  const channels = parseRgbChannels(color);
  if (!channels) return false;

  const [red, green, blue, alpha] = channels;
  if (alpha != null && alpha < 0.2) return false;

  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  return max - min >= 32 && max >= 96;
}

function getBackgroundColor(computed: CSSStyleDeclaration): string {
  return isVisibleColor(computed.backgroundColor) ? computed.backgroundColor : "rgb(255, 255, 255)";
}

function getRadius(computed: CSSStyleDeclaration, key: keyof CSSStyleDeclaration): string {
  const value = String(computed[key] || "");
  return value && value !== "0px" ? value : "5px";
}

function getLineHeight(computed: CSSStyleDeclaration, fallbackHeight: number): number {
  const parsed = parsePx(computed.lineHeight, NaN);
  if (Number.isFinite(parsed)) return parsed;

  const fontSize = parsePx(computed.fontSize, 14);
  return Math.min(fallbackHeight, fontSize * 1.4);
}

function getSelectTextPaddingLeft(computed: CSSStyleDeclaration): number {
  const parsed = parsePx(computed.paddingLeft, 0);
  return parsed > 2 ? parsed : 8;
}

function getSelectTextPaddingRight(computed: CSSStyleDeclaration): number {
  const parsed = parsePx(computed.paddingRight, 0);
  return parsed > 2 ? parsed : 8;
}

function getSelectTextYOffset(visualRect: DOMRect): number {
  return visualRect.height <= 40 ? 1 : 0;
}

function createChevronSvg(color: string): string {
  const stroke = escapeSvgAttribute(firstVisibleColor(color, "rgb(134, 136, 143)"));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path d="M3.5 5.25 7 8.75 10.5 5.25" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function escapeSvgAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function parsePx(value: string, fallback: number): number {
  const parsed = parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstVisibleColor(...colors: string[]): string {
  return colors.find(isVisibleColor) || "rgb(134, 136, 143)";
}

function firstStrongTextColor(...colors: string[]): string {
  return colors.find((color) => isVisibleColor(color) && !isMutedPlaceholderLikeColor(color)) || "rgb(31, 35, 41)";
}

function isMutedPlaceholderLikeColor(color: string): boolean {
  const channels = parseRgbChannels(color);
  if (!channels) return false;

  const [red, green, blue, alpha] = channels;
  if (alpha != null && alpha < 0.75) return true;

  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const average = (red + green + blue) / 3;
  return max - min <= 24 && average >= 145;
}

function parseRgbChannels(color: string): [number, number, number, number?] | null {
  const match = color.match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;

  const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length < 3 || parts.some((part, index) => index < 3 && !Number.isFinite(part))) return null;

  return [parts[0], parts[1], parts[2], Number.isFinite(parts[3]) ? parts[3] : undefined];
}

function isOnlyArrowText(text: string): boolean {
  return /^[⌄⌃⌵⌄˅∨vV<>›‹\s]+$/.test(text);
}

function isRectInside(rect: DOMRect, container: DOMRect): boolean {
  return (
    rect.left >= container.left &&
    rect.right <= container.right &&
    rect.top >= container.top &&
    rect.bottom <= container.bottom
  );
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

function rectToPlain(rect: DOMRect): Record<string, number> {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function roundPx(value: number): number {
  return Math.round(value * 1000) / 1000;
}
