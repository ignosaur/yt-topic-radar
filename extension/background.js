// Opens the Topic Radar Dashboard in Chrome's Side Panel when clicking the extension icon
function enableSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.error("sidePanel.setPanelBehavior error:", err));
  }
}

enableSidePanel();
chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);

chrome.action.onClicked.addListener(() => {
  if (!chrome.sidePanel?.setPanelBehavior) {
    chrome.tabs.create({ url: chrome.runtime.getURL("digest.html") });
  }
});
