'use strict';

/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 WorkBuddy AI
 *
 * `npm run scan:secrets`
 * ----------------------
 * Scans every blob in the git history, every commit message, and every tracked
 * working-tree file for private data. Exits 1 if anything is found, so it can
 * gate a push.
 *
 * Why the whole history: rewriting a branch does NOT delete objects from a
 * remote. A commit that was pushed once stays readable by its SHA even after a
 * force-push, so scanning only HEAD is not enough.
 *
 * Project-specific identifiers go in `.secret-denylist` (gitignored), one per
 * line, `#` for comments. Never put real values in this file.
 *
 * Usage:
 *   node scripts/scan-secrets.js [--cwd <dir>] [--no-history] [--no-worktree] [--json]
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { scanText, mask } = require('../src/tools/secretScanner');

const argv = process.argv.slice(2);
const flags = {
  history: !argv.includes('--no-history'),
  worktree: !argv.includes('--no-worktree'),
  json: argv.includes('--json'),
  quiet: argv.includes('--quiet')
};

function argValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

const root = path.resolve(argValue('--cwd') || path.join(__dirname, '..'));
const DENYLIST_FILE = path.join(root, '.secret-denylist');
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

function git(args) {
  const res = spawnSync('git', args, {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = (res.stderr || '').toString().trim();
    throw new Error('git ' + args.join(' ') + ' failed: ' + err);
  }
  return res.stdout;
}

function loadDenylist() {
  if (!fs.existsSync(DENYLIST_FILE)) return [];
  return fs
    .readFileSync(DENYLIST_FILE, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function isBinary(buf) {
  return buf.includes(0);
}

/** `<mode> <type> <sha>\t<path>` records, NUL separated. */
function parseTree(raw) {
  const out = [];
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(' ');
    out.push({ sha: meta[2], path: record.slice(tab + 1) });
  }
  return out;
}

function scanHistory(denylist, stats) {
  const commits = git(['rev-list', '--all']).toString('utf8').split('\n').filter(Boolean);
  stats.commits = commits.length;

  const blobs = new Map(); // sha -> { paths:Set, commits:Set }
  for (const commit of commits) {
    const raw = git(['ls-tree', '-r', '-z', commit]).toString('utf8');
    for (const entry of parseTree(raw)) {
      if (!blobs.has(entry.sha)) blobs.set(entry.sha, { paths: new Set(), commits: new Set() });
      const record = blobs.get(entry.sha);
      record.paths.add(entry.path);
      record.commits.add(commit);
    }
  }
  stats.blobs = blobs.size;

  const findings = [];
  for (const [sha, record] of blobs) {
    let buf;
    try {
      buf = git(['cat-file', 'blob', sha]);
    } catch (e) {
      continue;
    }
    if (buf.length > MAX_BLOB_BYTES || isBinary(buf)) continue;

    const hits = scanText(buf.toString('utf8'), { denylist });
    if (!hits.length) continue;

    const file = [...record.paths][0];
    for (const hit of hits) {
      findings.push(
        Object.assign({}, hit, {
          path: file,
          scope: 'history',
          commits: record.commits.size,
          commit: [...record.commits][0].slice(0, 8)
        })
      );
    }
  }
  return findings;
}

function scanWorktree(denylist, stats) {
  const tracked = git(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  // Untracked-but-not-ignored files matter too: they are one `git add` away
  // from being published, so a pre-commit run must see them.
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])];
  stats.files = files.length;

  const findings = [];
  for (const file of files) {
    const abs = path.join(root, file);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (e) {
      continue;
    }
    if (buf.length > MAX_BLOB_BYTES || isBinary(buf)) continue;

    const hits = scanText(buf.toString('utf8'), { denylist });
    for (const hit of hits) {
      findings.push(Object.assign({}, hit, { path: file, scope: 'worktree', commits: 0 }));
    }
  }
  return findings;
}

function dedupe(findings) {
  const seen = new Map();
  for (const f of findings) {
    const key = [f.rule, f.path, f.line, f.match].join('|');
    if (!seen.has(key)) {
      seen.set(key, f);
      continue;
    }
    const kept = seen.get(key);
    kept.commits = Math.max(kept.commits, f.commits);
    if (kept.scope === 'worktree' && f.scope === 'history') kept.scope = 'history';
  }
  return [...seen.values()];
}

function main() {
  const denylist = loadDenylist();
  const stats = { commits: 0, blobs: 0, files: 0, denylist: denylist.length };

  let findings = [];
  try {
    if (flags.history) findings = findings.concat(scanHistory(denylist, stats));
    if (flags.worktree) findings = findings.concat(scanWorktree(denylist, stats));
  } catch (e) {
    console.error('[scan:secrets] ' + e.message);
    process.exit(2);
  }

  findings = dedupe(findings).sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });

  if (flags.json) {
    // Never print the raw value, not even in machine-readable output: this runs
    // in CI logs and terminal scrollback.
    const safe = findings.map((f) => ({
      rule: f.rule,
      severity: f.severity,
      path: f.path,
      line: f.line,
      column: f.column,
      masked: mask(f.match),
      scope: f.scope,
      commits: f.commits
    }));
    console.log(JSON.stringify({ stats, findings: safe }, null, 2));
    process.exit(findings.length ? 1 : 0);
  }

  if (!flags.quiet) {
    console.log('LLM2Shell privacy scan');
    console.log('  commits   : ' + stats.commits);
    console.log('  blobs     : ' + stats.blobs + ' unique across history');
    console.log('  files     : ' + stats.files + ' tracked in the working tree');
    console.log('  deny-list : ' + stats.denylist + ' term(s)' + (denylist.length ? '' : ' (none configured)'));
    console.log('');
  }

  if (!findings.length) {
    if (!flags.quiet) console.log('No findings. Safe to push.');
    process.exit(0);
  }

  for (const f of findings) {
    const where = f.path + ':' + f.line;
    const scope = f.scope === 'history' ? 'in ' + f.commits + ' commit(s)' : 'working tree';
    console.log('[' + f.severity + '] ' + f.rule + '  ' + where + '  (' + scope + ')');
    console.log('         ' + mask(f.match));
  }

  console.log('');
  console.log(findings.length + ' finding(s). Do NOT push this.');
  console.log('If the value is real, remove it from the files AND rewrite history.');
  console.log('If it is a false positive, add the exact term to .secret-denylist.');
  process.exit(1);
}

main();
