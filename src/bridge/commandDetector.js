'use strict';

/**
 * commandDetector
 * ----------------
 * Pure, testable helpers for recognising shell commands inside AI replies.
 * No DOM access here -> can be unit-tested in Node and reused by the
 * browser-side adapter (which mirrors the same heuristics).
 */

// Languages that unambiguously denote a shell / command block.
const SHELL_LANGS = new Set([
  'bash', 'sh', 'shell', 'zsh', 'ksh', 'fish',
  'powershell', 'pwsh', 'ps1', 'psm1',
  'cmd', 'bat', 'batch',
  'console', 'shell-session', 'shellsession',
  'terminal', 'commandline', 'command', 'shellscript'
]);

// Common shell command leading tokens, used as a content heuristic when the
// language tag is missing or generic (e.g. ```text with a command inside).
const SHELL_TOKENS = [
  'cd', 'ls', 'dir', 'echo', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir',
  'npm', 'pnpm', 'yarn', 'git', 'python', 'python3', 'pip', 'pip3', 'node',
  'pwsh', 'powershell', 'cmd', 'ssh', 'scp', 'sftp', 'rsync',
  'curl', 'wget', 'chmod', 'chown', 'sudo', 'su', 'apt', 'apt-get', 'yum',
  'brew', 'docker', 'podman', 'kubectl', 'export', 'set', 'unset',
  'copy', 'move', 'del', 'type', 'ren', 'taskkill', 'net',
  'find', 'grep', 'egrep', 'sed', 'awk', 'tar', 'gzip', 'zip', 'unzip',
  'tree', 'touch', 'kill', 'ps', 'ping', 'tracert', 'netstat', 'ipconfig',
  'cls', 'clear', 'start', 'code', 'code-insiders', 'dotnet', 'go', 'cargo',
  'rustc', 'gcc', 'make', 'cmake', 'source', 'conda', 'pyenv', 'nvm'
];

const SHELL_TOKEN_RE = new RegExp('^\\s*(' + SHELL_TOKENS.join('|') + ')\\b', 'i');

// First lines that strongly indicate source code rather than a shell command.
const CODE_START_RE = /^\s*(def\s|function\s|class\s|import\s|from\s|const\s|let\s|var\s|console\.|#include|#!\/|<\?php|select\s|package\s|public\s|private\s|protected\s|using\s|fn\s|func\s|print\(|System\.out|interface\s|type\s+\w+\s*=)/i;

function normalizeLang(raw) {
  if (!raw) return '';
  return String(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isShellLang(raw) {
  const l = normalizeLang(raw);
  if (!l) return false;
  if (SHELL_LANGS.has(l)) return true;
  // fuzzy fallbacks
  if (l === 'terminal' || l === 'commandline' || l === 'command' || l === 'shellscript') return true;
  return false;
}

/**
 * Parse fenced code blocks out of markdown-ish text.
 * Returns [{ lang, code }]. Language is taken from the opening fence info
 * string (before any space), e.g. ```bash run -> "bash".
 */
function parseFencedCode(text) {
  const results = [];
  if (typeof text !== 'string') return results;
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const info = (m[1] || '').trim();
    const code = m[2].replace(/\n$/, '');
    const spaceIdx = info.indexOf(' ');
    const lang = (spaceIdx >= 0 ? info.slice(0, spaceIdx) : info).trim();
    results.push({ lang, code });
  }
  return results;
}

/**
 * Heuristic: does a code string look like a shell command rather than, say,
 * Python/JS source? Used as a fallback when the language tag is empty/generic.
 */
function looksLikeShellCommand(code) {
  if (typeof code !== 'string') return false;
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  let hits = 0;
  for (const line of lines) {
    if (SHELL_TOKEN_RE.test(line)) hits++;
  }
  if (hits > 0) return true;
  // Short blocks with no shell markers are only treated as commands when the
  // first line does not look like source code.
  if (lines.length <= 2) return !CODE_START_RE.test(lines[0]);
  return false;
}

/**
 * Decide whether a block should get Run buttons.
 * Priority: explicit shell lang -> generic lang + shell-like content -> ignore.
 */
function shouldRunBlock(lang, code) {
  if (isShellLang(lang)) return true;
  const l = normalizeLang(lang);
  if (l === '' || l === 'text' || l === 'plaintext' || l === 'none' || l === 'txt') {
    return looksLikeShellCommand(code);
  }
  return false;
}

/**
 * Normalize a command for execution. Keeps the text mostly intact but trims
 * surrounding whitespace and a single trailing newline.
 */
function normalizeCommand(code) {
  if (typeof code !== 'string') return '';
  return code.replace(/^\n+/, '').replace(/\n+$/, '');
}

module.exports = {
  SHELL_LANGS,
  SHELL_TOKENS,
  normalizeLang,
  isShellLang,
  parseFencedCode,
  looksLikeShellCommand,
  shouldRunBlock,
  normalizeCommand
};
