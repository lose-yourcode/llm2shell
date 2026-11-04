# Contributing to LLM2Shell

Thanks for taking a look. This is a small, deliberately boring codebase: a
Manifest V3 extension plus a loopback-only Node service. Please keep it that way.

## Requirements

- **Node.js 18+** (the Bridge uses built-in `fetch`-era APIs and modern `ws`)
- **Windows 11 + PowerShell** for the primary target; the Bridge also runs on
  macOS/Linux
- **Chrome or Edge** (Manifest V3, unpacked extension)

## Setup

```bash
git clone https://github.com/lose-yourcode/llm2shell.git
cd llm2shell
npm install
npm start          # starts the Bridge on ws://127.0.0.1:8765 and prints a token
```

Load the extension once:

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select the `browser/` folder
4. Open the extension **Options**, paste the token, **Save & Connect**

After editing anything under `browser/`, click **Reload** on the extension card
**and refresh the ChatGPT/Gemini tab** — a stale content script cannot talk to a
restarted service worker (it throws `Extension context invalidated`).

## Tests

```bash
npm test              # full Vitest suite
npm run test:watch    # watch mode
```

`scripts/run-tests.js` redirects `TMP`/`TEMP`/`TMPDIR` into `.vitest-tmp/` so
Vitest does not fail on Windows temp-directory permissions. Use it rather than
calling `vitest` directly.

Test layout — please add coverage next to the thing you changed:

| File | Covers |
|---|---|
| `test/commandDetector.test.js` | shell-block language/content heuristics |
| `test/adapterDom.test.js` | jsdom: toolbar injection, input refill, panel, disconnect |
| `test/bridgeServer.test.js` | real WebSocket end-to-end (hello → run → result) |
| `test/commandExecutor.test.js` | real PowerShell execution |
| `test/sshSession.test.js`, `test/sshConfig.test.js`, `test/sessionStore.test.js` | SSH paths |
| `test/quoteGuard.test.js` | truncated / unbalanced command rejection |

There is no coverage threshold. The rule is simpler: **a behaviour that isn't
tested isn't done.** If a bug report motivated a change, add the regression test
that would have caught it.

## Privacy scan (run this before pushing)

```bash
npm run scan:secrets
```

It scans every blob in the history, every commit message and every tracked or
untracked-not-ignored file. Anything it finds blocks the push.

Rules of thumb for this project specifically:

- **Never** put a real SSH alias, hostname, IP, user name, key filename or
  service name into docs, tests or fixtures. Use `myserver`, `deploy`,
  `203.0.113.10` (RFC 5737), `192.168.1.10`, `nginx`.
- Keep your own identifiers in `.secret-denylist` (gitignored). Copy
  `.secret-denylist.example` to start.
- Build test fixtures that *look* like secrets at runtime, e.g.
  `'ghp_' + 'A'.repeat(36)`, so the test stays meaningful without leaving a
  literal in the file.
- If you ever commit a real secret, **removing it in a later commit is not
  enough** — it stays in the history and, once pushed, stays readable on the
  remote by SHA. Treat it as compromised and rotate it.

## Code conventions

- `browser/content/adapter.js` is a plain content script: **ES5-ish syntax**,
  no build step, no imports. Do not introduce a bundler for it.
- The Bridge (`bridge/`, `src/`) is CommonJS Node.
- Two-space indent, single quotes, semicolons.
- Never add a dependency to the content script; it must run inside the page's
  isolated world with zero network access of its own.
- Anything that touches execution must go through the Bridge — the page must
  never be able to run a command without a user click.

## Commit messages

Conventional-commit style, one logical change per commit:

```
feat(ssh): add Disconnect to close a persistent SSH session
fix(detect): Run buttons on Gemini code blocks
perf(ext): stop the panel output from reflowing the page
docs: document SSH alias + key-file setup
test: cover alias IdentityFile -> privateKey load chain
```

## Pull requests

1. Branch from `master`.
2. Keep the diff focused; unrelated formatting churn will be asked to split out.
3. Run `npm test` and paste the summary (`Tests  N passed`) in the description.
4. Update `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
5. If you change behaviour documented in `README.md` or `docs/`, update the doc
   in the same commit.

## Licensing of contributions

This project is licensed under the **GNU General Public License v3.0 or later**
(see [`LICENSE`](LICENSE)). By submitting a pull request you agree that your
contribution is licensed under the same terms. Do not paste code from a project
with an incompatible license.
