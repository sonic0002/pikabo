const themeEl = document.getElementById('theme');
const labelEl = document.getElementById('label');
const savedEl = document.getElementById('saved');

(async () => {
  const { theme = 'light', label = '' } = await chrome.storage.local.get(['theme', 'label']);
  themeEl.value = theme;
  labelEl.value = label;
})();

document.getElementById('save-options').addEventListener('click', async () => {
  await chrome.storage.local.set({ theme: themeEl.value, label: labelEl.value });
  savedEl.textContent = 'Options saved';
});
