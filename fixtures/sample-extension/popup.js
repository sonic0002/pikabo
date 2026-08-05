const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');

async function render() {
  const { clickCount = 0 } = await chrome.storage.local.get('clickCount');
  countEl.textContent = String(clickCount);
}

document.getElementById('bump').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'bump' });
  countEl.textContent = String(response.clickCount);
  statusEl.textContent = 'Counted.';
});

document.getElementById('save').addEventListener('click', async () => {
  const blob = new Blob(['pikabo sample report\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'sample-report.txt';
  link.click();
  await chrome.storage.local.set({ lastSave: 'sample-report.txt' });
  statusEl.textContent = 'Saved sample-report.txt';
});

document.getElementById('reset').addEventListener('click', async () => {
  await chrome.storage.local.set({ clickCount: 0 });
  await render();
  statusEl.textContent = 'Reset.';
});

// Same reason as options.js: the initial render is async, and a click handled before it resolves
// would have its result overwritten by the stale value this reads.
render().then(() => {
  document.body.dataset.ready = 'true';
});
