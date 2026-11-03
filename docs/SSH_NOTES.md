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

### 2.1 Why it can look like "it just hangs after the warning"

The Bridge runs commands with **no stdin**. If the host asks for a password, a key passphrase, or
a `yes/no` host-key confirmation, ssh has nowhere to read the answer from, so the command sits
there until the 60 s timeout fires and you see `[exit 124 · failed]` and nothing else.

That is not a connection problem — it is an authentication prompt nobody can answer. Two ways out:

- **Use `+ SSH`** in the panel. The Bridge authenticates with the password (or, later, a key) you
  type into the form, so no prompt is ever needed. This is the recommended path.
- Or make the host non-interactive: install a key, run `ssh-keyscan` once for the host key, and
  add `-T` to silence the PTY warning.

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

### 5.1 Using an alias from `~/.ssh/config`

The **host** field accepts the same alias you type in your own shell. If `~/.ssh/config` has:

```
Host myserver
  HostName 203.0.113.10
  User deploy
  Port 2222
  IdentityFile ~/.ssh/myserver_ed25519
```

then typing `myserver` and clicking **Connect** is enough: the Bridge fills in HostName, User,
Port and the key file. You do not need to retype any of it.

- Values you type explicitly always win over the config file.
- Options follow OpenSSH semantics: the **first** value found wins, scanning top to bottom. Put
  `Host *` defaults at the **bottom** of the file, otherwise they override the specific blocks
  above them.
- `Include`, `Match` blocks, `ProxyJump` and `ProxyCommand` are **not** supported. A host that
  needs a jump host is rejected with an explicit error naming the option, instead of failing
  later with a confusing timeout.

### 5.2 Key authentication

Put a path in the **key** field (`~/.ssh/id_ed25519`, `~/.ssh/myserver_ed25519`, …). The Bridge
reads the file and authenticates with it; an encrypted key needs its passphrase in the password
field. Leave the key field empty to use a password.

Not supported yet: ssh-agent (`SSH_AUTH_SOCK`, Pageant) and host-key pinning. Host keys are
accepted as presented — verify the fingerprint out of band if that matters for your setup.

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
