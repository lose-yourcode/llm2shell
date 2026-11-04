# Changelog

All notable changes to **LLM2Shell** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The authoritative version string lives in [`VERSION`](VERSION) and is mirrored in
`package.json` and `browser/manifest.json`. Git tags are `v<version>`.

## [Unreleased]

Nothing yet.

## [0.2.1] - 2026-11-04

### Added

- **Disconnect** button: closes the currently selected persistent SSH session
  (`awt:killSession` → Bridge `session.kill` → `ssh2` `close()`). Local sessions
  are refused because they hold no connection. The session list and active
  session id refresh automatically after a kill.
- `LLM2Shell.debug()` and `LLM2Shell.rescan()` diagnostic hooks in the page
  console (extension execution context) for troubleshooting missing Run buttons.
- Regression test for the full `~/.ssh/config` alias → `IdentityFile` →
  `privateKey` chain (the exact `ssh <alias>` scenario).

### Fixed

- **Run buttons missing on Gemini**: `detectLang()` no longer treats layout
  classes such as `code-block-internal` as a language name. Language detection
  now walks a whitelist chain (`data-language` / `lang` → `language-*` →
  exact known-language class → ancestor header label) and falls back to content
  heuristics.
- **Distorted Run toolbar inside flex code blocks** (ChatGPT): the toolbar is
  now placed with layout awareness (`flex: 0 0 100%` + `flex-wrap`, or
  `grid-column: 1 / -1`), and its buttons no longer shrink to min-content.
- **`Extension context invalidated`**: all `chrome.runtime.sendMessage` calls
  go through a `sendRuntime()` guard that detects a dead service worker and
  prints an actionable "refresh this tab" message instead of the raw Chrome
  error.
- **1 GB+ memory / 30% CPU** during long sessions: the output panel lives in
  `document.body`, so the page-wide `MutationObserver` re-scanned it on every
  streamed chunk and forced a full reflow (O(n²) over a session). The panel is
  now excluded from the observer and scanner, the observer is debounced to one
  pass per animation frame, autoscroll is coalesced, and the in-memory
  transcript copy is capped at 2 MB.

### Changed

- `MutationObserver` also listens for `characterData` and late-arriving text
  nodes, so blocks that finish streaming are re-checked.

## [0.2.0] - 2026-11-03

### Added

- **Persistent SSH sessions** via `ssh2`: one connection, per-command channels,
  with `cd '<cwd>' && (...)` prefixing so the working directory survives between
  commands. Supports password, key file, and `~/.ssh/config` host aliases.
- **SSH form** (host / port / user / password / key path) and `+ SSH` button.
- **Transcript view**: every command is preceded by a `$ <command>` header so
  output can be attributed; the output is no longer cleared between runs.
- **Send All** (whole transcript), **Send Selected**, **Copy**, **Clear**, and
  **New Chat** actions.
- **Jump-to-latest** pill plus smart autoscroll that only follows the stream
  while you are already at the bottom.
- **One-click Prompt button** that injects the LLM formatting prompt, plus an
  **Append / Replace** insert-mode selector.
- Resizable panel (drag grip, `320…innerWidth-36` × `160…innerHeight-36`) with
  a reliably restorable minimize state.

### Fixed

- **Truncated code blocks reaching the shell** (`TerminatorExpectedAtEndOfString`
  / `ParserError`): block text is re-read from the DOM at click time, validated
  by `quoteGuard` with exact line/column reporting, and the Bridge refuses the
  command instead of spawning a shell. PowerShell scripts are written with a
  UTF-8 BOM to keep non-ASCII characters intact.
- **SSH hanging on interactive prompts** (password / host-key, no TTY): resolved
  by `~/.ssh/config` alias support and key-file authentication.
- Panel collapsing to an unrecoverable state; `overflow: hidden` no longer clips
  the restore control.

## [0.1.0] - 2026-11-03

### Added

- Initial browser edition: Chrome/Edge **Manifest V3** extension plus a local
  Node **WebSocket Bridge** on `127.0.0.1:8765` with token handshake and Origin
  checking.
- Heuristic shell-block detection on ChatGPT and Gemini (`language-*`,
  `lang-*`, `data-language`, known-language whitelist, source-code guard).
- Local PowerShell execution with separately captured `stdout` / `stderr` and
  the exact exit code.
- Output refill into the AI input box (native setter for `textarea`,
  `execCommand` for `contenteditable`).
- Vitest suite with jsdom DOM tests, a mocked `ssh2`, a real WebSocket
  end-to-end Bridge test, and real PowerShell execution tests.
- Documentation set under `docs/` (architecture, development notes, known
  issues, test report, SSH notes, LLM prompt).

[Unreleased]: https://github.com/lose-yourcode/llm2shell/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/lose-yourcode/llm2shell/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lose-yourcode/llm2shell/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lose-yourcode/llm2shell/releases/tag/v0.1.0
