# LLM2Shell — AI Web Terminal Bridge (Browser Edition)

> **Human-in-the-Loop AI Terminal Workspace.**
> Chat with ChatGPT / Gemini in your normal browser, click **Run** on a shell command, watch it execute locally, then send the output straight back into the chat.

This is the **browser-based** implementation of task **AWT-001**, per the revised direction:
**no standalone desktop app — a browser extension plus a local Bridge service.**

Target: **Windows 11 + PowerShell**, **ChatGPT** and **Gemini**.

---

## Why browser instead of an Electron app

| | Electron app | This browser edition |
|---|---|---|
| Login | Must log in *inside* an embedded webview; Google often blocks that. | Uses **your normal browser session** — already logged in. |
| Install | Build/sign an installer. | Load an unpacked extension once. |
| Weight | 0.5–1 GB RAM. | Extension + a small Node process. |
| AI sites | Embedded Chromium. | Native Chrome/Edge tab. |

The trade-off is documented in [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).

---

## Architecture

```
ChatGPT / Gemini tab  (your normal Chrome/Edge session)
  └─ content script (browser/content/adapter.js)
        • detects shell code blocks → Run / Run All / Copy / Select Terminal
        • floating panel: live output, manual command input, Send Output
        • fillInput() puts results back into the AI input box
              ↕ chrome.runtime messaging
  extension service worker (browser/background.js)
        • owns the WebSocket, reconnects, routes replies to the right tab
              ↕ ws://127.0.0.1:8765  (token handshake, localhost only)
  local Bridge (bridge/server.js, Node.js)
        • executes PowerShell, captures stdout / stderr / exit code separately
        • logical sessions with emulated `cd` working directory
```

Full details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Quick start (Windows 11)

### 1. Start the Bridge

```powershell
npm install
npm start
```

It prints:

```
  Listening : ws://127.0.0.1:8765
  Token     : 3f9c...   (copy this)
```

Keep this window open.

### 2. Load the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the **`browser/`** folder.
4. Open the extension's **Options** page, paste the **Token**, click **Save & Connect**.
5. The dot in the floating panel turns green when connected.

### 3. Use it

1. Open <https://chatgpt.com> or <https://gemini.google.com> and log in normally.
2. Ask: *"Give me a PowerShell command to list the 5 largest files in my Downloads folder."*
3. The code block now has **Run / Run All / Copy / Select Terminal**.
4. Click **Run** → output streams into the floating panel (bottom-right).
5. Click **Send Output** → the result is placed in the AI input box. Review and send.
6. You can also type a command directly in the panel's `$` input and press Enter.

---

## The LLM prompt (important)

For reliable detection, tell the AI how to format commands. Ready-to-paste prompt:
[`docs/LLM_PROMPT.md`](docs/LLM_PROMPT.md). Short version:

> Put each runnable command batch in a fenced block tagged `powershell`, `bash`, or `sh`.
> One batch per block. No prompts or commentary inside the block.

---

## Features

| Area | Status |
|---|---|
| ChatGPT / Gemini content-script injection | Implemented |
| Shell code-block detection + Run buttons | Implemented (heuristic + language tag) |
| Local PowerShell execution | Implemented, real-execution tested |
| stdout / stderr / exit code capture | Implemented, tested |
| Streaming output panel | Implemented |
| Manual command input | Implemented |
| Send Output / Send Selected / Copy | Implemented |
| Multiple logical sessions + `cd` tracking | Implemented |
| Token-authenticated localhost Bridge | Implemented |
| SSH / persistent PTY / installer | **Not in browser MVP** (see known issues) |

---

## Security model

- Bridge binds to **127.0.0.1 only**.
- A **token handshake** is required; the token is generated on first run and stored in
  `bridge/.token` (gitignored).
- Connections with a normal web-page `Origin` are **rejected**; only extension origins and
  no-origin local clients are allowed.
- Content scripts never execute anything themselves — they send a request; the Bridge runs it.
- The model never gets execution power: **you** click Run.
- Output sent back to AI is redacted for common secret patterns and truncated.

---

## Project layout

```
browser/                 Chrome/Edge extension (MV3)
  manifest.json
  background.js          service worker: WebSocket client + routing
  content/adapter.js     detection, panel, fillInput, messaging
  content/chatgpt.js     ChatGPT profile (input selectors)
  content/gemini.js      Gemini profile
  panel.css              floating panel + run-button styles
  options.html/js        Bridge URL + token
bridge/
  server.js              local WebSocket Bridge (CLI + createBridgeServer())
src/
  bridge/commandDetector.js    language classification + heuristics
  bridge/commandExecutor.js    accurate stdout/stderr/exit capture
  bridge/resultCollector.js    F06 result records
  bridge/sessionStore.js       logical sessions + cd tracking
test/                    Vitest suite (45 tests)
docs/                    architecture, feasibility, test report, known issues, LLM prompt
electron/ + renderer/    OPTIONAL legacy desktop shell (not the primary path)
```

---

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Start the local Bridge |
| `npm test` | Run the Vitest suite |
| `npm run test:watch` | Watch mode |

---

## Verification status

- ✅ **45 automated tests pass** (8 files), including **real PowerShell execution** and a
  **WebSocket end-to-end Bridge test** (hello → run → output → result with exact exit codes).
- ✅ Bridge HTTP health endpoint returns 200; CLI prints a token.
- ⚠️ **Live ChatGPT/Gemini DOM behaviour** (Run button placement, input refill) is **UNKNOWN**
  in the build environment — it requires a real browser session. Manual steps are in
  [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md).

Per the task rules, nothing untested is marked PASS.

---

## Legacy desktop shell

`electron/` and `renderer/` contain an optional Electron shell built earlier. It is **not**
the primary deliverable and its dependencies (`electron`, `node-pty`, `ssh2`, `@xterm/*`) are
no longer in `package.json`. Keep it for reference; the browser edition is what you run.

---

## License

MIT.
