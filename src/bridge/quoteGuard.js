'use strict';

/**
 * quoteGuard
 * ----------
 * Detects a *truncated or malformed* command before it is executed.
 *
 * Why this exists
 * ---------------
 * A code block streamed by ChatGPT/Gemini can be captured before it finishes,
 * and a model can also simply emit an unbalanced quote. Either way the text
 * ends up in a temp .ps1 (or a `bash -c` string) with a quote that never
 * closes, and the user sees a raw parser dump instead of an actionable error:
 *
 *   The string is missing the terminator: ".
 *   + CategoryInfo : ParserError: (:) [], ParentContainsErrorRecordException
 *
 * Refusing to run with a precise message ("line 1, column 12") is both safer
 * and easier to act on than executing half a command.
 *
 * The scanner understands:
 *   - single-quoted strings, with '' as the escape in both shells;
 *   - double-quoted strings: "" and `"` escape in PowerShell, \" in bash;
 *   - # comments (only at the start of a word, so URLs with #fragments survive);
 *   - PowerShell here-strings (@" ... "@ and @' ... '@).
 *
 * It is deliberately conservative: anything it cannot parse confidently is
 * treated as balanced, so a false positive can never block a valid command.
 */

const POWERSHELL_ALIASES = new Set(['powershell', 'pwsh', 'ps1', 'psm1', 'ps']);

function normalizeShell(shell) {
  return String(shell || '').toLowerCase().trim();
}

function isPowerShellShell(shell) {
  return POWERSHELL_ALIASES.has(normalizeShell(shell));
}

function atWordStart(s, i) {
  if (i === 0) return true;
  const prev = s[i - 1];
  return prev === ' ' || prev === '\t' || prev === '\n' || prev === ';' || prev === '(' || prev === '|';
}

/**
 * Find the first quote that is opened and never closed.
 * @param {string} script
 * @param {string} shell 'powershell' | 'bash' | anything else (treated as POSIX)
 * @returns {null | {line:number, column:number, quote:string, shell:string, text:string}}
 */
function findUnterminatedQuote(script, shell) {
  const s = String(script == null ? '' : script);
  const ps = isPowerShellShell(shell);
  const label = ps ? 'powershell' : 'bash';

  let inSingle = false;
  let inDouble = false;
  let openLine = 1;
  let openCol = 0;
  let openQuote = '';

  let line = 1;
  let col = 0;
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (ch === '\n') {
      line++;
      col = 0;
      i++;
      continue;
    }
    col++;

    if (inSingle) {
      if (ch === "'") {
        if (s[i + 1] === "'") {
          i += 2;
          col++;
          continue;
        }
        inSingle = false;
      }
      i++;
      continue;
    }

    if (inDouble) {
      if (ps) {
        if (ch === '`') {
          i += 2;
          col++;
          continue;
        }
        if (ch === '"') {
          if (s[i + 1] === '"') {
            i += 2;
            col++;
            continue;
          }
          inDouble = false;
        }
      } else {
        if (ch === '\\') {
          i += 2;
          col++;
          continue;
        }
        if (ch === '"') inDouble = false;
      }
      i++;
      continue;
    }

    // ---- outside any string ----
    if (ch === '#' && atWordStart(s, i)) {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }

    // PowerShell here-string: @" <newline> ... <newline> "@
    if (ps && ch === '@' && (s[i + 1] === '"' || s[i + 1] === "'")) {
      const q = s[i + 1];
      const nl = s.indexOf('\n', i + 2);
      if (nl !== -1) {
        const terminator = '\n' + q + '@';
        const end = s.indexOf(terminator, nl);
        if (end === -1) {
          // Unterminated here-string: report the opener.
          return { line, column: col, quote: q + '@', shell: label, text: currentLine(s, i) };
        }
        // Skip the whole here-string.
        for (let k = i; k < end + terminator.length; k++) {
          if (s[k] === '\n') {
            line++;
            col = 0;
          } else {
            col++;
          }
        }
        i = end + terminator.length;
        continue;
      }
    }

    if (ch === "'") {
      inSingle = true;
      openLine = line;
      openCol = col;
      openQuote = "'";
      i++;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      openLine = line;
      openCol = col;
      openQuote = '"';
      i++;
      continue;
    }

    i++;
  }

  if (inSingle || inDouble) {
    return {
      line: openLine,
      column: openCol,
      quote: openQuote,
      shell: label,
      text: lineAt(s, openLine)
    };
  }
  return null;
}

function lineAt(s, target) {
  const lines = s.split('\n');
  const raw = lines[target - 1] || '';
  return raw.trim().slice(0, 160);
}

function currentLine(s, index) {
  const start = s.lastIndexOf('\n', index) + 1;
  const end = s.indexOf('\n', index);
  return s.slice(start, end === -1 ? s.length : end).trim().slice(0, 160);
}

function isBalanced(script, shell) {
  return findUnterminatedQuote(script, shell) === null;
}

/**
 * Human-readable explanation, shown in the panel instead of a parser dump.
 */
function formatQuoteWarning(info, script) {
  if (!info) return '';
  const lines = [
    '[LLM2Shell] Refusing to run: unterminated ' + info.quote + ' starting at line ' +
      info.line + ', column ' + info.column + '.',
    'The block looks truncated or malformed, so only part of the command would execute.'
  ];
  const text = info.text || (script ? lineAt(String(script), info.line) : '');
  if (text) lines.push('  > ' + text);
  lines.push('Re-copy the block (or ask the model to repeat it) and run again.');
  return lines.join('\n') + '\n';
}

module.exports = {
  findUnterminatedQuote,
  isBalanced,
  formatQuoteWarning,
  isPowerShellShell
};
