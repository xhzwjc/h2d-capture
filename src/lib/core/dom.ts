/**
 * Cross-document DOM helpers.
 *
 * Same-origin iframes have their own Window and DOM constructors. Code running
 * in the parent frame must use the node's ownerDocument/defaultView for
 * getComputedStyle, ranges, and instanceof checks.
 */

export function getNodeDocument(node: Node): Document {
  return node.ownerDocument ?? document;
}

export function getNodeWindow(node: Node): Window {
  return getNodeDocument(node).defaultView ?? window;
}

export function getComputedStyleFor(element: Element, pseudo?: string): CSSStyleDeclaration {
  return getNodeWindow(element).getComputedStyle(element, pseudo);
}

export function isElementNode(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

export function isTextNode(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

export function isInstanceOfOwner<T>(
  value: unknown,
  owner: Node,
  ctorName: string,
): value is T {
  const ctor = (getNodeWindow(owner) as unknown as Record<string, unknown>)[ctorName];
  return typeof ctor === "function" && value instanceof ctor;
}

export function isHtmlElement(element: Element | Text): element is HTMLElement {
  return isInstanceOfOwner<HTMLElement>(element, element, "HTMLElement");
}

export function isSvgSvgElement(element: Element | Text): element is SVGSVGElement {
  return isInstanceOfOwner<SVGSVGElement>(element, element, "SVGSVGElement");
}

export function isSvgGraphicsElement(element: Element | Text): element is SVGGraphicsElement {
  return isInstanceOfOwner<SVGGraphicsElement>(element, element, "SVGGraphicsElement");
}

export function isMathElement(element: Element | Text): element is MathMLElement {
  return isInstanceOfOwner<MathMLElement>(element, element, "MathMLElement");
}

export function isElementLike(value: Element | Text): value is Element {
  return value.nodeType === Node.ELEMENT_NODE;
}
