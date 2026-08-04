// Injected into example.com. Adds a marker element that a test can assert on.
const banner = document.createElement('div');
banner.id = 'pikabo-banner';
banner.textContent = 'pikabo sample content script';
banner.style.cssText =
  'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#2f5fd0;color:#fff;' +
  'font:13px/1.6 system-ui,sans-serif;padding:6px 12px;text-align:center';

const attach = () => document.body?.appendChild(banner);
if (document.body) attach();
else document.addEventListener('DOMContentLoaded', attach);

document.documentElement.dataset.pikabo = 'injected';
