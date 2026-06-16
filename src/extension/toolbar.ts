(() => {
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
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "closed" });

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
      grid-template-columns: repeat(2, minmax(0, 1fr));
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

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = isFrame ? "H2D Capture · Frame" : "H2D Capture";

  const closeBtn = document.createElement("button");
  closeBtn.className = "close-btn";
  closeBtn.appendChild(makeSvg(12, "0 0 16 16", iconPaths.close, "rgba(255,255,255,0.5)"));
  closeBtn.addEventListener("click", destroy);

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
    btn.addEventListener("click", onClick);
    return btn;
  }

  const btnScreen = makeActionBtn("screen", isFrame ? "This frame" : "Entire screen", () => capture("body", true));
  const btnSelect = makeActionBtn("select", "Select element", () => startSelection("figma"));
  const btnDebugScreen = makeActionBtn("screen", "Copy screen", () => copyDebugData("body", true));
  btnDebugScreen.classList.add("debug");
  const btnDebugSelect = makeActionBtn("select", "Copy element", () => startSelection("debug"));
  btnDebugSelect.classList.add("debug");

  actions.append(btnScreen, btnSelect);

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

  debugToggle.addEventListener("click", () => {
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

  async function capture(selector: string, autoDestroy: boolean = true): Promise<void> {
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
    // click event is still on the stack here (before any await), we create a
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
      const json = await window.figma.capturePage(selector);
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
      const json = await window.figma.capturePage(selector);
      if (captureAborted) return;

      showStatus("Copying debug data...", false);
      await copyTextToClipboard(makeDebugPayload(json, selector));

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

  function makeDebugPayload(json: string, selector: string): string {
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
        payload,
      },
      null,
      2,
    );
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

  stopBtn.addEventListener("click", () => {
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
    host.remove();
  }

  // Close on Escape
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape" && !selecting) destroy();
  });
})();
