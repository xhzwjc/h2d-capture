# H2D Capture

Browser extension that captures any webpage and lets you paste it directly into a Figma canvas — preserving layout, styles, images, and text as editable Figma layers.

**HTML to Design, one click away.**

## How it works

1. Click the extension icon on any webpage
2. Choose **Entire screen** or **Select element**
3. The page is captured to your clipboard
4. Switch to Figma and press `Ctrl+V` / `Cmd+V` — done

The extension walks the DOM tree, computes a style diff against browser defaults, resolves images (including cross-origin), infers Auto Layout sizing hints, and serializes everything into Figma's clipboard format.

Chrome builds request broad host access so the background CORS bridge can inline visible images from arbitrary page, iframe, OSS, and CDN origins. Without this permission, cross-origin avatars or icons may be captured as DOM nodes but pasted into Figma as empty image layers.

## Features

- **Full-page capture** — captures the entire scrollable page, not just the viewport
- **Element selection** — pick a specific component to capture
- **Auto Layout hints** — infers FILL / HUG / FIXED sizing for every element so Figma can build responsive Auto Layout frames
- **Flex & grid support** — preserves flex direction, alignment, gap, and grid structure
- **Cross-origin images** — multi-strategy fetch: canvas rasterization, same-origin fetch, and a CORS bridge through the extension's background service worker
- **SVG inlining** — computed styles are baked into SVG elements for accurate rendering
- **Font detection** — probes which fonts are actually rendered on the page
- **React component annotations** — detects React Fiber tree and annotates captured nodes with component names and source locations
- **Lazy image loading** — forces lazy images to load before capture
- **Infinite scroll protection** — caps page scroll-through at 15,000px / 25 steps
- **Draggable toolbar** — minimal, non-intrusive UI rendered in a Shadow DOM

## Install

### Chrome / Edge / Brave / Arc

1. Download the latest `h2d-capture-chrome-vX.X.X.zip` from [Releases](../../releases)
2. Unzip it
3. Go to `chrome://extensions` and enable **Developer mode**
4. Click **Load unpacked** and select the unzipped folder

### Firefox

1. Download the latest `h2d-capture-firefox-vX.X.X.zip` from [Releases](../../releases)
2. Go to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on** and select the zip file

### Build from source

```sh
git clone https://github.com/cranch42/H2D-Capture.git
cd H2D-Capture
npm install
npm run build
```

Load `dist/chrome/` or `dist/firefox/` as described above.

To build and create zip archives:

```sh
npm run build:zip
# Output:
#   dist/h2d-capture-chrome-v1.6.0.zip
#   dist/h2d-capture-firefox-v1.6.0.zip
```

## Architecture

The extension is split into two layers:

### Capture library (`src/lib/`)

Framework-agnostic DOM processing engine. No browser extension APIs, no UI. Handles:

- DOM tree walking with visibility checks and pruning
- CSS style diff computation against browser defaults
- Layout sizing inference (FILL / HUG / FIXED) for Auto Layout
- Multi-strategy image resolution with CORS fallbacks
- SVG style inlining and font probing
- CSS transform math and bounding rect computation
- React Fiber tree introspection
- JSON serialization and clipboard encoding

### Extension shell (`src/extension/`)

Browser-specific integration layer:

- **Manifest V3** — `activeTab`, `scripting`, context menus, and host access for frame injection plus cross-origin image inlining
- **Service worker** — script injection, CORS bridge for cross-origin image fetch
- **Toolbar** — Shadow DOM UI with element picker, status messages, drag support
- **Firefox support** — `injector.ts` bridges the MAIN world injection gap via `<script>` tags

### Communication flow

The extension uses a three-world message bridge:

```
MAIN world                  ISOLATED world              Background
(capture.js, toolbar.js)    (CORS bridge)               (service worker)
        |                         |                          |
        |--- CustomEvent -------->|                          |
        |                         |--- runtime.sendMessage ->|
        |                         |                          |-- fetch(url)
        |                         |<-- sendResponse ---------|
        |<-- CustomEvent ---------|                          |
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Bundle to `dist/{chrome,firefox}` |
| `npm run build:zip` | Build + create zip archives |
| `npm run build:chrome` | Chrome build only |
| `npm run build:firefox` | Firefox build only |
| `npm run watch` | Rebuild on file changes |
| `npm run typecheck` | TypeScript type checking (`tsc --noEmit`) |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:e2e` | Build + run Playwright E2E tests |

## Tech stack

- **TypeScript** — strict mode, ES2020 target
- **esbuild** — fast bundling, IIFE output (unminified for readability)
- **Vitest** — unit tests
- **Playwright** — E2E tests

## Local files

To capture local HTML files (`file://` URLs), enable file access for the extension:

**Chrome:** `chrome://extensions` → H2D Capture → Details → toggle "Allow access to file URLs"

## Contributing

Contributions are welcome! Please open an issue to discuss your idea before submitting a PR.

```sh
# Development workflow
npm install
npm run watch        # auto-rebuild on changes
npm run typecheck    # check types before committing
npm test             # run unit tests
```

## License

[MIT](LICENSE) — Copyright (c) 2025 Nick Romashov
