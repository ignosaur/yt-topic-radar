// Topic Digest for YouTube — Firefox: no sidePanel API, so the toolbar
// button opens the dashboard in a tab. (The sidebar panel is opened from
// Firefox's own sidebar toggle via sidebar_action in the manifest.)
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("digest.html") });
});
