'use strict';

/**
 * sshConfig
 * ---------
 * Minimal reader for `~/.ssh/config`, used so that typing the *alias* the user
 * already uses in their own shell (`ssh myserver`) works in the panel too,
 * instead of forcing them to retype HostName/User/Port/IdentityFile.
 *
 * Supported: Host (with multiple patterns), HostName, User, Port, IdentityFile,
 * ProxyJump, ProxyCommand, plus `*` and `?` wildcards.
 *
 * Deliberately not supported (reported instead of silently ignored):
 *   Include, Match blocks, and connections that need a jump host or a custom
 *   ProxyCommand — ssh2 cannot honour those without extra plumbing.
 *
 * Semantics follow OpenSSH: for every option the **first** value found wins,
 * scanning blocks top to bottom, and the first matching `Host` decides.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const OPTION_KEYS = new Set([
  'hostname',
  'user',
  'port',
  'identityfile',
  'proxyjump',
  'proxycommand'
]);

function defaultConfigPath() {
  return path.join(os.homedir(), '.ssh', 'config');
}

function expandHome(p, home) {
  if (!p) return p;
  const h = home || os.homedir();
  if (p === '~') return h;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(h, p.slice(2));
  return p;
}

/**
 * Parse config text into ordered blocks: [{ patterns: string[], options: {} }]
 */
function parseSshConfig(text) {
  const blocks = [];
  let current = null;
  const lines = String(text || '').split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // "Key value" or "Key=value"
    const m = line.match(/^([A-Za-z]+)\s*(?:=|\s)\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (!value) continue;

    if (key === 'host') {
      current = { patterns: value.split(/\s+/), options: {} };
      blocks.push(current);
      continue;
    }
    if (key === 'match') {
      // A Match block applies conditionally; treat it as a boundary so its
      // options never leak into the preceding Host block.
      current = null;
      continue;
    }
    if (!current) {
      // Global options before the first Host block.
      current = { patterns: ['*'], options: {}, global: true };
      blocks.push(current);
    }
    if (OPTION_KEYS.has(key) && current.options[key] === undefined) {
      current.options[key] = value;
    }
  }
  return blocks;
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

/**
 * Resolve an alias to concrete connection settings.
 * @returns {null | {host, port, username, identityFile, proxyJump, proxyCommand, alias}}
 *          null when the alias is not mentioned in the config.
 */
function resolveFromBlocks(blocks, alias, home) {
  const target = String(alias || '').trim();
  if (!target) return null;

  const matches = [];
  for (const block of blocks) {
    if (block.patterns.some((p) => wildcardToRegExp(p).test(target))) matches.push(block);
  }
  if (!matches.length) return null;

  const pick = (key) => {
    for (const b of matches) {
      if (b.options[key] !== undefined) return b.options[key];
    }
    return undefined;
  };

  const hostName = pick('hostname');
  const user = pick('user');
  const port = pick('port');
  const identityFile = pick('identityfile');

  return {
    alias: target,
    // A block that only sets options for an alias normally still needs HostName.
    host: hostName || target,
    port: port ? parseInt(port, 10) || 22 : 22,
    username: user || undefined,
    identityFile: identityFile ? expandHome(identityFile.replace(/%d/g, home || os.homedir()), home) : undefined,
    proxyJump: pick('proxyjump'),
    proxyCommand: pick('proxycommand')
  };
}

/**
 * Read and resolve, tolerating a missing config file.
 * @param {string} alias
 * @param {{configPath?: string, home?: string, readFile?: Function}} [opts]
 */
function resolveHost(alias, opts = {}) {
  const home = opts.home || os.homedir();
  const configPath = opts.configPath || defaultConfigPath();
  const read = opts.readFile || ((p) => fs.readFileSync(p, 'utf8'));

  let text = '';
  try {
    text = read(configPath);
  } catch (_) {
    return null;
  }
  return resolveFromBlocks(parseSshConfig(text), alias, home);
}

module.exports = {
  parseSshConfig,
  resolveHost,
  resolveFromBlocks,
  expandHome,
  defaultConfigPath
};
