chrome.commands.onCommand.addListener((command) => {
  chrome.storage.local.set({ lastCommand: command });
});

chrome.action.onClicked.addListener((tab) => {
  chrome.storage.local.set({ actionClicked: true, actionTabId: tab.id });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'surface-menu', title: 'Surface menu', contexts: ['all'] });
});

chrome.contextMenus.onClicked.addListener((info) => {
  chrome.storage.local.set({ lastMenu: { id: info.menuItemId, pageUrl: info.pageUrl } });
});
