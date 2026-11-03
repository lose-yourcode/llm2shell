# SSH Notes — the "Pseudo-terminal will not be allocated" message

## 1. What the message means

```
Pseudo-terminal will not be allocated because stdin is not a terminal.
```

This is an **OpenSSH CLI** warning. When you run:

```bash
ssh user@host "some command"
```

from a process whose stdin is a pipe (which is exactly what the Bridge does), ssh cannot
allocate a pseudo-terminal (PTY), so it prints this warning to **stderr** and runs the command
non-interactively.

- It is **harmless** for normal commands: stdout, stderr and the exit code still work.
- `ssh -t host cmd` forces a PTY (needed for interactive programs).
- `ssh -T host cmd` explicitly disables the PTY and silences the warning.

## 2. Why it "connects once, runs one command, then disconnects"

`ssh host command` is **command mode**, not a persistent shell. Each invocation:

1. opens a new TCP connection,
2. authenticates,
3. runs the command,
4. exits and closes the connection.

So if you type `ssh ...` into the panel's **local** session, you get exactly the behaviour you
saw: connect → run → disconnect, every time. That is by design, not a bug.

## 3. The choice

| Option | What you get | Trade-off |
|---|---|---|
| **A. One-shot** | `ssh -T host cmd` (silence the warning) or `ssh -t host cmd` (PTY for interactive) | Reconnects and re-authenticates for every command; cwd/env do not persist. |
| **B. Persistent SSH session** ✅ implemented | Create an SSH session in the panel; the Bridge keeps one `ssh2` connection open and runs each command in a new channel. | Requires the Bridge to hold the connection; no interactive TUI yet. |

**We chose B.** It removes the reconnect-per-command behaviour while keeping accurate
stdout/stderr/exit capture.

## 4. How the persistent SSH session works

```
browser panel  + SSH  →  awt:createSession {sessionType:'ssh', host, port, username, password}
        │
        ▼
background service worker → WebSocket → bridge/server.js
        │                                   │
        │                                   ├─ SessionStore.createSSH()   (src/bridge/sessionStore.js)
        │                                   ├─ SshSession.connect()       (src/bridge/sshSession.js, ssh2)
        │                                   └─ session.created {id, type:'ssh', host, ...}
        ▼
panel selects the new session; Run commands carry its sessionId
        │
        ▼
bridge run → session.type === 'ssh' → SshSession.exec(command)
        • one persistent ssh2.Client
        • client.exec(command, { pty:false }) per command
        • separate stdout / stderr / exit code
        • tracked cwd is prefixed:  cd '<cwd>' && ( <command> )
```

Key files:

- `src/bridge/sshSession.js` — persistent `ssh2` connection, `exec()` per command.
- `src/bridge/sessionStore.js` — `createSSH`, `connect`, `execSSH`, `publicInfo` (never returns
  passwords or keys).
- `bridge/server.js` — `session.create` with `sessionType:'ssh'`, and `run` routing to SSH.
- `browser/content/adapter.js` — the `+ SSH` form and session selection.

## 5. How to use it

1. `npm start` (Bridge running, token configured in the extension).
2. Open ChatGPT / Gemini. The **LLM2Shell** panel is bottom-right.
3. Click **+ SSH**. Enter host, port (default 22), username, password. Click **Connect**.
4. The panel shows `Session "user@host" ready (ssh)` and selects it.
5. Ask the AI for a command and click **Run** — it executes on the remote host over the
   persistent connection.
6. Type `cd /var/log` in the panel's `$` input and press Enter; the session cwd updates, and
   the next command runs there.
7. **Send Output** works exactly as for local sessions.

## 6. Why `exec` uses `pty:false`

`client.exec(command, { pty: false })` is the right choice for non-interactive commands:

- clean separation of stdout and stderr,
- exact exit code,
- no terminal escape sequences in the result.

Interactive programs (`vim`, `top`, nested `ssh`, password prompts) need a **PTY shell
channel** (`client.shell()`), which is not part of this MVP. If you need that, add a
`shell`-based backend and an xterm.js panel.

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| `SSH connect failed: ...` | host/port reachable, sshd running, username/password correct, firewall. |
| `ssh2 is not installed` | run `npm install` in the project. |
| Commands run but `cd` doesn't stick | use the panel's `$` input for `cd`, or a single-line `cd X` command; compound `cd X && ...` is not tracked. |
| Still seeing the PTY warning | you are running `ssh` manually in a **local** session; create an **SSH session** instead, or use `ssh -T`. |
| Interactive TUI won't work | expected — no PTY in this MVP. |
