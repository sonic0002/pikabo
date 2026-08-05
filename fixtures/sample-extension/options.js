const themeEl = document.getElementById('theme');
const labelEl = document.getElementById('label');
const savedEl = document.getElementById('saved');

(async () => {
  const { theme = 'light', label = '' } = await chrome.storage.local.get(['theme', 'label']);
  themeEl.value = theme;
  labelEl.value = label;
  // Hydration is async, so a test that fills a field before this resolves would have its value
  // silently overwritten. Announcing readiness lets the suite wait instead of guessing.
  document.body.dataset.ready = 'true';
})();

document.getElementById('save-options').addEventListener('click', async () => {
  await chrome.storage.local.set({ theme: themeEl.value, label: labelEl.value });
  savedEl.textContent = 'Options saved';
});
