## Project

This repository is a browser extension that captures DOM/CSS/layout and writes a Figma-compatible clipboard payload.

## Important files

- `src/extension/background.ts`: extension action, script injection, background service worker, CORS image bridge.
- `src/extension/toolbar.ts`: injected toolbar UI and user-triggered capture flow.
- `src/extension/manifest.json`: Chrome MV3 manifest.
- `src/lib/pipeline.ts`: capturePage / writeToClipboard pipeline.
- `src/lib/core/snapshot.ts`: DOM snapshot engine.
- `src/lib/encoding.ts`: Figma clipboard wrapping.

## Commands

Run these before finishing:

```bash
npm run typecheck
npm run build
