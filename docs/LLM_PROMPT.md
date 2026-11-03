# LLM Prompt — making the AI output runnable commands

LLM2Shell detects shell code blocks and adds **Run** buttons. Detection is reliable when the AI
tags its blocks with a real shell language. Give the model the prompt below once per conversation
(or paste it into a "Custom instructions" / system prompt).

> **You do not have to copy-paste it.** The floating panel has a **Prompt** button: one click puts
> the text below into the AI input box, and you press Send. The text lives in
> [`browser/content/prompt.js`](../browser/content/prompt.js), so you can edit it (for example to
> write a Chinese version) and reload the extension — no rebuild needed.
>
> The button obeys the **Append / Replace** selector, so on a fresh conversation you can leave it
> on `Append` and add extra instructions before or after the prompt without losing them.

---

## A. Ready-to-paste prompt (recommended)

```text
You are helping me operate a real terminal through a tool called LLM2Shell.

Formatting rules for every command you give me:
1. Put each runnable batch in a fenced code block.
2. Tag the block with the correct language: `powershell` for Windows PowerShell,
   `bash` or `sh` for Linux/macOS, `cmd` for Windows CMD.
3. One batch per block. If several steps are needed, use one block per step and
   keep them in order.
4. Do not put explanations, prompts ($ or >), or comments inside the block —
   only the exact commands to run.
5. If a value must be filled in by me, use a clearly marked placeholder like
   <PATH> and tell me outside the block what to replace.
6. Never run anything yourself. I will review and click Run.
7. Prefer non-destructive commands. Call out anything that deletes, overwrites,
   or needs administrator rights before the block.
```

Short version, if you only want one line:

> Put each runnable command batch in a fenced block tagged `powershell` / `bash` / `sh`, one batch
> per block, no prompts or commentary inside the block.

---

## B. Why this works

| Rule | What it enables in LLM2Shell |
|---|---|
| Fenced block | The adapter's `MutationObserver` finds `<pre><code>` reliably. |
| `powershell` / `bash` / `sh` tag | `isShellLang()` accepts it directly — no heuristic guessing. |
| One batch per block | "Run" executes exactly one logical step; "Run All" stays predictable. |
| No `$`/`>` prompts | Prevents pasting a prompt character into the shell. |
| Placeholders outside the block | Avoids executing half-edited commands. |
| "Don't run anything" | Keeps the human-in-the-loop guarantee. |

---

## C. Optional: teach it the round-trip

```text
After I run a command, I may send you its output prefixed with
[LLM2Shell] session=... exit=... status=...
Treat that as real terminal output, diagnose errors from stderr, and give me the
next command in the same format.
```

---

## D. Example exchange

**You**

> List the 5 largest files under my Downloads folder.

**AI**

> This is read-only and safe:
>
> ```powershell
> Get-ChildItem "$env:USERPROFILE\Downloads" -Recurse -File |
>   Sort-Object Length -Descending |
>   Select-Object -First 5 FullName, @{n='MB';e={[math]::Round($_.Length/1MB,2)}}
> ```

LLM2Shell shows **Run** on that block. You click it, see the output, click **Send Output**, and the
AI receives:

```text
[LLM2Shell] session=local-1 exit=0 status=success

FullName                              MB
--------                              --
C:\Users\me\Downloads\video.mp4    812.4
...
```
