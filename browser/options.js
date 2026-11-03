'use strict';

const urlEl = document.getElementById('url');
const tokenEl = document.getElementById('token');
const statusEl = document.getElementById('status');

chrome.storage.local.get(['bridgeUrl', 'bridgeToken'], (r) => {
  if (r.bridgeUrl) urlEl.value = r.bridgeUrl;
  if (r.bridgeToken) tokenEl.value = r.bridgeToken;
});

document.getElementById('save').addEventListener('click', () => {
  const url = urlEl.value.trim() || 'ws://127.0.0.1:8765';
  const token = tokenEl.value.trim();
  if (!token) {
    statusEl.textContent = 'Token is required.';
    return;
  }

  chrome.runtime.sendMessage({ type: 'awt:setConfig', url, token }, () => {
    statusEl.textContent = 'Saved. Connecting…';
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'awt:status' }, (r) => {
        if (chrome.runtime.lastError) {
          statusEl.textContent = 'Saved. Open an AI tab to see connection status.';
          return;
        }
        statusEl.textContent = r && r.connected
          ? 'Connected ✓'
          : 'Saved, but not connected yet. Is the bridge running?';
      });
    }, 900);
  });
});
