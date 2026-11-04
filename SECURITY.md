# Security Policy

## The core risk, stated plainly

LLM2Shell is a **remote command execution tool by design**. An AI model proposes
a shell command, you click **Run**, and it executes on your machine with **your
user privileges**. There is no sandbox and no privilege separation.

Treat it exactly like pasting a command from the internet into PowerShell: the
click is the only gate. The project's job is to make that gate visible, informed,
and hard to trip accidentally — not to make arbitrary commands safe.

## Threat model

### In scope (what the design defends against)

| Threat | Mitigation |
|---|---|
| A random website driving your shell | The Bridge binds to `127.0.0.1` only and rejects WebSocket connections whose `Origin` is a normal web page. Only `chrome-extension://` / `moz-extension://` origins and origin-less local clients are accepted. |
| Another local user or process on the same machine | A random token is generated at Bridge startup and must be presented in the `hello` handshake. It is stored in `chrome.storage.local` and never sent to a page. |
| Silent execution while you read | Commands only run on an explicit click. There is no auto-run, no "trust this site" mode, and no execution from page scripts. |
| A truncated or half-streamed block being executed | The block text is re-read at click time and validated by `quoteGuard`; unbalanced quotes are refused with line/column and the shell is never spawned. |
| Credential leakage into the transcript | SSH passwords are cleared from the form after connecting and are never written to the panel output. |

### Out of scope (what this does **not** defend against)

- **A malicious or mistaken command you approve.** `rm -rf`, `curl | iex`,
  credential exfiltration — all of it runs if you click Run.
- **Prompt injection.** Content the model reads (a web page, a file, an issue
  body) can influence the commands it proposes. Review every command.
- **A compromised local machine.** If an attacker already runs code as you, the
  Bridge token and `~/.ssh` keys are readable.
- **SSH host-key verification.** The current `ssh2` integration does not pin or
  verify host keys, so it is vulnerable to a man-in-the-middle on the SSH path.
  See `docs/KNOWN_ISSUES.md`.
- **Network exposure.** The Bridge is loopback-only by design. Do not change it
  to bind `0.0.0.0` or put it behind a proxy.

## Hardening checklist for users

1. Keep the Bridge bound to `127.0.0.1` and keep the token private.
2. Read every command before clicking **Run** — especially anything with `sudo`,
   `rm`, `curl`, `iwr`, `Invoke-Expression`, `>` redirection, or `|`.
3. Use a dedicated SSH key for this tool, ideally one restricted by
   `command=` or a limited user, rather than your personal key.
4. Prefer a non-administrator shell. Do not run the Bridge from an elevated
   terminal unless the task requires it.
5. Re-run `npm start` if the token changes, and re-save it in **Options**.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

- Use GitHub's private advisory flow:
  `https://github.com/lose-yourcode/llm2shell/security/advisories/new`
- Or email the maintainer listed in `package.json`.

Include: affected version (see `VERSION`), a minimal reproduction, and the
impact you believe it has. Expect an acknowledgement within 7 days.

Because this project executes arbitrary commands on request, "it ran the command
I approved" is not a vulnerability. Reports that matter are things like: a web
page can reach the Bridge, the token can be read cross-origin, a command runs
without a click, or output is injected into a page in a way that escapes its
sandbox.

## Supported versions

Only the latest release receives security fixes. Check `VERSION` for the current
one.
