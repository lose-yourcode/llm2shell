# Architecture — LLM2Shell (Browser Edition)

## 1. Goal

A **Human-in-the-Loop AI Terminal Workspace**: the model proposes commands, the human approves,
the local machine executes, and the result returns to the conversation. The product must not give
the model execution power, must not require AI API keys, and must reuse mature components.

## 2. Topology

Three cooperating pieces:

```
┌────────────────────────── Browser (Chrome / Edge) ──────────────────────────┐
│                                                                             │
│  ChatGPT / Gemini tab (normal logged-in session)                            │
│    content script: browser/content/adapter.js                               │
│      ├─ MutationObserver → find <pre><code>                                 │
│      ├─ classify language (class/attr + content heuristic)                  │
│      ├─ inject Run / Run All / Copy / Select Terminal                       │
│      ├─ floating panel: streaming output, manual input, Send Output         │
│      ├─ Prompt button → prompt.js text into the AI box                      │
│      └─ insertText(text, append|replace) → AI input box                     │
│                                                                             │
│  service worker: browser/background.js                                      │
│      ├─ WebSocket client to ws://127.0.0.1:8765                             │
│      ├─ token handshake, auto-reconnect, outbox                             │
│      └─ routes replies to the originating tab (pendingTabs)                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                   ▲
                                   │ JSON over WebSocket (localhost, token)
                                   ▼
┌──────────────────────────── Local Bridge (Node.js) ─────────────────────────┐
│  bridge/server.js                                                           │
│    ├─ http health endpoint + WebSocketServer                                │
│    ├─ origin check + token handshake                                        │
│    ├─ protocol dispatch                                                     │
│    ├─ SessionStore (local + SSH sessions, cd tracking)                      │
│    ├─ SshSession (ssh2: one persistent connection, exec per command)        │
│    └─ CommandExecutor (child_process, separate stdout/stderr/exit)          │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 3. End-to-end data flow

1. User asks ChatGPT/Gemini for a command.
2. The content script finds the shell block and injects a toolbar.
3. User clicks **Run**.
4. Content script → `chrome.runtime.sendMessage({type:'awt:run', command, lang, sessionId})`.
5. Service worker assigns a `reqId`, records the source tab, and sends
   `{type:'run', reqId, command, sessionId}` over the WebSocket (or queues it).
6. Bridge authenticates (already done), resolves the session cwd, emits `run.started`, then
   spawns the command.
7. Each output chunk → `{type:'output', reqId, stream, data}` → service worker → the source tab →
   panel appends it live.
8. On exit → `{type:'result', reqId, exitCode, stdout, stderr, status, ...}`.
9. User clicks **Send Output** → the panel builds a redacted/truncated payload and inserts it
   into the AI page: `append` (default) puts it below whatever is already typed, `replace`
   overwrites. Both go through `composeInsert()` + `applyInputValue()`.
10. User reviews and sends. Loop closed.

## 4. Protocol

Client → Bridge:

| Type | Fields | Purpose |
|---|---|---|
| `hello` | `token` | Authenticate |
| `run` | `reqId, command, sessionId?, lang?` | Execute |
| `session.create` | `reqId, name?, cwd?, sessionType?, host?, port?, username?, password?` | New local or SSH session |
| `session.list` | `reqId` | List sessions |
| `session.kill` | `reqId, sessionId` | Remove a session |
| `ping` | `reqId` | Liveness |

Bridge → Client:

| Type | Fields |
|---|---|
| `hello.ok` | `version, sessions` |
| `run.started` | `reqId, sessionId, command, startTime` |
| `output` | `reqId, sessionId, stream, data` |
| `result` | `reqId, sessionId, command, exitCode, stdout, stderr, status, startTime, endTime` |
| `sessions` / `session.created` / `session.killed` | session data |
| `error` | `reqId, message` |
| `auth.error` | `message` |

## 5. Key decisions

### 5.1 Extension + local Bridge, not an embedded browser

The earlier Electron design had to solve embedded login (Google often blocks it). A browser
extension runs in the user's **real** session, so login is already done and the AI sites behave
exactly as normal. The cost is that we cannot embed a PTY UI inside the page; we render a styled
output panel and a command input instead.

### 5.2 Two execution layers, capture-first

The Bridge uses `child_process` with piped `stdout` and `stderr` and an exact exit code. This is
the authoritative result source (constraint #9). It does **not** parse a terminal screen buffer.

### 5.3 Logical sessions with emulated `cd`

Because each command is a fresh process, a "session" is a working-directory context. `cd <path>`
on a single line updates the session cwd for subsequent commands (only if the directory exists).
Multi-line scripts containing `cd` are executed as-is but do not change the tracked cwd.

### 5.4 Heuristic adaptation, not brittle selectors

- Language from `language-*` / `lang-*` / `data-language`.
- Content heuristic for unlabelled blocks, with a source-code guard (`const`, `def`, `function`,
  `console.`, …) so JS/Python is not mistaken for shell.
- Input refill: ranked selector list per site, then "last visible textarea/contenteditable".
- `MutationObserver` + bounded re-scan for streaming replies and SPA hydration.

### 5.5 Persistent SSH sessions

Typing `ssh host cmd` in a **local** session is one-shot: OpenSSH connects, authenticates, runs,
and exits. Because the Bridge pipes stdin (no TTY), ssh also prints
`Pseudo-terminal will not be allocated because stdin is not a terminal`. That is command mode, not
a bug.

For a real session, the Bridge keeps an `ssh2.Client` open per SSH session and calls
`client.exec(command, { pty: false })` for each command:

- one TCP/auth connection reused across commands (no re-auth per Run),
- separate stdout/stderr and exact exit codes,
- tracked cwd prefixed as `cd '<cwd>' && ( <command> )`,
- no PTY allocated, so interactive TUI programs are out of scope for this MVP.

`SshSession` lives in `src/bridge/sshSession.js`; `SessionStore` owns the session and never
exposes passwords or keys in `publicInfo()`.

### 5.6 Localhost security

- Bind `127.0.0.1` only.
- Token generated on first run (`bridge/.token`, gitignored; override with `AWT_TOKEN`).
- Reject connections whose `Origin` is a normal web page; allow extension origins and
  no-origin local clients (CLI/tests).

## 6. Module responsibilities

| File | Responsibility |
|---|---|
| `browser/manifest.json` | MV3 manifest, content-script matches, options page. |
| `browser/background.js` | WebSocket lifecycle, outbox, tab routing, config. |
| `browser/content/adapter.js` | Detection, toolbar, panel, insert (append/replace), messaging. |
| `browser/content/prompt.js` | Text injected by the Prompt button (editable, no rebuild). |
| `browser/content/{chatgpt,gemini}.js` | Site input-selector profiles. |
| `browser/options.html/js` | Bridge URL + token storage. |
| `bridge/server.js` | HTTP + WS server, auth, protocol, execution. |
| `src/bridge/commandDetector.js` | Pure classification/parsing (shared/testable). |
| `src/bridge/commandExecutor.js` | Accurate capture layer. |
| `src/bridge/resultCollector.js` | F06 record store (used by tests/legacy). |
| `src/bridge/sessionStore.js` | Sessions + `cd` tracking. |
| `src/bridge/sshSession.js` | Persistent ssh2 connection; `exec` per command. |
| `test/*` | 45 Vitest tests incl. real PowerShell + WS integration. |

## 7. Extensibility

- **New AI site**: add a `browser/content/<site>.js` profile with input selectors and a manifest
  match; the adapter does the rest.
- **New transport**: the protocol is JSON; a native host or a browser-extension native-messaging
  transport can replace WebSocket without touching the adapter logic.
- **SSH / PTY**: add a transport backend to the Bridge; the extension protocol stays the same.
- **Full terminal**: embed xterm.js in the panel (web-accessible resource) if a real PTY backend
  is added.
