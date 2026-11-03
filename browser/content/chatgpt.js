// ChatGPT site profile. adapter.js runs first and defines window.LLM2Shell.
window.LLM2Shell.install({
  site: 'chatgpt',
  newChatUrl: 'https://chatgpt.com/',
  inputSelectors: [
    '#prompt-textarea',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'textarea#prompt-textarea',
    'textarea[data-id="root"]',
    'div[contenteditable="true"]',
    'textarea'
  ]
});
