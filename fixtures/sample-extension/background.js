// Service worker for the sample extension. Everything here exists so a test has something
// specific to assert on.

const DEFAULTS = { clickCount: 0, theme: 'light' };

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([key]) => current[key] === undefined),
  );
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  console.log('sample extension installed');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ping') {
    sendResponse({ type: 'pong', at: Date.now() });
    return true;
  }
  if (message?.type === 'bump') {
    chrome.storage.local.get('clickCount').then(async ({ clickCount = 0 }) => {
      const next = clickCount + 1;
      await chrome.storage.local.set({ clickCount: next, lastClickAt: new Date().toISOString() });
      sendResponse({ clickCount: next });
    });
    return true;
  }
  return false;
});
