'use strict';

/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 WorkBuddy AI
 *
 * Privacy / secret scanner.
 * -------------------------
 * Scans text for things that should never be committed: real public IPs, home
 * directory paths that leak a username, API tokens, private key material,
 * non-placeholder email addresses, and any term listed in a local deny-list.
 *
 * Deliberately contains NO real-world values. Project-specific identifiers
 * (your SSH alias, your server IP, a client name) belong in `.secret-denylist`,
 * which is gitignored — putting them here would defeat the purpose.
 */

const PLACEHOLDER_RE =
  /^(?:x{3,}|\*{3,}|<[^>]*>|\$\{[^}]*\}|(?:test|fake|dummy|sample|example|placeholder|mock|stub|your)[-_].*|.*[-_](?:token|secret|key|password|passphrase|pw)|changeme|change-me|redacted|todo|pw|pwd|pass|passphrase|fake|faker|test|testing|dummy|example|sample)$/i;

/** Path segments that are obviously not a real user name. */
const SAFE_PATH_SEGMENTS = new Set([
  'public',
  'default',
  'default user',
  'all users',
  'user',
  'users',
  'me',
  'you',
  'example',
  'runner',
  'node',
  'app',
  'shared',
  'someone'
]);

/** IPv4 literals that look public but are not (user-agent version strings). */
const ALLOWED_IP_LITERALS = new Set(['124.0.0.0']);

/** Email domains that are reserved for documentation. */
const SAFE_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'localhost',
  'invalid',
  'test',
  'local'
]);

function isPlaceholder(value) {
  const v = String(value).trim();
  if (!v) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  // A run of one repeated character, e.g. "aaaaaa" or "********".
  if (/^(.)\1+$/.test(v)) return true;
  return false;
}

/** RFC 1918 / loopback / link-local / documentation / multicast ranges. */
function isReservedIp(octets) {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  return false;
}

function mask(value) {
  const v = String(value);
  if (v.length <= 4) return '***';
  return v.slice(0, 3) + '***' + v.slice(-2);
}

function safeSegment(segment) {
  const s = String(segment).toLowerCase();
  if (!s) return true;
  if (SAFE_PATH_SEGMENTS.has(s)) return true;
  if (PLACEHOLDER_RE.test(s)) return true;
  if (s.startsWith('$') || s.startsWith('%')) return true;
  return false;
}

function collect(regex, line) {
  const out = [];
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(line)) !== null) {
    out.push({ match: m[0], index: m.index, groups: m });
    if (m.index === regex.lastIndex) regex.lastIndex++;
  }
  return out;
}

/**
 * Rules evaluated per line.
 * Each returns the matched text (to be masked in output) or null.
 */
const LINE_RULES = [
  {
    id: 'github-token',
    severity: 'high',
    find(line) {
      const hits = collect(/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, line);
      return hits.length ? hits[0] : null;
    }
  },
  {
    id: 'aws-access-key',
    severity: 'high',
    find(line) {
      const hits = collect(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, line);
      return hits.length ? hits[0] : null;
    }
  },
  {
    id: 'google-api-key',
    severity: 'high',
    find(line) {
      const hits = collect(/\bAIza[0-9A-Za-z_-]{35}\b/g, line);
      return hits.length ? hits[0] : null;
    }
  },
  {
    id: 'slack-token',
    severity: 'high',
    find(line) {
      const hits = collect(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, line);
      return hits.length ? hits[0] : null;
    }
  },
  {
    id: 'public-ip',
    severity: 'high',
    find(line) {
      const hits = collect(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, line);
      for (const hit of hits) {
        const parts = hit.match.split('.').map(Number);
        if (parts.some((n) => n > 255)) continue;
        if (ALLOWED_IP_LITERALS.has(hit.match)) continue;
        if (isReservedIp(parts)) continue;
        return hit;
      }
      return null;
    }
  },
  {
    id: 'home-path',
    severity: 'medium',
    find(line) {
      const win = collect(/[A-Za-z]:\\+Users\\+([^\\\s'"]+)/gi, line);
      for (const hit of win) {
        if (!safeSegment(hit.groups[1])) return hit;
      }
      const posix = collect(/\/(?:home|Users)\/([A-Za-z0-9._-]+)/g, line);
      for (const hit of posix) {
        if (!safeSegment(hit.groups[1])) return hit;
      }
      return null;
    }
  },
  {
    id: 'email-address',
    severity: 'medium',
    find(line) {
      const hits = collect(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, line);
      for (const hit of hits) {
        const domain = hit.match.split('@')[1].toLowerCase();
        if (SAFE_EMAIL_DOMAINS.has(domain)) continue;
        if (domain.endsWith('.invalid') || domain.endsWith('.example')) continue;
        return hit;
      }
      return null;
    }
  },
  {
    id: 'assigned-secret',
    severity: 'medium',
    find(line) {
      const hits = collect(
        /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
        line
      );
      for (const hit of hits) {
        const value = hit.groups[1];
        if (isPlaceholder(value)) continue;
        // Report the secret value, not the surrounding assignment.
        const offset = hit.match.lastIndexOf(value);
        return { match: value, index: hit.index + (offset === -1 ? 0 : offset) };
      }
      return null;
    }
  }
];

const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
const PRIVATE_KEY_BODY = /^[A-Za-z0-9+/=]{40,}$/;

/**
 * Scan one document.
 *
 * @param {string} text
 * @param {{denylist?: string[]}} [options]
 * @returns {Array<{rule:string,severity:string,line:number,column:number,match:string}>}
 */
function scanText(text, options = {}) {
  const hits = [];
  if (typeof text !== 'string' || !text) return hits;

  const denylist = (options.denylist || [])
    .map((t) => String(t).trim())
    .filter((t) => t && !t.startsWith('#'));

  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const rule of LINE_RULES) {
      const hit = rule.find(line);
      if (!hit) continue;
      hits.push({
        rule: rule.id,
        severity: rule.severity,
        line: i + 1,
        column: hit.index + 1,
        match: hit.match
      });
    }

    if (PRIVATE_KEY_HEADER.test(line)) {
      for (let k = i + 1; k <= Math.min(i + 4, lines.length - 1); k++) {
        const body = lines[k].trim();
        if (!body) continue;
        if (PRIVATE_KEY_BODY.test(body)) {
          hits.push({
            rule: 'private-key',
            severity: 'high',
            line: i + 1,
            column: line.indexOf('-----BEGIN') + 1,
            match: 'PRIVATE KEY'
          });
        }
        break;
      }
    }

    for (const term of denylist) {
      const idx = line.toLowerCase().indexOf(term.toLowerCase());
      if (idx === -1) continue;
      hits.push({
        rule: 'denylist',
        severity: 'high',
        line: i + 1,
        column: idx + 1,
        match: term
      });
    }
  }

  return hits;
}

module.exports = {
  scanText,
  mask,
  isReservedIp,
  isPlaceholder,
  safeSegment,
  LINE_RULES,
  ALLOWED_IP_LITERALS,
  SAFE_PATH_SEGMENTS,
  SAFE_EMAIL_DOMAINS
};
