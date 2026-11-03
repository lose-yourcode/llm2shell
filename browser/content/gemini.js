// Gemini site profile. adapter.js runs first and defines window.LLM2Shell.
window.LLM2Shell.install({
  site: 'gemini',
  newChatUrl: 'https://gemini.google.com/app',
  inputSelectors: [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[role="textbox"]',
    'textarea',
    'div[contenteditable="true"]'
  ]
});
