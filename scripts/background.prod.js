// Topic Digest for YouTube — MV3 service worker: side panel only.
function enableSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.error("sidePanel.setPanelBehavior error:", err));
  }
}

enableSidePanel();
chrome.runtime.onInstalled.addListener(() => {
  enableSidePanel();
});

chrome.action.onClicked.addListener(() => {
  if (!chrome.sidePanel?.setPanelBehavior) {
    chrome.tabs.create({ url: chrome.runtime.getURL("digest.html") });
  }
});
