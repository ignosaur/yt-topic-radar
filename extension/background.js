// Opens the full-tab Topic Radar Dashboard when clicking the extension icon
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("digest.html") });
});
