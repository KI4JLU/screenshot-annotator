# Screenshot Annotator

A Chrome extension that captures a screenshot with your comment on it, for pasting into Claude Code or Codex, or for starting a [T3 Code](https://github.com/pingdotgg/t3code) thread directly.

1. Click the toolbar icon or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>. The page pauses: animations and videos stop, and you mark on a still of the page, so open menus and tooltips stay put. It resumes when you finish or cancel.
2. Click an element, or drag to select an area. <kbd>Esc</kbd> cancels.
3. Type a comment and press <kbd>Enter</kbd> (<kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line).
4. Paste into Claude Code or Codex with <kbd>Ctrl</kbd>+<kbd>V</kbd>.

Or pick a project under the comment and click **Send to T3 Code** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) to start a new thread there, with the screenshot attached (see [T3 Code](#t3-code)).

The clipboard gets a PNG and a plain-text version of the same note:

- **Element:** the element with a red outline and some surrounding context. The caption holds your comment, the page URL and a hint like `button#pay.primary "Pay now"`.
- **Area:** exactly the area you dragged. The caption holds your comment and the page URL.

Form fields are described by their label, never by their value.

## Setup

```bash
npm install
npm run build
```

`chrome://extensions` → enable developer mode → "Load unpacked" → `dist/`. Change the shortcut under `chrome://extensions/shortcuts`.

The extension asks for `activeTab`, `scripting`, `clipboardWrite` and `storage`. Clicking the icon grants access to the current tab, and that is enough for the screenshot. Access to the T3 Code server is requested only when you connect it.

## T3 Code

Connect once:

1. In T3 Code, open Settings → Connections → **Create link** and copy the pairing link (or just the code).
2. Open the extension's options (right-click the icon → Options), paste the link and click **Connect**. Allow access to the server when Chrome asks.

The extension trades the one-time code for a token that is valid for 30 days and can only list projects and start threads (`orchestration:read`, `orchestration:operate`). The token is stored in the extension's local storage, and only the service worker sends it, never the page. To unpair, click **Disconnect**, then revoke "Screenshot Annotator" under Settings → Connections in T3 Code.

When you send, the extension creates a thread in the chosen project and sends your comment, the page URL and the screenshot as the first message, so the agent starts right away. The thread uses the same model and run mode as your most recent thread in that project. If the project has no threads yet, it copies your most recent thread in any project. The project you pick is remembered per website.

This uses T3 Code's internal HTTP API (tested with 0.0.45-nightly) and may break when T3 Code changes it. The new thread shows up in T3 Code's sidebar; the extension cannot switch T3 Code to it.

## Limits

- Only the visible part of the page is captured. Scroll the element into view first.
- Pausing stops CSS and Web animations and `<audio>`/`<video>`, not the page's scripts, so content changed by JavaScript (a ticker, a live feed) keeps changing underneath. The still does not show this, but an element you click is outlined where it is right then. Resizing the window cancels the selection.
- The browser only allows clipboard access on HTTPS and `localhost`. On other plain-HTTP pages the extension shows the image instead: right-click it and choose "Copy image".
- Chrome pages (`chrome://…`, the Web Store) cannot be marked. The icon shows a red `!` in that case.

## Development

```bash
npm test          # vitest: crop geometry, text wrapping, T3 Code commands
npm run typecheck
npm run build
```

## CI and releases

Every push to `main` runs typecheck, tests and build, and uploads the built extension as a workflow artifact (`screenshot-annotator-<version>-<sha>`).

To release, bump `version` in `public/manifest.json`, then publish a GitHub release tagged `v<version>` (for example `v0.2.0`). The workflow attaches `screenshot-annotator-<version>.zip` to it, and fails if the tag and manifest version differ.
