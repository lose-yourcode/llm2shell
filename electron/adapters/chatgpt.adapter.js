/*
 * chatgpt.adapter.js
 * ------------------
 * ChatGPT-specific configuration. The host injects this file first (to set
 * __awtConfig) and then generic.adapter.js (the shared behaviour).
 *
 * If you want to reuse this as a standalone browser-extension content script,
 * concatenate this file + generic.adapter.js in that order.
 */
window.__awtConfig = {
  site: 'chatgpt',
  // ChatGPT has used several editor implementations over time; list all known
  // candidates, most specific first. generic.adapter.js falls back gracefully.
  inputSelectors: [
    '#prompt-textarea',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'textarea#prompt-textarea',
    'textarea[data-id="root"]',
    'div[contenteditable="true"]',
    'textarea'
  ]
};
