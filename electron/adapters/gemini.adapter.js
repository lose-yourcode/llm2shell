/*
 * gemini.adapter.js
 * -----------------
 * Gemini-specific configuration. The host injects this file first (to set
 * __awtConfig) and then generic.adapter.js (the shared behaviour).
 *
 * If you want to reuse this as a standalone browser-extension content script,
 * concatenate this file + generic.adapter.js in that order.
 */
window.__awtConfig = {
  site: 'gemini',
  // Gemini uses a rich-text editor inside a contenteditable container.
  inputSelectors: [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[role="textbox"]',
    'textarea',
    'div[contenteditable="true"]'
  ]
};
