// YouTube Topic Radar — MV3 service worker: side panel + Pro RSS polling.
const API_BASE = "http://localhost:3456";
const ALARM_NAME = "rss-poll";
const POLL_MINUTES = 30;

function enableSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.error("sidePanel.setPanelBehavior error:", err));
  }
}

async function fetchState() {
  try {
    const res = await fetch(`${API_BASE}/api/state`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function updateBadge(unread) {
  const n = Number(unread) || 0;
  chrome.action.setBadgeText({ text: n <= 0 ? "" : n > 9 ? "9+" : String(n) });
  if (n > 0) chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
}

async function ensureAlarm() {
  const state = await fetchState();
  if (!state?.entitlements?.isPro) return;
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
  }
}

async function pollRss() {
  const state = await fetchState();
  if (!state) return; // server down / bad response: touch nothing
  if (!state.entitlements?.isPro) {
    await chrome.alarms.clear(ALARM_NAME);
    // Clear rssSeen so a later re-upgrade re-seeds silently instead of
    // notifying for videos published while free.
    await chrome.storage.local.set({ rssUnread: 0, rssSeen: {} });
    updateBadge(0);
    return;
  }

  const channels = state.sync?.pinnedChannels || [];
  const stored = await chrome.storage.local.get(["rssSeen", "rssUnread"]);
  const rssSeen = stored.rssSeen || {};
  let rssUnread = Number(stored.rssUnread) || 0;
  const handledChannels = new Set();

  for (const channel of channels) {
    if (!channel?.channelId || handledChannels.has(channel.channelId)) continue;
    handledChannels.add(channel.channelId);
    try {
      const res = await fetch(
        `${API_BASE}/api/rss?channelId=${encodeURIComponent(channel.channelId)}`
      );
      if (!res.ok) continue;
      const data = await res.json();
      const videos = Array.isArray(data.videos) ? data.videos : [];
      if (videos.length === 0) continue; // empty feed never seeds/advances

      const prev = rssSeen[channel.channelId];
      if (!prev) {
        rssSeen[channel.channelId] = videos.map((v) => v.videoId).slice(0, 50);
        await chrome.storage.local.set({ rssSeen });
        continue;
      }

      const fresh = videos.filter((v) => v.videoId && !prev.includes(v.videoId));
      if (fresh.length === 0) continue;

      rssSeen[channel.channelId] = [
        ...fresh.map((v) => v.videoId),
        ...prev,
      ].slice(0, 50);
      await chrome.storage.local.set({ rssSeen }); // persist before notifying

      for (const video of fresh.slice(0, 3)) {
        chrome.notifications.create(
          `rss|${encodeURIComponent(channel.topic || "")}|${video.videoId}`,
          {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icon.png"),
            title: channel.channelName || channel.topic || "New video",
            message: video.title || "New video published",
          }
        );
        rssUnread += 1;
      }
      await chrome.storage.local.set({ rssUnread });
      updateBadge(rssUnread);
    } catch {
      // per-channel failure: skip, retry next cycle
    }
  }
}

enableSidePanel();
chrome.runtime.onInstalled.addListener(() => {
  enableSidePanel();
  ensureAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  enableSidePanel();
  ensureAlarm();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "proChanged") {
    (async () => {
      if (msg.isPro) {
        await ensureAlarm();
      } else {
        await chrome.alarms.clear(ALARM_NAME);
        await chrome.storage.local.set({ rssSeen: {}, rssUnread: 0 });
        updateBadge(0);
      }
      sendResponse?.({ ok: true });
    })();
    return true;
  }
});

chrome.action.onClicked.addListener(() => {
  if (!chrome.sidePanel?.setPanelBehavior) {
    chrome.tabs.create({ url: chrome.runtime.getURL("digest.html") });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) pollRss();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.rssUnread?.newValue === 0) updateBadge(0);
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const parts = notificationId.split("|");
  const topic = parts.length === 3 ? decodeURIComponent(parts[1]) : "";
  chrome.notifications.clear(notificationId);
  await chrome.storage.local.set({ rssUnread: 0 });
  updateBadge(0);
  const path = topic ? `digest.html?topic=${encodeURIComponent(topic)}` : "digest.html";
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(path),
    active: true,
  });
  if (tab.windowId != null) {
    // Bring the new tab's window forward — tabs.create alone may land it
    // in a background window the user never sees.
    chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  if (chrome.sidePanel?.open && tab.windowId != null) {
    // Point the side panel at the same topic; otherwise it shows the
    // default digest while the tab shows the notified one.
    if (chrome.sidePanel?.setOptions) {
      await chrome.sidePanel
        .setOptions({ path, enabled: true })
        .catch(() => {});
    }
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});
