'use strict';

/**
 * Cross-platform test launcher.
 * Points TMP/TEMP/TMPDIR at a workspace-local directory so Vitest/Vite never
 * needs to write to a system temp dir that may be sandbox-restricted.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = path.join(root, '.vitest-tmp');
fs.mkdirSync(tmp, { recursive: true });

const env = Object.assign({}, process.env, {
  TMP: tmp,
  TEMP: tmp,
  TMPDIR: tmp
});

const args = process.argv.slice(2);
const vitestArgs = args.includes('--watch') ? args : ['run', ...args];
const bin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

const res = spawnSync(process.execPath, [bin, ...vitestArgs], {
  stdio: 'inherit',
  env
});

process.exit(res.status == null ? 1 : res.status);
