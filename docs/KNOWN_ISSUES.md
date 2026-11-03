# Known Issues & Limitations — Browser Edition

Severity: 🔴 blocks a core acceptance item · 🟠 degrades experience · 🟡 minor.

---

## Scope gaps vs the original AWT-001 spec

| # | Issue | Severity | Notes |
|---|---|---|---|
| 1 | **No SSH support** in the browser MVP. | 🟠 | The Bridge executes local commands only. The legacy `electron/` shell has `ssh2`; adding SSH to the Bridge is a transport backend, not a protocol change. |
| 2 | **No persistent PTY / tmux.** Commands are stateless child processes. | 🟠 | A10/A11 are not met. A future PTY backend + detached session host would be needed. |
| 3 | **No full interactive terminal.** The panel streams output and accepts typed commands, but there is no raw TTY (no `vim`, no interactive prompts). | 🟠 | Interactive programs need a PTY backend + xterm.js panel. |
| 4 | **Sessions are in-memory.** Restarting the Bridge creates a fresh default session. | 🟡 | Persist `SessionStore` to disk if needed. |
| 5 | **No installer / store listing.** Load unpacked only. | 🟡 | Publish to Chrome Web Store / Edge Add-ons when stable. |

## AI site adaptation

| # | Issue | Severity | Notes |
|---|---|---|---|
| 6 | ChatGPT/Gemini DOM changes can break code-block detection or input refill. | 🟠 | Heuristics + fallbacks; `Copy` always works. Update `browser/content/*.js` selectors. |
| 7 | Filling a `contenteditable` editor can append instead of replace. | 🟡 | `selectAll` + `insertText` is best-effort; clear manually if needed. |
| 8 | The panel is fixed bottom-right; some sites' CSS could overlap it. | 🟡 | `z-index: 2147483647`; collapse button available. |
| 9 | Concurrent runs in the same tab share one panel; output can interleave. | 🟡 | Run one command at a time; a future version can key panels by `reqId`. |

## Bridge / security

| # | Issue | Severity | Notes |
|---|---|---|---|
| 10 | The token must be copied manually into the options page. | 🟡 | Native messaging or a one-click pairing flow would remove this. |
| 11 | Any extension that obtains the token could connect. | 🟠 | Token is the boundary; keep it secret. Origin check blocks ordinary web pages. |
| 12 | Bridge is only verified on Windows/PowerShell. Linux/macOS `bash` paths exist but are untested. | 🟠 | Add a Linux test pass. |
| 13 | Output sent back to AI is truncated at 12,000 chars. | 🟡 | Raise the limit in `browser/content/adapter.js` if needed. |
| 14 | Secret redaction is pattern-based and best-effort. | 🟠 | Review before sending. |
| 15 | No host allow-list / command confirmation beyond the user's click. | 🟡 | The click *is* the confirmation; add a deny-list if desired. |

## Legacy desktop folder

| # | Issue | Severity | Notes |
|---|---|---|---|
| 16 | `electron/` + `renderer/` require `electron`, `node-pty`, `ssh2`, `@xterm/*`, which are no longer in `package.json`. | 🟡 | Optional/reference only; install those deps separately to run it. |

---

## Out of scope (AWT-001 §7)

AI autonomous loops, task planning, multi-agent, MCP server, cloud sync, multi-user permissions,
public execution gateway, AI API proxying, full IDE, custom browser engine.
