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
2. Click **Prompt** once per conversation — the formatting prompt is placed in the input box;
   send it so the model tags every command block correctly. (Skip it and detection falls back to
   heuristics; see [`docs/LLM_PROMPT.md`](docs/LLM_PROMPT.md).)
3. Ask: *"Give me a PowerShell command to list the 5 largest files in my Downloads folder."*
4. The code block now has **Run / Run All / Copy / Select Terminal**.
5. Click **Run** → output streams into the floating panel (bottom-right).
6. Click **Send Output** → the last result is placed in the AI input box. **Send All** sends every
   result currently in the panel. Review and send.
7. You can also type a command directly in the panel's `$` input and press Enter.
8. Drag the **top-left grip** to resize the panel; click **– / +** (or double-click the title)
   to collapse and restore it.
9. **New Chat** opens a fresh conversation with the AI in a new tab, for when the thread has grown
   long. **Clear** empties the panel and its history.

**The panel is a transcript.** Each command keeps its own header line (`$ <command>`, blue, with a
left bar) and its output stays underneath, so a session of ten commands never loses track of which
output belongs to which command. Nothing is wiped automatically — the panel only clears when you
press **Clear**.

**Scrolling.** The panel follows new output only while you are already at the bottom. Scroll up to
read something and it stays put; a **↓ latest** pill appears in the corner, and clicking it jumps
back to the newest line.

**Append vs Replace.** The `Append` / `Replace` selector next to the session picker controls what
happens to text already in the AI box. `Append` (default) adds the new result *below* what is
already there, so several commands' outputs accumulate into one message; `Replace` overwrites the
box. The choice is remembered across reloads.

---

## Prompt button

The panel's **Prompt** button injects a ready-to-send prompt that tells the model to put each
runnable batch in a fenced block tagged `powershell` / `bash` / `sh`, one batch per block, no `$`
prompts inside, and never to run anything itself. That makes block detection exact instead of
heuristic.

- Source of the text: [`browser/content/prompt.js`](browser/content/prompt.js) — edit it to
  customise (e.g. a Chinese version), then reload the extension.
- Same text, with the reasoning and an example exchange:
  [`docs/LLM_PROMPT.md`](docs/LLM_PROMPT.md).


---

## Remote SSH (persistent)

Typing `ssh user@host "cmd"` into the **local** session is one-shot: it reconnects every time and
prints `Pseudo-terminal will not be allocated because stdin is not a terminal`. That is OpenSSH's
command mode, not a bug.

For a persistent connection:

1. In the panel, click **+ SSH**.
2. Enter host / port / username / password, click **Connect**.
3. The session becomes active; every **Run** executes on that host over one open `ssh2` connection.
4. `cd` typed in the panel updates the tracked working directory for later commands.

The **host** field accepts an `~/.ssh/config` alias: typing `myserver` resolves HostName, User,
Port and IdentityFile from your config, and the **key** field takes a private key path
(`~/.ssh/id_ed25519`). Password and key auth both work; ssh-agent and host-key pinning do not.

Details and troubleshooting: [`docs/SSH_NOTES.md`](docs/SSH_NOTES.md).

If a local `ssh host "cmd"` prints the warning and then appears to do nothing, it is waiting for a
password or host-key confirmation that the panel cannot answer (there is no stdin). It ends as
`[exit 124 · failed]` after the timeout. Use **+ SSH** instead.

## The LLM prompt (important)

For reliable detection, tell the AI how to format commands. Ready-to-paste prompt:
[`docs/LLM_PROMPT.md`](docs/LLM_PROMPT.md). Short version:

> Put each runnable command batch in a fenced block tagged `powershell`, `bash`, or `sh`.
> One batch per block. No prompts or commentary inside the block.

---

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| `Pseudo-terminal will not be allocated because stdin is not a terminal` | OpenSSH command mode: a local `ssh host "cmd"` is one-shot | Use **+ SSH** for a persistent session, or add `-T` to silence it |
| `The string is missing the terminator: "` / `ParserError` | The block was captured truncated, or the model emitted an unbalanced quote | Fixed: the Bridge now refuses the command with the exact line/column and never spawns a shell. Re-copy the block and run again |
| `[exit 124 · failed]` with no output | The command waited for stdin (password prompt, `read`, a TUI program) | Use **+ SSH**, or make the command non-interactive |
| No **Run** buttons on a block | The block is not tagged as a shell language and the heuristic skipped it | Click **Prompt** once, or tag the block `powershell` / `bash` / `sh` |
| No **Run** buttons on **Gemini** specifically | Fixed: Gemini puts the language in a header span, and its `<pre class="code-block-internal">` used to be read as a language tag | Reload the extension, then reload the Gemini tab |
| A block still has no buttons | The site changed its DOM | Run `LLM2Shell.debug()` in the console (DevTools → Console → context dropdown → the LLM2Shell content script). It lists every `<pre>` with the detected language, whether it passed the shell check, and its text length |
| The status dot stays red | Bridge not running, or the token does not match | `npm start`, then paste the printed token in **Options → Save & Connect** |

---

## Features

| Area | Status |
|---|---|
| ChatGPT / Gemini content-script injection | Implemented |
| Shell code-block detection + Run buttons | Implemented (heuristic + language tag) |
| Local PowerShell execution | Implemented, real-execution tested |
| stdout / stderr / exit code capture | Implemented, tested |
| Streaming output panel | Implemented |
| Transcript view (per-command headers, nothing auto-cleared) | Implemented |
| Manual command input | Implemented |
| Send Output / Send All / Send Selected / Copy | Implemented |
| Auto-scroll that respects manual scrolling + "↓ latest" | Implemented |
| Prompt button (one-click formatting prompt) | Implemented |
| New Chat button | Implemented (site URL, new tab) |
| Multiple logical sessions + `cd` tracking | Implemented |
| Token-authenticated localhost Bridge | Implemented |
| Persistent SSH sessions | Implemented via `ssh2` — one connection, per-command channels |
| Interactive PTY / installer | **Not in browser MVP** (see known issues) |

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
  content/adapter.js     detection, panel, insert (append/replace), messaging
  content/prompt.js      text injected by the Prompt button (editable)
  content/chatgpt.js     ChatGPT profile (input selectors)
  content/gemini.js      Gemini profile
  panel.css              floating panel + run-button styles
  options.html/js        Bridge URL + token
bridge/
  server.js              local WebSocket Bridge (CLI + createBridgeServer())
src/
  bridge/commandDetector.js    language classification + heuristics
  bridge/commandExecutor.js    accurate stdout/stderr/exit capture
  bridge/quoteGuard.js         refuses a command with an unterminated quote
  bridge/resultCollector.js    F06 result records
  bridge/sessionStore.js       logical sessions + cd tracking
  bridge/sshSession.js         persistent ssh2 connection (connect once, exec per command)
  bridge/sshConfig.js          ~/.ssh/config alias -> host/user/port/key
scripts/run-tests.js     test launcher (workspace-local temp dir)
test/                    Vitest suite (102 tests)
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

- ✅ **102 automated tests pass** (12 files), including **real PowerShell execution**, a
  **WebSocket end-to-end Bridge test** (hello → run → output → result with exact exit codes),
  a **jsdom DOM test** for toolbar injection + input refill + panel resize/collapse, and
  **persistent SSH** tests.
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
