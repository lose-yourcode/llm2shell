'use strict';

const crypto = require('crypto');

/**
 * resultCollector
 * ---------------
 * Records every controlled command execution per F06:
 *   Command ID, Session ID, command, start/end time, exit code,
 *   stdout, stderr, status.
 * Keeps command<->session association so outputs from different sessions
 * are never mixed (F07 requirement).
 */
class ResultCollector {
  constructor() {
    /** @type {Map<string, object>} */
    this.results = new Map();
  }

  _id() {
    return 'cmd_' + crypto.randomBytes(5).toString('hex') + '_' + Date.now().toString(36);
  }

  create({ sessionId, command, lang, status = 'pending' }) {
    const id = this._id();
    const rec = {
      commandId: id,
      sessionId: sessionId || null,
      command: command || '',
      lang: lang || null,
      status, // pending | running | success | failed | error
      stdout: '',
      stderr: '',
      exitCode: null,
      startTime: new Date().toISOString(),
      endTime: null
    };
    this.results.set(id, rec);
    return rec;
  }

  update(id, patch = {}) {
    const r = this.results.get(id);
    if (!r) return null;
    Object.assign(r, patch);
    const terminal = ['success', 'failed', 'error'].includes(r.status);
    if (terminal && !r.endTime) r.endTime = new Date().toISOString();
    this.results.set(id, r);
    return r;
  }

  appendOutput(id, stream, data) {
    const r = this.results.get(id);
    if (!r) return false;
    if (stream === 'stdout' || stream === 'stderr') {
      r[stream] = (r[stream] || '') + data;
      return true;
    }
    return false;
  }

  get(id) {
    return this.results.get(id) || null;
  }

  list(filter = {}) {
    let arr = Array.from(this.results.values());
    if (filter.sessionId) arr = arr.filter((r) => r.sessionId === filter.sessionId);
    if (filter.status) arr = arr.filter((r) => r.status === filter.status);
    return arr;
  }

  clear() {
    this.results.clear();
  }
}

module.exports = ResultCollector;
