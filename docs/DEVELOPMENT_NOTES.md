# Development Notes & Next Steps — Browser Edition

## What is implemented

- MV3 extension for ChatGPT + Gemini: detection, Run toolbar, floating output panel, manual
  command input, Send Output / Send Selected / Copy.
- Service worker: WebSocket client, token handshake, auto-reconnect, outbox, per-tab routing.
- Local Bridge: HTTP health, WebSocket server, origin check, token auth, JSON protocol.
- Execution: accurate `child_process` capture (separate stdout/stderr, exact exit code).
- Logical sessions with `cd` tracking.
- 50 automated tests, including real shell execution, a WebSocket end-to-end run, and a jsdom
  DOM test for the adapter.

## Highest-value next work

1. **Live verification** on Chrome and Edge: A01–A03, A06, A09. Everything else depends on it.
2. **Selector hardening**: add a "Test input box" button in options and versioned site profiles.
3. **Decide on SSH / PTY**: if required, add a PTY backend to the Bridge and an xterm.js panel;
   the protocol already carries `sessionId` and `stream`.
4. **Pairing UX**: replace manual token paste with a one-click pairing code or native messaging.
5. **Persistence**: write `SessionStore` to disk if session restore is needed.
6. **Packaging**: publish to the Chrome Web Store / Edge Add-ons; add icons and screenshots.

## How to extend

### Add a new AI site

1. Create `browser/content/<site>.js`:
   ```js
   window.LLM2Shell.install({
     site: '<site>',
     inputSelectors: ['textarea', 'div[contenteditable="true"]', ...]
   });
   ```
2. Add a `content_scripts` entry in `browser/manifest.json` with the site's match pattern and
   `["content/adapter.js", "content/<site>.js"]`.
3. Add the host to `host_permissions`.

### Add a Bridge backend (SSH, PTY)

Implement a backend that consumes `{command, sessionId}` and emits `{stream, data}` chunks plus a
final result; wire it into `bridge/server.js` behind a `session.backend` field. The extension does
not change.

### Change the transport

The protocol is plain JSON. Replace the WebSocket in `browser/background.js` with native
messaging or HTTP long-polling; keep the message shapes.

## Phase mapping (browser pivot)

| Original phase | Browser edition |
|---|---|
| Phase 1 (validate) | Extension + Bridge + real execution done; live-DOM verification pending. |
| Phase 2 (terminal) | Logical sessions + `cd` done; PTY/SSH not in MVP. |
| Phase 3 (product) | Options page, reconnect, error handling done; store packaging pending. |

## Manual test checklist

See `docs/TEST_REPORT.md` §5. Do not mark an item PASS without a screenshot or log.
