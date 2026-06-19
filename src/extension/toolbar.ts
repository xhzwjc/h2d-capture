(() => {
  type CaptureMode = "viewport" | "full-page";

  const HOST_ID = "__figma_capture_ext_toolbar__";

  // Detect Firefox in MAIN world via CSS/navigator (browser.runtime.getBrowserInfo
  // is not available in MAIN world, only in content scripts).
  const isFirefox = navigator.userAgent.includes("Firefox");
  const isFrame = (() => {
    try {
      return window.top !== window;
    } catch {
      return true;
    }
  })();

  // Don't create toolbar twice
  if (document.getElementById(HOST_ID)) return;

  // --- Shadow DOM host ---
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("data-h2d-ignore", "true");
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "closed" });
  const toolbarActions = new Map<HTMLButtonElement, () => void>();
  let toolbarActivationShieldUntil = 0;
  let toolbarActivationPointerId: number | null = null;

  function consumeToolbarEvent(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  }

  function isElementVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const computed = getComputedStyle(element);
    return computed.display !== "none" && computed.visibility !== "hidden";
  }

  function findToolbarActionAtPoint(x: number, y: number): (() => void) | null {
    for (const [button, action] of toolbarActions) {
      if (!isElementVisible(button) || button.classList.contains("disabled")) continue;
      const rect = button.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return action;
      }
    }

    return null;
  }

  function shouldShieldToolbarFollowup(event: Event): boolean {
    if (Date.now() > toolbarActivationShieldUntil) return false;
    if (toolbarActivationPointerId === null || !("pointerId" in event)) return true;
    return (event as PointerEvent).pointerId === toolbarActivationPointerId;
  }

  function onWindowToolbarEvent(event: Event): void {
    if (event.type === "pointerdown" && event instanceof PointerEvent && event.button === 0) {
      const action = findToolbarActionAtPoint(event.clientX, event.clientY);
      if (!action) return;

      toolbarActivationPointerId = event.pointerId;
      toolbarActivationShieldUntil = Date.now() + 1200;
      consumeToolbarEvent(event);
      action();
      return;
    }

    if (shouldShieldToolbarFollowup(event)) {
      consumeToolbarEvent(event);
    }
  }

  const toolbarShieldEvents = ["pointerdown", "mousedown", "mouseup", "pointerup", "pointercancel", "click"] as const;
  const toolbarShieldOptions: AddEventListenerOptions = { capture: true, passive: false };
  for (const eventName of toolbarShieldEvents) {
    window.addEventListener(eventName, onWindowToolbarEvent, toolbarShieldOptions);
  }

  // --- Styles ---
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }

    .panel {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      background: #1e1e1e;
      border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08);
      font-family: "Inter", -apple-system, system-ui, sans-serif;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.4;
      color: rgba(255,255,255,0.9);
      user-select: none;
      animation: slideIn 0.2s ease-out;
      overflow: visible;
    }

    @keyframes slideIn {
      from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }

    /* Drag handle */
    .drag-handle {
      display: flex;
      justify-content: center;
      padding: 6px 0 2px;
      cursor: grab;
    }
    .drag-handle:hover .drag-handle-icon { background: rgba(255,255,255,0.3); }
    .drag-handle:active { cursor: grabbing; }
    .drag-handle-icon {
      width: 32px;
      height: 4px;
      border-radius: 2px;
      background: rgba(255,255,255,0.15);
      transition: background 0.15s;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 12px 8px 16px;
    }
    .title {
      font-size: 12px;
      font-weight: 600;
      color: rgba(255,255,255,0.5);
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .close-btn {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      transition: background 0.1s;
    }
    .close-btn:hover { background: rgba(255,255,255,0.1); }
    .close-btn:active { background: rgba(255,255,255,0.15); }

    /* Actions */
    .actions {
      display: grid;
      grid-template-columns: repeat(3, max-content);
      gap: 6px;
      padding: 0 10px 4px;
    }

    .debug-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      padding: 0 10px 8px;
    }
    .debug-actions[hidden] {
      display: none;
    }

    .debug-toggle-wrap {
      display: flex;
      justify-content: center;
      padding: 0 10px 6px;
    }
    .debug-toggle {
      width: 32px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: rgba(255,255,255,0.48);
      cursor: pointer;
      transition: background 0.1s, color 0.1s;
    }
    .debug-toggle:hover {
      background: rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.76);
    }
    .debug-toggle svg {
      transition: transform 0.12s ease-out;
    }
    .debug-toggle[aria-expanded="true"] svg {
      transform: rotate(180deg);
    }
    .debug-toggle.disabled {
      opacity: 0.4;
      pointer-events: none;
    }

    .action-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      height: 34px;
      padding: 0 12px;
      border: none;
      border-radius: 8px;
      background: rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.9);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.1s;
      white-space: nowrap;
    }
    .action-btn.debug {
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.72);
      font-size: 11px;
    }
    .action-btn.debug:hover { background: rgba(255,255,255,0.1); }
    .action-btn.debug.active {
      background: rgba(13, 153, 255, 0.14);
      color: #7cc7ff;
      box-shadow: inset 0 0 0 1px rgba(13, 153, 255, 0.3);
    }
    .action-btn:hover { background: rgba(255,255,255,0.13); }
    .action-btn:active { background: rgba(255,255,255,0.18); }
    .action-btn.active {
      background: rgba(13, 153, 255, 0.2);
      color: #0d99ff;
      box-shadow: inset 0 0 0 1px rgba(13, 153, 255, 0.4);
    }
    .action-btn.active svg path { fill: #0d99ff; }
    .action-btn.disabled { opacity: 0.4; pointer-events: none; }
    .action-btn svg { flex-shrink: 0; }

    .chip {
      display: inline-flex;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.5);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      margin-left: auto;
    }

    /* Status text (shown inside footer) */
    .status-text {
      display: none;
      color: rgba(255,255,255,0.5);
      white-space: pre-line;
      text-align: center;
      line-height: 1.4;
    }
    .status-text.animate-in {
      animation: statusIn 0.25s ease-out;
    }
    .status-text.animate-out {
      animation: statusOut 0.2s ease-in forwards;
    }
    .footer.success .status-text { color: #30d158; }

    @keyframes statusIn {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes statusOut {
      from { opacity: 1; transform: translateY(0); }
      to   { opacity: 0; transform: translateY(-6px); }
    }

    .stop-btn {
      display: none;
      padding: 2px 8px;
      border: none;
      border-radius: 4px;
      background: rgba(255,59,48,0.15);
      color: #ff3b30;
      font: inherit;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.1s;
      white-space: nowrap;
    }
    .stop-btn.visible { display: inline-flex; }
    .stop-btn:hover { background: rgba(255,59,48,0.25); }

    /* Footer */
    .footer {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 0 16px 10px;
      font-size: 11px;
    }
    .footer a {
      display: flex;
      align-items: center;
      gap: 5px;
      color: rgba(255,255,255,0.35);
      text-decoration: none;
      transition: color 0.15s;
    }
    .footer a:hover { color: rgba(255,255,255,0.6); }
    .footer a svg { flex-shrink: 0; fill: currentColor; }

    /* Selection highlight */
    .highlight {
      position: fixed;
      pointer-events: none;
      border: 2px solid #0d99ff;
      border-radius: 3px;
      background: rgba(13, 153, 255, 0.08);
      z-index: 2147483646;
      transition: all 0.05s ease-out;
    }
  `;
  shadow.appendChild(style);

  // --- Icons ---
  const SVG_NS = "http://www.w3.org/2000/svg";

  function makeSvg(size: number, viewBox: string, pathData: string[], color?: string): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", viewBox);
    for (const d of pathData) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("fill", color || "rgba(255,255,255,0.9)");
      svg.appendChild(p);
    }
    return svg;
  }

  const iconPaths: Record<string, string[]> = {
    screen: ["M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v7a1.5 1.5 0 0 1-1.5 1.5H9v2h2a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1h2v-2H3.5A1.5 1.5 0 0 1 2 10.5v-7ZM3.5 3a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-9Z"],
    page: ["M4 1.5A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8A1.5 1.5 0 0 0 13.5 13V5.25a.75.75 0 0 0-.22-.53L10.28 1.72a.75.75 0 0 0-.53-.22H4Zm0 1h5V5a1 1 0 0 0 1 1h2.5v7a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Zm6 .7L11.8 5H10V3.2ZM5.25 8a.5.5 0 0 1 .5-.5h4.5a.5.5 0 0 1 0 1h-4.5a.5.5 0 0 1-.5-.5Zm0 2a.5.5 0 0 1 .5-.5h4.5a.5.5 0 0 1 0 1h-4.5a.5.5 0 0 1-.5-.5Z"],
    select: ["M3 2a1 1 0 0 0-1 1v2.5a.5.5 0 0 1-1 0V3a2 2 0 0 1 2-2h2.5a.5.5 0 0 1 0 1H3Zm7.5-1a.5.5 0 0 1 .5-.5H13a2 2 0 0 1 2 2v2.5a.5.5 0 0 1-1 0V3a1 1 0 0 0-1-1h-2.5a.5.5 0 0 1-.5-.5ZM1.5 10a.5.5 0 0 1 .5.5V13a1 1 0 0 0 1 1h2.5a.5.5 0 0 1 0 1H3a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5Zm13 0a.5.5 0 0 1 .5.5V13a2 2 0 0 1-2 2h-2.5a.5.5 0 0 1 0-1H13a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 .5-.5Z"],
    chevronDown: ["M4.22 5.22a.75.75 0 0 1 1.06 0L8 7.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L8.53 9.53a.75.75 0 0 1-1.06 0L4.22 6.28a.75.75 0 0 1 0-1.06Z"],
    close: ["M3.47 3.47a.75.75 0 0 1 1.06 0L8 6.94l3.47-3.47a.75.75 0 1 1 1.06 1.06L9.06 8l3.47 3.47a.75.75 0 1 1-1.06 1.06L8 9.06l-3.47 3.47a.75.75 0 0 1-1.06-1.06L6.94 8 3.47 4.53a.75.75 0 0 1 0-1.06Z"],
    x: ["M21.742 21.75l-7.563-11.179 7.056-8.321h-2.456l-5.691 6.714-4.54-6.714H2.359l7.29 10.776L2.25 21.75h2.456l6.035-7.118 4.818 7.118h6.191-.008zM7.739 3.818L18.81 20.182h-2.447L5.29 3.818h2.447z"],
  };

  // --- Build panel ---
  const panel = document.createElement("div");
  panel.className = "panel";

  // Drag handle
  const dragHandle = document.createElement("div");
  dragHandle.className = "drag-handle";
  const dragIcon = document.createElement("div");
  dragIcon.className = "drag-handle-icon";
  dragHandle.appendChild(dragIcon);

  // Header
  const header = document.createElement("div");
  header.className = "header";

  function wireToolbarButtonAction(button: HTMLButtonElement, onActivate: () => void): void {
    toolbarActions.set(button, onActivate);
    let handledPointerActivation = false;
    let activePointerId: number | null = null;

    function releaseActivePointer(): void {
      if (activePointerId === null) return;
      try {
        if (button.hasPointerCapture(activePointerId)) {
          button.releasePointerCapture(activePointerId);
        }
      } catch (_err) {
        // Ignore stale pointer ids; the browser may auto-release after cancel.
      }
      activePointerId = null;
    }

    button.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.button !== 0) return;
      handledPointerActivation = true;
      activePointerId = event.pointerId;
      try {
        button.setPointerCapture(event.pointerId);
      } catch (_err) {
        // Pointer capture is best-effort; event swallowing below still protects the page.
      }
      consumeToolbarEvent(event);
      onActivate();
    });

    button.addEventListener("mousedown", consumeToolbarEvent);
    button.addEventListener("mouseup", consumeToolbarEvent);
    button.addEventListener("pointerup", (event: PointerEvent) => {
      consumeToolbarEvent(event);
      releaseActivePointer();
    });
    button.addEventListener("pointercancel", (event: PointerEvent) => {
      consumeToolbarEvent(event);
      releaseActivePointer();
    });

    button.addEventListener("click", (event: MouseEvent) => {
      consumeToolbarEvent(event);
      if (handledPointerActivation) {
        handledPointerActivation = false;
        return;
      }
      onActivate();
    });

    button.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      consumeToolbarEvent(event);
      onActivate();
    });
  }

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = isFrame ? "H2D Capture · Frame" : "H2D Capture";

  const closeBtn = document.createElement("button");
  closeBtn.className = "close-btn";
  closeBtn.appendChild(makeSvg(12, "0 0 16 16", iconPaths.close, "rgba(255,255,255,0.5)"));
  wireToolbarButtonAction(closeBtn, destroy);

  header.append(title, closeBtn);

  // Actions
  const actions = document.createElement("div");
  actions.className = "actions";

  function makeActionBtn(iconKey: string, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "action-btn";
    btn.appendChild(makeSvg(14, "0 0 16 16", iconPaths[iconKey], "rgba(255,255,255,0.9)"));
    const span = document.createElement("span");
    span.textContent = label;
    btn.appendChild(span);
    wireToolbarButtonAction(btn, onClick);
    return btn;
  }

  const btnScreen = makeActionBtn("screen", isFrame ? "This frame" : "Entire screen", () => capture("body", true, "viewport"));
  const btnFullPage = makeActionBtn("page", "Full page", () => capture("body", true, "full-page"));
  const btnSelect = makeActionBtn("select", "Select element", () => startSelection("figma"));
  const btnDebugScreen = makeActionBtn("screen", "Copy screen", () => copyDebugData("body", true));
  btnDebugScreen.classList.add("debug");
  const btnDebugSelect = makeActionBtn("select", "Copy element", () => startSelection("debug"));
  btnDebugSelect.classList.add("debug");

  actions.append(btnScreen, btnFullPage, btnSelect);

  const debugToggleWrap = document.createElement("div");
  debugToggleWrap.className = "debug-toggle-wrap";
  const debugToggle = document.createElement("button");
  debugToggle.className = "debug-toggle";
  debugToggle.type = "button";
  debugToggle.title = "Show copy debug tools";
  debugToggle.setAttribute("aria-label", "Show copy debug tools");
  debugToggle.setAttribute("aria-expanded", "false");
  debugToggle.appendChild(makeSvg(14, "0 0 16 16", iconPaths.chevronDown, "currentColor"));
  debugToggleWrap.appendChild(debugToggle);

  const debugActions = document.createElement("div");
  debugActions.className = "debug-actions";
  debugActions.hidden = true;
  debugActions.append(btnDebugScreen, btnDebugSelect);

  wireToolbarButtonAction(debugToggle, () => {
    const expanded = debugActions.hidden;
    debugActions.hidden = !expanded;
    debugToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    debugToggle.title = expanded ? "Hide copy debug tools" : "Show copy debug tools";
    debugToggle.setAttribute("aria-label", expanded ? "Hide copy debug tools" : "Show copy debug tools");
  });

  // Footer (doubles as status area)
  const footer = document.createElement("div");
  footer.className = "footer";

  const footerDefault = document.createElement("a");
  footerDefault.href = "https://x.com/romashov";
  footerDefault.target = "_blank";
  footerDefault.rel = "noopener";
  const xLabel = document.createElement("span");
  xLabel.textContent = "Follow me on";
  footerDefault.appendChild(xLabel);
  footerDefault.appendChild(makeSvg(12, "0 0 24 24", iconPaths.x, "currentColor"));

  const statusText = document.createElement("span");
  statusText.className = "status-text";

  const stopBtn = document.createElement("button");
  stopBtn.className = "stop-btn";
  stopBtn.textContent = "Stop";

  footer.append(footerDefault, statusText, stopBtn);

  panel.append(dragHandle, header, actions, debugToggleWrap, debugActions, footer);
  shadow.appendChild(panel);

  // --- Drag logic ---
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panelStartX = 0;
  let panelStartY = 0;
  let hasMoved = false;

  dragHandle.addEventListener("mousedown", (e: MouseEvent) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const rect = panel.getBoundingClientRect();
    panelStartX = rect.left;
    panelStartY = rect.top;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    const newX = panelStartX + dx;
    const newY = panelStartY + dy;

    if (!hasMoved) {
      hasMoved = true;
      panel.style.transform = "none";
    }
    panel.style.left = newX + "px";
    panel.style.top = newY + "px";
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });

  // --- Highlight element ---
  const highlight = document.createElement("div");
  highlight.className = "highlight";
  highlight.style.display = "none";
  shadow.appendChild(highlight);

  // --- Capture logic ---
  let captureAborted = false;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;

  async function capture(selector: string, autoDestroy: boolean = true, captureMode: CaptureMode = "viewport"): Promise<void> {
    if (!window.figma?.capturePage) {
      showStatus("Error: capture script not loaded", false);
      return;
    }

    captureAborted = false;
    setLoading(true);
    showStatus("Capturing...", false);

    // Show stop button after 5 seconds
    stopTimer = setTimeout(() => {
      if (!captureAborted) stopBtn.classList.add("visible");
    }, 5000);

    // Firefox: navigator.clipboard.write() requires user activation. Since the
    // toolbar activation event is still on the stack here (before any await), we create a
    // ClipboardItem with a pending Promise<Blob> now. Firefox holds the write
    // transaction open until the promise resolves.
    let ffClipboard: {
      resolve: (b: Blob) => void;
      reject: (e: unknown) => void;
      writePromise: Promise<void>;
    } | null = null;
    if (isFirefox && typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function") {
      let resolve!: (b: Blob) => void;
      let reject!: (e: unknown) => void;
      const blobPromise = new Promise<Blob>((res, rej) => { resolve = res; reject = rej; });
      const writePromise = navigator.clipboard.write([new ClipboardItem({ "text/html": blobPromise })]);
      ffClipboard = { resolve, reject, writePromise };
    }

    try {
      const json = await window.figma.capturePage(selector, { captureMode });
      if (captureAborted) {
        ffClipboard?.reject(new Error("aborted"));
        return;
      }

      showStatus("Copying to clipboard...", false);
      if (ffClipboard) {
        ffClipboard.resolve(await window.figma.wrapForClipboard!(json));
        await ffClipboard.writePromise;
      } else {
        await window.figma.writeToClipboard!(json);
      }

      showStatus("Copied to clipboard", true);
      setTimeout(() => {
        if (captureAborted) return;
        showStatus("Now paste into Figma canvas", true);
        if (autoDestroy) setTimeout(destroy, 3000);
      }, 3000);
    } catch (err) {
      if (!captureAborted) {
        showStatus("Error: " + ((err as Error).message || String(err)), false);
      }
      ffClipboard?.reject(err);
      setLoading(false);
    } finally {
      clearStopTimer();
    }
  }

  async function copyDebugData(selector: string, autoDestroy: boolean = false): Promise<void> {
    if (!window.figma?.capturePage) {
      showStatus("Error: capture script not loaded", false);
      return;
    }

    captureAborted = false;
    setLoading(true);
    showStatus("Capturing debug data...", false);

    stopTimer = setTimeout(() => {
      if (!captureAborted) stopBtn.classList.add("visible");
    }, 5000);

    try {
      const beforeDiagnostics = collectDebugDiagnostics(selector);
      const json = await window.figma.capturePage(selector, { captureMode: "viewport" });
      const afterDiagnostics = collectDebugDiagnostics(selector);
      if (captureAborted) return;

      showStatus("Copying debug data...", false);
      await copyTextToClipboard(makeDebugPayload(json, selector, beforeDiagnostics, afterDiagnostics));

      showStatus("Debug data copied", true);
      if (autoDestroy) {
        setTimeout(() => {
          if (!captureAborted) destroy();
        }, 1500);
      } else {
        setLoading(false);
      }
    } catch (err) {
      if (!captureAborted) {
        showStatus("Error: " + ((err as Error).message || String(err)), false);
      }
      setLoading(false);
    } finally {
      clearStopTimer();
    }
  }

  function makeDebugPayload(
    json: string,
    selector: string,
    beforeDiagnostics: ReturnType<typeof collectDebugDiagnostics>,
    afterDiagnostics: ReturnType<typeof collectDebugDiagnostics>,
  ): string {
    let payload: unknown;
    try {
      payload = JSON.parse(json);
      stripAssetBase64(payload);
    } catch (_err) {
      payload = json;
    }

    return JSON.stringify(
      {
        type: "h2d-capture-debug",
        version: 1,
        capturedAt: new Date().toISOString(),
        url: location.href,
        title: document.title,
        selector,
        userAgent: navigator.userAgent,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          isFrame,
        },
        diagnostics: {
          beforeCapture: beforeDiagnostics,
          afterCapture: afterDiagnostics,
        },
        payload,
      },
      null,
      2,
    );
  }

  function collectDebugDiagnostics(selector: string): Record<string, unknown> {
    const target = selector === "body" || selector === "html"
      ? document.documentElement
      : document.querySelector(selector);

    return {
      context: {
        href: location.href,
        origin: location.origin,
        title: document.title,
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        isFrame,
        frameElement: getFrameElementSummary(),
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
      },
      target: isElementNode(target) ? summarizeElement(target) : null,
      textPresence: collectTextPresence(document.body),
      keyContainers: collectKeyContainers(),
      frames: collectFrames(),
      scrollables: collectScrollableElements(),
      shadowHosts: collectShadowHosts(),
      pointHits: collectPointHits(),
    };
  }

  function getFrameElementSummary(): Record<string, unknown> | null {
    try {
      return isElementNode(window.frameElement) ? summarizeElement(window.frameElement) : null;
    } catch (err) {
      return { error: String(err) };
    }
  }

  function collectTextPresence(root: Node | null): Record<string, unknown> {
    const text = root ? normalizeText(root.textContent || "") : "";
    const visibleText = root ? normalizeText(getVisibleText(root)) : "";

    return {
      textLength: text.length,
      sample: text.slice(0, 500),
      terms: Object.fromEntries(DEBUG_TEXT_TERMS.map((term) => [term, text.includes(term)])),
      visibleTextLength: visibleText.length,
      visibleSample: visibleText.slice(0, 500),
      visibleTerms: Object.fromEntries(DEBUG_TEXT_TERMS.map((term) => [term, visibleText.includes(term)])),
    };
  }

  const DEBUG_TEXT_TERMS = [
    "渠道运营",
    "招聘提效",
    "保存并发布广告",
    "仅保存",
    "职位信息",
    "职位详情",
    "职位设置",
    "岗位招聘要求对照",
    "txq@xiaowubrother.com",
    "请选择",
    "请输入",
    "招聘管理系统",
    "CS_招聘",
    "简历收取邮箱",
    "招聘提效",
  ];

  function collectKeyContainers(
    doc: Document = document,
    includeIframeAppSelectors: boolean = false,
  ): Array<Record<string, unknown>> {
    const selectors = [
      "#convoy-container",
      "#subapp-container",
      "#iTalentFrame",
      "#bsMain",
      "#bs_layout_container",
      "[data-page='main']",
      "main",
      "body",
      ...(includeIframeAppSelectors
        ? [
            "[id*='SystemStandardForm']",
            "[class*='SystemStandardForm']",
            "[class*='bs-']",
            "[class*='scroll']",
            "[class*='Scroll']",
            "[style*='translate']",
          ]
        : []),
    ];

    const containers: Array<Record<string, unknown>> = [];
    for (const selector of selectors) {
      let elements: Element[] = [];
      try {
        elements = Array.from(doc.querySelectorAll(selector)).slice(0, 8);
      } catch (err) {
        containers.push({ selector, error: String(err) });
        continue;
      }

      for (const element of elements) {
        containers.push({ selector, ...summarizeElement(element) });
      }
    }

    return containers;
  }

  function collectFrames(): Array<Record<string, unknown>> {
    return Array.from(document.querySelectorAll("iframe, frame")).slice(0, 20).map((frame) => {
      const summary = summarizeElement(frame);
      const frameElement = frame as HTMLIFrameElement;
      let readable: Record<string, unknown>;

      try {
        const frameDocument = frameElement.contentDocument;
        readable = frameDocument
          ? {
              readable: true,
              href: frameDocument.location.href,
              title: frameDocument.title,
              readyState: frameDocument.readyState,
              body: frameDocument.body ? summarizeElement(frameDocument.body) : null,
              textPresence: collectTextPresence(frameDocument.body),
              keyContainers: collectKeyContainers(frameDocument, true),
              scrollables: collectScrollableElements(frameDocument),
              pointHits: collectPointHits(frameDocument),
              visibleTextNodes: collectVisibleTextNodes(frameDocument),
            }
          : { readable: false, reason: "contentDocument is null" };
      } catch (err) {
        readable = { readable: false, error: String(err) };
      }

      return {
        ...summary,
        src: frameElement.src || frame.getAttribute("src"),
        name: frameElement.name || frame.getAttribute("name"),
        readable,
      };
    });
  }

  function collectScrollableElements(doc: Document = document): Array<Record<string, unknown>> {
    return Array.from(doc.querySelectorAll("*"))
      .filter((element) => element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
      .slice(0, 50)
      .map((element) => summarizeElement(element, false));
  }

  function collectShadowHosts(doc: Document = document): Array<Record<string, unknown>> {
    return Array.from(doc.querySelectorAll("*"))
      .filter((element) => Boolean(element.shadowRoot))
      .slice(0, 20)
      .map((element) => ({
        ...summarizeElement(element, false),
        shadowTextPresence: collectTextPresence(element.shadowRoot),
      }));
  }

  function collectPointHits(doc: Document = document): Array<Record<string, unknown>> {
    const view = doc.defaultView ?? window;
    const points = [
      { name: "center", x: view.innerWidth / 2, y: view.innerHeight / 2 },
      { name: "contentCenter", x: view.innerWidth * 0.55, y: view.innerHeight * 0.55 },
      { name: "contentBottom", x: view.innerWidth * 0.55, y: view.innerHeight * 0.78 },
      { name: "rightNav", x: view.innerWidth * 0.9, y: view.innerHeight * 0.5 },
      { name: "leftNav", x: 80, y: view.innerHeight * 0.5 },
    ];

    return points.map((point) => {
      const element = doc.elementFromPoint(point.x, point.y);
      return {
        ...point,
        hit: isElementNode(element) ? summarizeElement(element) : null,
        chain: isElementNode(element) ? summarizeElementChain(element) : [],
      };
    });
  }

  function summarizeElementChain(element: Element): Array<Record<string, unknown>> {
    const chain: Array<Record<string, unknown>> = [];
    let current: Element | null = element;
    while (current && chain.length < 8) {
      chain.push(summarizeElement(current, false));
      current = current.parentElement;
    }
    return chain;
  }

  function collectVisibleTextNodes(doc: Document): Array<Record<string, unknown>> {
    if (!doc.body) return [];

    const matches: Array<Record<string, unknown>> = [];
    const walker = doc.createTreeWalker(doc.body, 4);
    let node = walker.nextNode();

    while (node && matches.length < 30) {
      const text = normalizeText(node.textContent || "");
      if (text && DEBUG_TEXT_TERMS.some((term) => text.includes(term))) {
        const parent = node.parentElement;
        if (parent && isTextNodeVisible(node, parent)) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          range.detach();

          matches.push({
            text: text.slice(0, 240),
            rect: {
              x: roundNumber(rect.x),
              y: roundNumber(rect.y),
              width: roundNumber(rect.width),
              height: roundNumber(rect.height),
            },
            parent: summarizeElement(parent, false),
          });
        }
      }

      node = walker.nextNode();
    }

    return matches;
  }

  function isTextNodeVisible(node: Node, parent: Element): boolean {
    const computed = getElementWindow(parent).getComputedStyle(parent);
    if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return false;

    const range = getElementDocument(parent).createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    range.detach();
    return rect.width > 0 && rect.height > 0;
  }

  function summarizeElement(element: Element, includeText: boolean = true): Record<string, unknown> {
    const computed = getElementWindow(element).getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const text = includeText ? normalizeText(element.textContent || "") : "";

    const summary: Record<string, unknown> = {
      tag: element.tagName,
      id: element.id || undefined,
      className: stringifyClassName(element).slice(0, 180) || undefined,
      role: element.getAttribute("role") || undefined,
      ariaHidden: element.getAttribute("aria-hidden") || undefined,
      dataPage: element.getAttribute("data-page") || undefined,
      rect: {
        x: roundNumber(rect.x),
        y: roundNumber(rect.y),
        width: roundNumber(rect.width),
        height: roundNumber(rect.height),
      },
      scroll: {
        top: roundNumber(element.scrollTop),
        left: roundNumber(element.scrollLeft),
        width: roundNumber(element.scrollWidth),
        height: roundNumber(element.scrollHeight),
        clientWidth: roundNumber(element.clientWidth),
        clientHeight: roundNumber(element.clientHeight),
      },
      computed: {
        display: computed.display,
        cssFloat: computed.cssFloat,
        position: computed.position,
        overflow: computed.overflow,
        overflowX: computed.overflowX,
        overflowY: computed.overflowY,
        visibility: computed.visibility,
        opacity: computed.opacity,
        transform: computed.transform,
        zIndex: computed.zIndex,
        top: computed.top,
        left: computed.left,
        width: computed.width,
        height: computed.height,
      },
      childElementCount: element.childElementCount,
    };

    if (includeText) {
      summary.textLength = text.length;
      summary.textSample = text.slice(0, 300);
    }

    return summary;
  }

  function stringifyClassName(element: Element): string {
    const className = (element as HTMLElement | SVGElement).className;
    if (typeof className === "string") return className;
    if (className && typeof className === "object" && "baseVal" in className) {
      return String((className as SVGAnimatedString).baseVal || "");
    }
    return "";
  }

  function normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function getVisibleText(root: Node): string {
    if ("innerText" in root && typeof root.innerText === "string") {
      return root.innerText;
    }
    return root.textContent || "";
  }

  function isElementNode(value: unknown): value is Element {
    return Boolean(value && typeof value === "object" && (value as Node).nodeType === Node.ELEMENT_NODE);
  }

  function getElementDocument(element: Element): Document {
    return element.ownerDocument ?? document;
  }

  function getElementWindow(element: Element): Window {
    return getElementDocument(element).defaultView ?? window;
  }

  function roundNumber(value: number): number {
    return Math.round(value * 1000) / 1000;
  }

  function stripAssetBase64(value: unknown): void {
    if (value == null || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    if (typeof record.base64Blob === "string") {
      record.base64Length = record.base64Blob.length;
      record.base64Blob = "[omitted from debug payload]";
    }

    for (const child of Object.values(record)) {
      stripAssetBase64(child);
    }
  }

  async function copyTextToClipboard(text: string): Promise<void> {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";

    const selection = window.getSelection();
    const previousRanges: Range[] = [];
    if (selection) {
      for (let index = 0; index < selection.rangeCount; index += 1) {
        previousRanges.push(selection.getRangeAt(index).cloneRange());
      }
    }

    try {
      document.body.appendChild(textarea);
      textarea.select();
      if (!document.execCommand("copy")) {
        throw new Error("document.execCommand('copy') returned false");
      }
    } finally {
      textarea.remove();
      if (selection) {
        selection.removeAllRanges();
        for (const range of previousRanges) selection.addRange(range);
      }
    }
  }

  wireToolbarButtonAction(stopBtn, () => {
    captureAborted = true;
    clearStopTimer();
    stopBtn.classList.remove("visible");
    showStatus("Capture stopped", false);
    setLoading(false);
    setTimeout(() => {
      if (statusText.textContent === "Capture stopped") {
        hideStatus();
      }
    }, 3000);
  });

  function clearStopTimer(): void {
    if (stopTimer !== null) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    stopBtn.classList.remove("visible");
  }

  function showStatus(text: string, success: boolean): void {
    footerDefault.style.display = "none";
    statusText.classList.remove("animate-out");
    statusText.textContent = text;
    statusText.style.display = "inline";
    footer.classList.toggle("success", !!success);
    // Re-trigger animate-in
    statusText.classList.remove("animate-in");
    void statusText.offsetWidth;
    statusText.classList.add("animate-in");
  }

  function hideStatus(): void {
    statusText.classList.remove("animate-in");
    statusText.classList.add("animate-out");
    statusText.addEventListener("animationend", () => {
      statusText.classList.remove("animate-out");
      statusText.style.display = "none";
      statusText.textContent = "";
      stopBtn.classList.remove("visible");
      footer.classList.remove("success");
      footerDefault.style.display = "";
    }, { once: true });
  }

  function setLoading(loading: boolean): void {
    btnScreen.classList.toggle("disabled", loading);
    btnSelect.classList.toggle("disabled", loading);
    btnDebugScreen.classList.toggle("disabled", loading);
    btnDebugSelect.classList.toggle("disabled", loading);
    debugToggle.classList.toggle("disabled", loading);
  }

  // --- Element selection ---
  type SelectionMode = "figma" | "debug";

  let selecting = false;
  let selectionMode: SelectionMode | null = null;
  let selectedEl: Element | null = null;

  function startSelection(mode: SelectionMode): void {
    if (selecting) return;
    selecting = true;
    selectionMode = mode;
    btnDebugSelect.classList.toggle("active", mode === "debug");
    btnSelect.classList.toggle("active", mode === "figma");
    document.addEventListener("mousemove", onSelectionMove, true);
    document.addEventListener("click", onSelectionClick, true);
    document.addEventListener("keydown", onSelectionKey, true);
  }

  function stopSelection(): void {
    selecting = false;
    selectionMode = null;
    btnSelect.classList.remove("active");
    btnDebugSelect.classList.remove("active");
    highlight.style.display = "none";
    selectedEl = null;
    document.removeEventListener("mousemove", onSelectionMove, true);
    document.removeEventListener("click", onSelectionClick, true);
    document.removeEventListener("keydown", onSelectionKey, true);
  }

  function onSelectionMove(e: MouseEvent): void {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host) return;
    selectedEl = el;
    const rect = el.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.top = rect.top + "px";
    highlight.style.left = rect.left + "px";
    highlight.style.width = rect.width + "px";
    highlight.style.height = rect.height + "px";
  }

  function onSelectionClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const el = selectedEl;
    const mode = selectionMode;
    stopSelection();

    if (el) {
      const tempId = "__figcap_" + Math.random().toString(36).slice(2, 10);
      const hadId = el.id;
      el.id = tempId;
      const task = mode === "debug"
        ? copyDebugData(`#${tempId}`)
        : capture(`#${tempId}`);
      task.finally(() => {
        if (hadId) el.id = hadId;
        else el.removeAttribute("id");
      });
    }
  }

  function onSelectionKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      stopSelection();
      hideStatus();
    }
  }

  // --- Cleanup ---
  function destroy(): void {
    stopSelection();
    for (const eventName of toolbarShieldEvents) {
      window.removeEventListener(eventName, onWindowToolbarEvent, toolbarShieldOptions);
    }
    host.remove();
  }

  // Close on Escape
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape" && !selecting) destroy();
  });
})();
