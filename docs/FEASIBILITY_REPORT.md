# Feasibility Report — LLM2Shell (Browser Edition)

**Scope:** the five investigations from AWT-001 §8, re-evaluated for the browser-extension
architecture. Every claim is **PASS / FAIL / UNKNOWN / N/A**. Anything not actually executed in
this environment is **UNKNOWN**.

> Environment: Windows 11, Node v22.22.2, npm 10.9.7, Vitest 2.1.9.
> The extension UI could not be driven in a real browser here, so live-DOM items are UNKNOWN with
> manual steps in `TEST_REPORT.md`.

---

## 1. Injecting into ChatGPT and Gemini

**Verdict: PASS (approach) / UNKNOWN (live DOM).**

The pivot to a browser extension **removes the biggest risk of the Electron design**: there is no
embedded webview login. The user opens ChatGPT/Gemini in their normal Chrome/Edge profile, already
logged in, and the content script runs alongside.

- MV3 `content_scripts` target `chatgpt.com`, `chat.openai.com`, and `gemini.google.com`.
- Content scripts run in an **isolated world**: page CSP does not block our script execution, and
  our variables cannot collide with the page.
- UI is injected as DOM nodes + a separate `panel.css` (not inline `<style>`), so a strict page
  CSP is less likely to strip styling.
- **Residual risk:** the AI sites change their DOM. Detection and input refill are heuristic with
  fallbacks, but selectors may need maintenance.

**Why this is better than Electron for login:** Google frequently rejects OAuth inside embedded
browsers. In a normal tab, that problem does not exist.

---

## 2. Resource usage

**Verdict: PASS (design) / UNKNOWN (measured).**

| Component | Approx. |
|---|---|
| Extension content script (per AI tab) | a few MB |
| Service worker | a few MB, idle-suspended by the browser |
| Local Bridge (Node) | ~40–90 MB |
| Browser tab | the browser's normal cost |

This is substantially lighter than an Electron app (0.5–1 GB). Measure on a real machine with
Task Manager while the Bridge is idle and after 30 minutes of use.

---

## 3. tmux / node-pty / xterm.js

**Verdict: N/A for this pivot (justified deviation).**

The browser edition does **not** use tmux, `node-pty`, or `xterm.js`:

- Local commands run as a fresh `child_process` for **accurate stdout/stderr/exit**
  (constraint #9).
- SSH commands run over a **persistent `ssh2.Client`** (`exec` per command, `pty:false`), so the
  connection is reused and the "connect → one command → disconnect" behaviour of the OpenSSH CLI
  is avoided.
- The UI shows a styled streaming output panel plus a command input, not a full terminal emulator.
- `tmux` is Unix-only and irrelevant to a Windows browser tool.

If a real interactive PTY is required later, add a PTY backend to the Bridge and embed xterm.js
as a web-accessible resource in the panel. The protocol does not need to change.

---

## 4. Code-block detection and input refill

**Verdict: PASS (logic) / UNKNOWN (live sites).**

- Language from `language-*` / `lang-*` / `data-language` attributes.
- Content heuristic for unlabelled blocks, with a **source-code guard** so `const`/`def`/
  `console.` blocks are not treated as shell. Unit-tested.
- `MutationObserver` + bounded re-scan handles streaming replies.
- Input refill: native value setter + `input` event for `textarea`; `execCommand('insertText')`
  for `contenteditable`; ranked selectors per site; last-visible-input fallback.

Residual risk: DOM churn. `Copy` remains available even if detection fails.

---

## 5. Reusable open-source components

**Verdict: PASS.**

| Need | Component |
|---|---|
| WebSocket server | `ws` |
| Command execution / capture | Node `child_process` |
| Extension platform | Chrome/Edge MV3 |
| Test runner | Vitest |

No single project provides "AI web UI + human-approved local execution + result return". The
Bridge is assembled from mature parts; no terminal emulator, SSH stack, or browser engine is
reimplemented.

---

## 6. Recommendation

**Proceed with the browser extension.** It is the lower-risk route for ChatGPT/Gemini because
login happens in the user's real session.

Remaining work before calling it a product:

1. Live verification on Chrome and Edge (A01–A03, A06, A09).
2. Decide whether SSH and a persistent PTY are in scope; if yes, add a PTY backend + xterm panel.
3. Harden site selectors and add a "test input box" button in options.
4. Consider native messaging instead of a WebSocket if you want to avoid a manually pasted token.

---

## 7. Constraint compliance

| # | Constraint | Status |
|---|---|---|
| 1 | Don't implement SSH | PASS — `ssh2` persistent sessions |
| 2 | Don't implement a terminal emulator | PASS — no emulator; streaming output panel |
| 3 | Don't implement a browser engine | PASS — real Chrome/Edge |
| 4 | No extra AI agent framework | PASS |
| 5 | No AI platform API keys | PASS |
| 6 | Separate AI account data vs execution records | PASS — browser storage vs Bridge memory |
| 7 | Web content can't reach execution directly | PASS — content script → extension → token Bridge |
| 8 | No fixed DOM selector as sole mechanism | PASS — heuristics + ranked fallbacks |
| 9 | Don't treat a PTY buffer as sole result source | PASS — separate `child_process` capture |
| 10 | Modular / portable | PASS — protocol is transport-agnostic |
