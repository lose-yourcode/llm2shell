# Test Report — LLM2Shell (Browser Edition)

**Date:** 2026-11-03
**Environment:** Windows 11 · Node v22.22.2 · npm 10.9.7 · Vitest 2.1.9
**Command:** `npx vitest run`

---

## 1. Summary

| Metric | Result |
|---|---|
| Test files | 10 passed / 10 |
| Tests | **58 passed / 58** |
| Real PowerShell executions | 4 (via `CommandExecutor`) |
| WebSocket end-to-end Bridge runs | 3 (local exit 0, local exit 5, SSH session) |
| Persistent SSH tests | 7 (mocked ssh2) |
| Failures | 0 |

```
 Test Files  10 passed (10)
      Tests  58 passed (58)
   Duration  5.02s
```

---

## 2. Automated test coverage

| File | Tests | What it proves |
|---|---:|---|
| `test/commandDetector.test.js` | 11 | Shell language classification, fenced-code parsing, content heuristic, source-code guard. |
| `test/resultCollector.test.js` | 5 | F06 record schema, status transitions, separate stdout/stderr, session filtering. |
| `test/commandExecutor.test.js` | 4 | **Real** PowerShell: stdout capture, stdout/stderr separation, exact exit code, streaming. |
| `test/sessionManager.test.js` | 5 | Legacy PTY session lifecycle with a mocked `node-pty` (create/write/resize/kill/events). |
| `test/sessionStore.test.js` | 8 | Default session, create/get/list/kill, ≥3 sessions, `cd` tracking, bad paths, SSH create/connect/exec. |
| `test/bridgeServer.test.js` | 5 | **Real WebSocket**: bad token rejected, good token accepted, run streams output + result, exit 5, SSH session create + run. |
| `test/sshSession.test.js` | 5 | Persistent ssh2: connect once, exec per command, stdout/stderr/exit, cwd prefix, close. |
| `test/browserAdapter.test.js` | 4 | Manifest validity (MV3, matches), adapter surface, site profiles, background protocol strings. |
| `test/adapterDom.test.js` | 6 | **jsdom DOM**: toolbar injection, Python block skipped, Run dispatch, Send Output fills the input, manual Enter command, panel resize grip + collapse/restore. |
| `test/adapters.test.js` | 5 | Legacy Electron adapter surface kept for reference (no Electron dependency required to run). |
| `test/adapters.test.js` | 5 | Legacy Electron adapter scripts are syntactically valid and expose expected buttons. |

---

## 3. Real execution evidence

### 3.1 Capture layer (stdout / stderr / exit)

```
RESULT_1 {"exitCode":0,"stdout":"AWT-PHASE1-OK\r\n","stderr":"AWT-ERR-LINE\r\n","timedOut":false}
RESULT_2 {"exitCode":7,"stdout":"","stderr":"","timedOut":false}
```

`RESULT_1` proves stdout and stderr are captured **separately**; `RESULT_2` proves the **real exit
code** is returned.

### 3.2 WebSocket Bridge end-to-end

```
BRIDGE_PORT 58646
MESSAGE_TYPES ["hello.ok","run.started","output","output","result"]
RESULT {"exitCode":0,"stdout":"AWT-BROWSER-E2E\r\n","stderr":"E2E-ERR\r\n","status":"success","sessionId":"sess-1"}
```

This is the full browser data path minus the UI: authenticate → start → stream output → result,
with a session id attached.

### 3.3 HTTP health + CLI

```
HTTP_STATUS 200
LLM2Shell bridge 0.2.0
Status: running
Sessions: 1
```

```
  Listening : ws://127.0.0.1:8765
  Token     : edb0f68e25ff735b49d47d9712ee3fcf
```

### 3.4 Persistent SSH (mocked ssh2)

The SSH backend is tested with an injected fake `ssh2.Client` (no real host available here):

- `SshSession` connects once and reuses the connection for multiple `exec()` calls.
- stdout/stderr/exit are captured separately.
- the tracked cwd is prefixed (`cd '/tmp' && ...`).
- the Bridge protocol test creates an SSH session (`session.create` with `sessionType:'ssh'`)
  and runs a command over it, returning `ssh-ok` with exit 0.

---

## 4. Acceptance matrix (AWT-001 §6)

Legend: **PASS** = executed with evidence · **FAIL** = executed and failed · **UNKNOWN** = not
executed here · **N/A** = not applicable to the browser pivot.

| # | Item | Result | Evidence / reason |
|---|---|---|---|
| A01 | Open ChatGPT and log in | **UNKNOWN** | Requires a real browser session. Design removes the embedded-login risk (normal tab). Steps below. |
| A02 | Open Gemini and log in | **UNKNOWN** | Same as A01. |
| A03 | Detect code block, show Run | **PASS (DOM) / UNKNOWN (live)** | jsdom test injects the Run toolbar for a shell block and skips a Python block; live-site placement not executed. |
| A04 | Click Run executes locally | **PASS** | Bridge E2E ran real PowerShell (`exitCode 0`). |
| A05 | Record stdout / stderr / exit | **PASS** | `RESULT_1`, `RESULT_2`, bridge result all show separate streams + exact codes. |
| A06 | Fill output back into AI input | **PASS (DOM) / UNKNOWN (live)** | jsdom test clicks Send Output and asserts the textarea contains the output and `exit=0`. |
| A07 | ≥3 independent sessions | **PASS** (logic) | `sessionStore` test creates ≥3 unique sessions. |
| A08 | SSH to a VPS | **PASS (mocked) / UNKNOWN (real host)** | SSH session create/connect/exec is covered with a mocked `ssh2.Client`; a real VPS was not available here. |
| A09 | Observe live terminal output | **PASS** (data) / **UNKNOWN** (visual) | E2E shows multiple `output` frames before `result`; panel rendering not visually tested. |
| A10 | Persistent task after app close | **N/A / FAIL** | Browser Bridge is stateless; no tmux/PTY persistence. |
| A11 | Restore managed sessions | **FAIL** | Sessions are in-memory; a restart creates a fresh default session. |
| A12 | Installable package | **N/A** | Browser extension is loaded unpacked; no installer by design. |

> Per the task rule, no untested item is marked PASS.

---

## 5. Manual verification steps (for A01–A03, A06, A09)

1. `npm start` → copy the token.
2. `chrome://extensions` → Developer mode → **Load unpacked** → `browser/`.
3. Extension **Options** → paste token → **Save & Connect** → dot turns green.
4. Open <https://chatgpt.com>, log in. The **LLM2Shell** panel should appear bottom-right.
5. Ask for a PowerShell command. A code block should show **Run / Run All / Copy / Select Terminal**.
6. Click **Run**. Output streams into the panel. (A03, A09)
7. Click **Send Output**. The ChatGPT input box should contain the result. (A06)
8. Repeat on <https://gemini.google.com>. (A02)
9. Type `Get-Location` in the panel input and press Enter; the result should appear. (manual input)

Record a screenshot or log for each item before marking it PASS.

---

## 6. What is deliberately not tested here

- Live DOM of ChatGPT/Gemini (no browser automation in this environment).
- Chrome Web Store / Edge Add-ons packaging.
- A **real VPS SSH connection** (SSH is covered with a mocked `ssh2.Client`).
- Interactive PTY / TUI programs and installer flows (out of scope for the browser pivot).
- Long-running stability (24h soak).
