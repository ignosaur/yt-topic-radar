import {
  getBrowserName,
  shouldShowScanning,
  ttsSupportStatus,
} from "./tts-scan-utils.js";
import { buildCapturePayload, browserBucket, countBucket, durationBucket, scanErrorClass, importErrorClass } from "./telemetry-utils.js";

const STANDALONE_ROUTE =
  typeof globalThis.__RADAR_STANDALONE__ === "function"
    ? globalThis.__RADAR_STANDALONE__
    : null;
const API_BASE =
  typeof __RADAR_STANDALONE_BUILD__ !== "undefined" &&
  __RADAR_STANDALONE_BUILD__
    ? ""
    : typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
      ? "http://localhost:3456"
      : "";
const origFetch = window.fetch;
// Extension side-panel pages (chrome-extension://) cannot play YouTube embeds
// (Error 153: no usable referrer) — timestamps there open the watch page instead.
const IS_EXTENSION_PAGE =
  typeof chrome !== "undefined" && Boolean(chrome.runtime?.getURL);
window.fetch = function (input, init) {
  if (STANDALONE_ROUTE) {
    if (typeof input === "string" && input.startsWith("/api/")) {
      return STANDALONE_ROUTE(input, init);
    }
    if (
      input instanceof Request &&
      input.url.startsWith(location.origin + "/api/")
    ) {
      return STANDALONE_ROUTE(input.url.replace(location.origin, ""), input);
    }
  }
  if (typeof input === "string" && input.startsWith("/api/")) {
    input = API_BASE + input;
  } else if (
    input instanceof Request &&
    input.url.startsWith(location.origin + "/api/")
  ) {
    input = new Request(
      API_BASE + input.url.replace(location.origin, ""),
      input
    );
  }
  return origFetch.call(this, input, init);
};

let state = {
  sync: {
    topics: [],
    pinnedChannels: [],
    minDurationSec: 180,
    topicMeta: {},
    telemetryOptIn: false,
  },
  digests: {},
  metrics: {
    scansCompleted: 0,
    videosSummarized: 0,
    slopVideosFiltered: 0,
    secondsSaved: 0,
    timestampClicks: 0,
    ttsPlays: 0,
    backupsExported: 0,
  },
  monetization: {
    mode: "freemium",
    freeTopicLimit: 5,
    supportUrl: "https://rzp.io/rzp/ypHoq1R",
  },
  entitlements: { isPro: false },
  starterTopics: {},
  hasApiKey: false,
  maskedKey: "",
};
let activeTopic = "";
let scanningTopic = "";
let topicFilterQuery = "";
let topicFilterTab = "all"; // "all" | "ready" | "starred"
let starterAutoCollapsedOnce = false;
let initialLoadDone = false;

function isPro() {
  return Boolean(state.entitlements?.isPro);
}

async function resetRssUnread() {
  if (
    typeof __RADAR_STANDALONE_BUILD__ !== "undefined" &&
    __RADAR_STANDALONE_BUILD__
  )
    return;
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ rssUnread: 0 });
    }
  } catch {}
}

const el = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function setSidebarDrawerOpen(open) {
  const sidebar = el("topicsSidebar");
  const backdrop = el("sidebarBackdrop");
  if (!sidebar || !backdrop) return;
  if (open) {
    sidebar.classList.add("sidebar-open");
    backdrop.classList.remove("hidden");
  } else {
    sidebar.classList.remove("sidebar-open");
    backdrop.classList.add("hidden");
  }
}

function closeSidebarOnMobile() {
  if (window.innerWidth < 640) {
    setSidebarDrawerOpen(false);
  }
}

function showToast(msg, isError = false) {
  const t = el("statusToast");
  t.textContent = msg;
  t.className = `text-xs px-1 pt-0.5 truncate ${isError ? "text-rose-400" : "text-emerald-400"}`;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 5000);
}

// --- Dev-mode server-offline guard ---
// The extension UI is a thin shell over the local Bun server (http://localhost:3456).
// When the server is down, fetch() rejects with a TypeError (Failed to fetch /
// connection refused). Without a guard this fails silently (blank starter pack,
// no key, dead buttons). Track offline state, show a persistent dismissible
// banner + toast, and disable mutating buttons until the server is back.
let isServerOffline = false;
let serverBannerDismissed = false;

const SERVER_OFFLINE_MSG =
  "Local server not running \u2014 run `bun run ui` on :3456, then reopen the panel.";

function isServerUnreachable(err) {
  if (!err) return false;
  if (err instanceof TypeError) return true;
  const msg = String((err && err.message) || err);
  return (
    msg.includes("Failed to fetch") ||
    msg.includes("fetch failed") ||
    msg.includes("Load failed") ||
    msg.includes("NetworkError") ||
    msg.includes("Network request failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("connection refused")
  );
}

function serverUnreachableToast(action) {
  showToast(
    `Server unreachable during ${action} \u2014 run \`bun run ui\` on :3456, then reopen the panel.`,
    true
  );
}

function setOfflineMode(offline) {
  isServerOffline = offline;
  if (!offline) serverBannerDismissed = false;

  const scanBtn = el("btnScanTopic");
  const saveKeyBtn = el("btnSaveKey");
  const addTopicBtn = el("addTopicForm")?.querySelector(
    'button[type="submit"]'
  );
  for (const btn of [scanBtn, saveKeyBtn, addTopicBtn]) {
    if (!btn) continue;
    if (offline) {
      if (btn.getAttribute("title") == null) btn.dataset.origTitle = "";
      else if (btn.dataset.origTitle === undefined)
        btn.dataset.origTitle = btn.getAttribute("title") || "";
      btn.disabled = true;
      btn.title = SERVER_OFFLINE_MSG;
    } else {
      btn.disabled = false;
      if (btn.dataset.origTitle !== undefined) {
        if (btn.dataset.origTitle) btn.title = btn.dataset.origTitle;
        else btn.removeAttribute("title");
        delete btn.dataset.origTitle;
      } else {
        btn.removeAttribute("title");
      }
    }
  }

  ensureOfflineBanner();
}

function ensureOfflineBanner() {
  const container = el("digestContainer");
  if (!container) return;
  const existing = document.getElementById("serverOfflineBanner");
  if (!isServerOffline || serverBannerDismissed) {
    if (existing) existing.remove();
    return;
  }
  if (existing && existing.parentNode === container) {
    container.prepend(existing);
    return;
  }
  if (existing) existing.remove();
  const banner = document.createElement("div");
  banner.id = "serverOfflineBanner";
  banner.className = "server-offline-banner";
  banner.setAttribute("role", "alert");
  const label = document.createElement("span");
  label.textContent = `⚠️ ${SERVER_OFFLINE_MSG}`;
  const dismiss = document.createElement("button");
  dismiss.id = "btnDismissOfflineBanner";
  dismiss.className = "server-offline-dismiss";
  dismiss.title = "Dismiss";
  dismiss.setAttribute("aria-label", "Dismiss offline warning");
  dismiss.textContent = "✕";
  dismiss.addEventListener("click", () => {
    serverBannerDismissed = true;
    ensureOfflineBanner();
  });
  banner.appendChild(label);
  banner.appendChild(dismiss);
  container.prepend(banner);
}

function formatDurationSaved(seconds) {
  const mins = Math.max(0, Math.round((seconds || 0) / 60));
  if (mins < 60) return `${mins}m`;
  const hrs = (mins / 60).toFixed(1).replace(/\.0$/, "");
  return `${hrs}h`;
}

function parseTimestampToSec(ts) {
  const clean = String(ts || "").replace(/[\[\]]/g, "").trim();
  const parts = clean.split(":").map((n) => parseInt(n, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function formatTimestampFromSec(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function openWatchAtTimestamp(videoId, startSec) {
  const sec = Number(startSec) || 0;
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${sec}s`;
  if (typeof chrome !== "undefined" && chrome.tabs?.query) {
    try {
      chrome.tabs.query({ url: "*://*.youtube.com/watch*" }, (tabs) => {
        const match =
          Array.isArray(tabs) &&
          tabs.find((t) => t.url && t.url.includes(`v=${videoId}`));
        if (match && match.id != null) chrome.tabs.update(match.id, { url });
        else if (chrome.tabs.create) chrome.tabs.create({ url });
        else window.open(url, "_blank", "noopener");
      });
      return;
    } catch {}
  }
  window.open(url, "_blank", "noopener");
}

function syncYouTubeWatchTab(videoId, startSec) {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return;
  try {
    chrome.tabs.query({ url: "*://*.youtube.com/watch*" }, (tabs) => {
      if (!Array.isArray(tabs) || tabs.length === 0) return;
      const match =
        tabs.find((t) => t.url && t.url.includes(`v=${videoId}`)) ||
        tabs.find((t) => t.active && t.url && t.url.includes(`v=${videoId}`));
      if (match && match.id != null) {
        chrome.tabs.update(match.id, {
          url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${startSec}s`,
        });
      }
    });
  } catch {}
}

async function recordMetricEvent(event) {
  try {
    const res = await fetch("/api/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
    });
    const data = await res.json();
    if (res.ok) {
      const usageEvent = { timestampClick: "timestamp_clicked", ttsPlay: "tts_played" }[event];
      if (usageEvent) void captureUsage(usageEvent);
    }
    if (data?.metrics) {
      state.metrics = data.metrics;
      renderMetricsUI();
    }
  } catch {}
}

// --- Anonymous usage capture (PostHog, Item 3 variant B) ---
// Standalone-only, opt-in gated, fire-and-forget. Never throws into callers.
// shortcut: events are lost if the page closes mid-send; add a persisted
// queue only if scan-completion counts prove unreliable.
const POSTHOG_KEY =
  typeof __RADAR_POSTHOG_KEY__ !== "undefined" ? __RADAR_POSTHOG_KEY__ : "";
const POSTHOG_HOST =
  typeof __RADAR_POSTHOG_HOST__ !== "undefined" && __RADAR_POSTHOG_HOST__
    ? __RADAR_POSTHOG_HOST__
    : "https://eu.i.posthog.com";
const TELEMETRY_NOTICE_FLAG = "radarTelemetryNoticeShown";

async function ensureTelemetryNotice() {
  if (!STANDALONE_ROUTE) return;
  try {
    const stored = await chrome.storage.local.get([TELEMETRY_NOTICE_FLAG]);
    if (stored?.[TELEMETRY_NOTICE_FLAG]) return;
    el("telemetryNotice")?.classList.remove("hidden");
    await chrome.storage.local.set({ [TELEMETRY_NOTICE_FLAG]: true });
  } catch {
    el("telemetryNotice")?.classList.remove("hidden");
  }
}

let telemetryIdentity;
let dashboardOpenCaptured = false;
function captureDashboardOpened() {
  if (!STANDALONE_ROUTE || !state.sync?.telemetryOptIn || dashboardOpenCaptured) return;
  dashboardOpenCaptured = true;
  void captureUsage("dashboard_opened", {
    has_api_key: Boolean(state.hasApiKey),
    topics_count_bucket: countBucket(state.sync.topics.length),
    digests_count_bucket: countBucket(Object.keys(state.digests || {}).length),
  });
}

async function captureUsage(event, props = {}) {
  try {
    if (!STANDALONE_ROUTE) return;
    if (!state.sync?.telemetryOptIn) return;
    if (!POSTHOG_KEY) return;
    await ensureTelemetryNotice();
    if (
      typeof chrome === "undefined" ||
      !chrome.storage?.local ||
      typeof crypto?.randomUUID !== "function"
    )
      return;
    // A shared promise keeps concurrent first events on the same installation ID.
    telemetryIdentity ||= chrome.storage.local.get(["radarAnonId"]).then(async (stored) => {
      const id = stored?.radarAnonId || crypto.randomUUID();
      if (!stored?.radarAnonId) await chrome.storage.local.set({ radarAnonId: id });
      return id;
    });
    const anonId = await telemetryIdentity.catch(() => {
      telemetryIdentity = undefined;
      return null;
    });
    if (!anonId || !state.sync?.telemetryOptIn) return;
    let version = "";
    try {
      version = chrome.runtime?.getManifest?.()?.version || "";
    } catch {}
    let browser;
    try {
      browser = browserBucket(
        navigator.userAgent,
        Boolean(navigator.brave),
        navigator.userAgentData?.brands
      );
    } catch {
      browser = undefined;
    }
    const payload = buildCapturePayload({
      apiKey: POSTHOG_KEY,
      event,
      distinctId: anonId,
      version,
      props: { ...(props || {}), browser },
    });
    const host = String(POSTHOG_HOST || "https://eu.i.posthog.com").replace(
      /\/+$/,
      ""
    );
    void (origFetch || fetch)(`${host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

async function loadState() {
  try {
    const res = await fetch("/api/state");
    if (!res.ok) throw new Error(`Failed to load state (${res.status})`);
    state = await res.json();
    state.sync.topicMeta = state.sync.topicMeta || {};
    if (!initialLoadDone) {
      const paramTopic = new URLSearchParams(location.search).get("topic");
      if (paramTopic && state.sync.topics.includes(paramTopic)) {
        activeTopic = paramTopic;
      }
      if (paramTopic) {
        history.replaceState(null, "", location.pathname);
      }
      initialLoadDone = true;
      resetRssUnread();
      captureDashboardOpened();
    }
    if (!state.sync.topics.includes(activeTopic)) {
      activeTopic = state.sync.topics[0] || "";
    }
    if (!starterAutoCollapsedOnce && state.sync.topics.length >= 4) {
      el("starterPacksDetails").removeAttribute("open");
      starterAutoCollapsedOnce = true;
    }
    setOfflineMode(false);
    renderAll();
  } catch (err) {
    if (isServerUnreachable(err)) {
      setOfflineMode(true);
      renderAll();
      showToast(SERVER_OFFLINE_MSG, true);
      return;
    }
    showToast(err?.message || "Failed to load state", true);
  }
}

async function saveSync(nextSync) {
  const previousSync = state.sync;
  state.sync = nextSync;
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextSync),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      state.sync = previousSync;
      await loadState();
      const messages = {
        upgrade_required: "Free limit (5 topics) reached — upgrade for unlimited topics + RSS auto-updates and alerts.",
        stale_state: "Topics changed in another tab. Refreshed; please try again.",
      };
      showToast(messages[data.error] || data.error || "Save failed", true);
      return;
    }
    const data = await res.json();
    state.sync = data.sync;
    for (const topic of previousSync.topics) {
      if (!state.sync.topics.includes(topic)) delete state.digests[topic];
    }
    setOfflineMode(false);
  } catch (err) {
    state.sync = previousSync;
    if (isServerUnreachable(err)) {
      setOfflineMode(true);
      serverUnreachableToast("save");
    } else {
      showToast(err?.message || "Save failed", true);
    }
  }
  if (!starterAutoCollapsedOnce && state.sync.topics.length >= 4) {
    el("starterPacksDetails").removeAttribute("open");
    starterAutoCollapsedOnce = true;
  }
  renderAll();
}

function renderMetricsUI() {
  const m = state.metrics || {};
  const timeStr = formatDurationSaved(m.secondsSaved || 0);
  el("footerTimeSaved").textContent = `⏱️ ${timeStr} saved`;
  el("footerVideosDistilled").textContent = `${m.videosSummarized || 0} vids distilled`;
  el("headerMetricsText").textContent = `⏱️ ${timeStr} saved • ${m.videosSummarized || 0} vids (${m.slopVideosFiltered || 0} clickbait skipped)`;

  if (state.monetization?.supportUrl) {
    const supportHref = state.monetization.supportUrl;
    if (el("supportLinkBtn")) el("supportLinkBtn").href = supportHref;
    if (el("supportLinkBtnMobile")) el("supportLinkBtnMobile").href = supportHref;
  }

  el("telemetryToggle").checked = Boolean(state.sync?.telemetryOptIn);
  const proEnabled = state.monetization?.proEnabled !== false;
  const proToggle = el("proToggle");
  if (proToggle) {
    proToggle.checked = isPro();
    const proRow = proToggle.closest("label");
    if (proRow) proRow.classList.toggle("hidden", !proEnabled);
  }
  const upgradeLine = el("footerUpgradeLine");
  if (upgradeLine) {
    const atCap =
      proEnabled &&
      !isPro() &&
      state.sync.topics.length >= (state.monetization?.freeTopicLimit || 5);
    upgradeLine.classList.toggle("hidden", !atCap);
    if (state.monetization?.proUpgradeUrl) {
      upgradeLine.href = state.monetization.proUpgradeUrl;
    }
  }
  el("settingsMetricsGrid").innerHTML = `
    <div class="bg-slate-900 p-1.5 rounded border border-slate-800">⏱️ Saved: <b class="text-emerald-400">${timeStr}</b></div>
    <div class="bg-slate-900 p-1.5 rounded border border-slate-800">🎬 Distilled: <b class="text-slate-200">${m.videosSummarized || 0}</b></div>
    <div class="bg-slate-900 p-1.5 rounded border border-slate-800">🛡️ Slop Skipped: <b class="text-slate-200">${m.slopVideosFiltered || 0}</b></div>
    <div class="bg-slate-900 p-1.5 rounded border border-slate-800">▶ Jumps / 🔊 TTS: <b class="text-slate-200">${m.timestampClicks || 0} / ${m.ttsPlays || 0}</b></div>
  `;
}

function renderSidebar() {
  renderMetricsUI();

  // Key status
  const badge = el("keyStatusBadge");
  badge.textContent = state.hasApiKey ? `Key: ${state.maskedKey}` : "No API Key";
  el("btnForgetKey")?.classList.toggle("hidden", !state.hasApiKey);
  badge.className = state.hasApiKey
    ? "px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300"
    : "px-2 py-0.5 rounded bg-amber-500/20 text-amber-300";

  // Filter tabs styling
  el("topicFilterTabs")
    .querySelectorAll("[data-tab]")
    .forEach((btn) => {
      const tab = btn.getAttribute("data-tab");
      btn.className =
        tab === topicFilterTab
          ? "flex-1 py-1 rounded bg-slate-800 text-white font-medium border border-slate-700"
          : "flex-1 py-1 rounded bg-slate-900/60 text-slate-400 hover:text-slate-200";
    });

  // Topics list (Starred first, filter query + tab)
  const meta = state.sync.topicMeta || {};
  el("topicCountBadge").textContent = String(state.sync.topics.length);
  const list = el("topicsList");
  list.innerHTML = "";

  const matchesFilter = (t) => {
    if (
      topicFilterQuery &&
      !t.toLowerCase().includes(topicFilterQuery.toLowerCase())
    ) {
      return false;
    }
    const hasDigest = Boolean(state.digests[t]?.videos?.length);
    const isStarred = Boolean(meta[t]?.starred);
    if (topicFilterTab === "ready") return hasDigest;
    if (topicFilterTab === "starred") return isStarred;
    return true;
  };

  // Organize so ★ Starred topics come first, filtered by search query and active tab
  const ordered = state.sync.topics
    .filter(matchesFilter)
    .sort(
      (a, b) =>
        Number(Boolean(meta[b]?.starred)) - Number(Boolean(meta[a]?.starred))
    );

  if (ordered.length === 0) {
    list.innerHTML = `<div class="text-xs text-slate-500 px-2 py-3 text-center">No matching topics</div>`;
  }

  for (const t of ordered) {
    const isActive = t === activeTopic;
    const vidCount = state.digests[t]?.videos?.length || 0;
    const hasDigest = vidCount > 0;
    const isStarred = Boolean(meta[t]?.starred);

    const row = document.createElement("div");
    row.className = `group flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer text-sm transition ${
      isActive
        ? "bg-red-600/20 text-white font-semibold border border-red-500/40"
        : "text-slate-300 hover:bg-slate-800/70"
    }`;
    row.innerHTML = `
      <div class="flex items-center gap-2 truncate flex-1 min-w-0">
        <span class="w-2 h-2 rounded-full shrink-0 ${hasDigest ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : "bg-slate-600"}"></span>
        <span class="truncate">${esc(t)}</span>
        ${t === scanningTopic ? `<span class="text-[10px] px-1.5 py-0.2 rounded bg-sky-500/15 text-sky-300 shrink-0 animate-pulse">● scanning</span>` : ""}
        ${hasDigest ? `<span class="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-300 shrink-0">${vidCount}</span>` : ""}
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button data-star="${esc(t)}" title="Star / Pin topic" class="${isStarred ? "text-amber-400 opacity-100" : "text-slate-500 opacity-0 group-hover:opacity-100"} hover:text-amber-300 px-1 text-xs">${isStarred ? "★" : "☆"}</button>
        <button data-remove="${esc(t)}" title="Remove topic" class="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-400 px-1 text-xs">✕</button>
      </div>
    `;
    row.addEventListener("click", (e) => {
      const starTarget = e.target.getAttribute("data-star");
      if (starTarget) {
        e.stopPropagation();
        const cur = state.sync.topicMeta?.[starTarget] || {};
        const nextMeta = {
          ...(state.sync.topicMeta || {}),
          [starTarget]: { ...cur, starred: !cur.starred },
        };
        saveSync({ ...state.sync, topicMeta: nextMeta });
        return;
      }
      const rm = e.target.getAttribute("data-remove");
      if (rm) {
        e.stopPropagation();
        const nextTopics = state.sync.topics.filter((x) => x !== rm);
        const nextMeta = { ...(state.sync.topicMeta || {}) };
        delete nextMeta[rm];
        if (activeTopic === rm) activeTopic = nextTopics[0] || "";
        saveSync({ ...state.sync, topics: nextTopics, topicMeta: nextMeta });
        return;
      }
      activeTopic = t;
      closeSidebarOnMobile();
      renderAll();
    });
    list.appendChild(row);
  }

  // Pinned channels
  const pinnedSec = el("pinnedChannelsSection");
  const pinnedList = el("pinnedChannelsList");
  if (state.sync.pinnedChannels.length > 0) {
    pinnedSec.classList.remove("hidden");
    pinnedList.innerHTML = state.sync.pinnedChannels
      .map(
        (c) => `
      <div class="flex items-center justify-between px-2.5 py-1.5 rounded bg-slate-800/60 text-slate-300">
        <span class="truncate">📌 ${esc(c.channelName)} <span class="text-slate-500">(${esc(c.topic)})</span></span>
        <button data-unpin="${esc(c.channelId)}" class="text-slate-400 hover:text-rose-400 ml-2">✕</button>
      </div>`
      )
      .join("");
    pinnedList.querySelectorAll("[data-unpin]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-unpin");
        saveSync({
          ...state.sync,
          pinnedChannels: state.sync.pinnedChannels.filter(
            (x) => x.channelId !== id
          ),
        });
      });
    });
  } else {
    pinnedSec.classList.add("hidden");
  }

  // Starter Packs
  const packs = el("starterPacksContainer");
  packs.innerHTML = "";
  for (const [cat, items] of Object.entries(state.starterTopics)) {
    const block = document.createElement("div");
    block.innerHTML = `<div class="text-[11px] text-slate-400 mb-1.5 font-medium">${esc(cat)}</div>`;
    const pills = document.createElement("div");
    pills.className = "flex flex-wrap gap-1.5";
    for (const item of items) {
      const subscribed = state.sync.topics.includes(item);
      const btn = document.createElement("button");
      btn.className = `text-xs px-2.5 py-1 rounded-full border transition ${
        subscribed
          ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
          : "bg-slate-800/80 border-slate-700 text-slate-300 hover:border-slate-500"
      }`;
      btn.textContent = subscribed ? `✓ ${item}` : `+ ${item}`;
      btn.addEventListener("click", () => {
        if (!subscribed) {
          if (!canAddMoreTopics()) return;
          activeTopic = item;
          closeSidebarOnMobile();
          saveSync({ ...state.sync, topics: [...state.sync.topics, item] });
        } else {
          activeTopic = item;
          closeSidebarOnMobile();
          renderAll();
        }
      });
      pills.appendChild(btn);
    }
    block.appendChild(pills);
    packs.appendChild(block);
  }
}

function renderAll() {
  if (!state.sync.topics.includes(activeTopic)) activeTopic = state.sync.topics[0] || "";
  renderSidebar();
  renderMainDigest();
  ensureOfflineBanner();
}

function canAddMoreTopics() {
  const cfg = state.monetization || {};
  if (cfg.proEnabled === false) return true;
  if (!isPro() && state.sync.topics.length >= (cfg.freeTopicLimit || 5)) {
    showToast(
      "Free limit (5 topics) reached — upgrade for unlimited topics + RSS auto-updates and alerts.",
      true
    );
    return false;
  }
  return true;
}

function renderMainDigest() {
  el("activeTopicTitle").textContent = activeTopic || "Select or add a topic";
  const digest = state.digests[activeTopic];
  const container = el("digestContainer");

  if (shouldShowScanning(scanningTopic, activeTopic)) {
    el("lastScannedBadge").textContent =
      "Scanning YouTube & extracting insights...";
    container.innerHTML = `
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center space-y-3 animate-pulse">
        <div class="text-3xl">🛰️</div>
        <div class="text-lg font-semibold text-white">Scanning YouTube for "${esc(activeTopic)}"...</div>
        <p class="text-sm text-slate-400 max-w-md mx-auto">
          Searching recent uploads → Filtering out clickbait & shorts → Extracting timed transcripts → Running structured Gemini breakdown...
        </p>
      </div>
    `;
    ensureOfflineBanner();
    return;
  }

  if (!digest || !digest.videos || digest.videos.length === 0) {
    el("lastScannedBadge").textContent = "Not scanned yet";
    container.innerHTML = `
      <div class="bg-slate-900/60 border border-slate-800 rounded-xl p-10 text-center space-y-3">
        <div class="text-3xl">🔭</div>
        <div class="text-lg font-semibold text-slate-200">No digest generated for "${esc(activeTopic)}" yet</div>
        <p class="text-sm text-slate-400 max-w-md mx-auto">
          Click <b>Scan Topic Now</b> in the top-right to discover the highest-signal YouTube videos and extract their complete timestamped breakdown.
        </p>
      </div>
    `;
    ensureOfflineBanner();
    return;
  }

  const dateStr = new Date(digest.generatedAt).toLocaleString();
  el("lastScannedBadge").textContent = `Updated ${dateStr}`;

  const subtopicsHtml = (digest.suggestedSubtopics || [])
    .map(
      (st) =>
        `<button data-subtopic="${esc(st)}" class="text-xs bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-indigo-500/30 px-2.5 py-1 rounded-full transition">+ Track "${esc(st)}"</button>`
    )
    .join("");

  const skippedList = Array.isArray(digest.skippedVideos) ? digest.skippedVideos : [];
  const skipNote = (() => {
    const summarized = digest.videos.length;
    const requested = Number(digest.requestedCount || summarized);
    if (skippedList.length === 0 && summarized === requested) return "";
    const titles = skippedList.map((s) => esc(s.title)).join(" · ");
    let text =
      skippedList.length > 0
        ? summarized === requested
          ? `${summarized} of ${requested} summarized · ${skippedList.length} skipped & replaced`
          : `${summarized} of ${requested} summarized · ${skippedList.length} skipped`
        : `${summarized} of ${requested} summarized`;
    if (summarized < requested && digest.stopReason === "pool_exhausted") {
      text += " · no more eligible videos found";
    } else if (summarized < requested && digest.stopReason === "attempt_limit") {
      text += " · replacement limit reached";
    }
    return `<p class="text-xs text-amber-300/90 pt-1" title="${titles}">${text}</p>`;
  })();

  // Transcript download is a Pro plan feature (see proFeatures in storage.ts):
  // hidden entirely unless Pro — no greyed teaser in V1.
  const transcriptPro = isPro();

  const videosHtml = digest.videos
    .map((v, idx) => {
      const verdictColor =
        v.worthWatchingFull === "Yes"
          ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
          : v.worthWatchingFull === "Skim timestamps"
          ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
          : "bg-slate-700/50 text-slate-300 border-slate-600";

      const chaptersHtml = (v.chapterBreakdown || [])
        .map(
          (c) => `
          <div class="border-l-2 border-slate-700 pl-3 py-1 space-y-1">
            <div class="flex items-center gap-2">
              <button data-vid="${esc(v.videoId)}" data-vtitle="${encodeURIComponent(v.title)}" data-ts="${esc(c.timestamp)}" class="font-mono text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 px-2 py-0.5 rounded border border-red-500/30 transition">
                ▶ [${esc(c.timestamp)}]
              </button>
              <span class="font-semibold text-slate-200 text-sm">${esc(c.sectionTitle)}</span>
            </div>
            <ul class="list-disc list-inside text-slate-300 text-sm space-y-0.5 pl-1">
              ${(c.keyPoints || []).map((kp) => `<li>${esc(kp)}</li>`).join("")}
            </ul>
          </div>`
        )
        .join("");

      const detailsHtml = (v.typeSpecificDetails || [])
        .map(
          (d) => `
          <div class="bg-slate-950/70 border border-slate-800/80 rounded-lg p-3">
            <div class="text-xs font-bold uppercase tracking-wider text-indigo-400 mb-1.5">${esc(d.label)}</div>
            <ul class="list-disc list-inside text-xs text-slate-300 space-y-1">
              ${(d.items || []).map((item) => `<li>${esc(item)}</li>`).join("")}
            </ul>
          </div>`
        )
        .join("");

      return `
        <article class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4 shadow">
          <div class="flex items-start justify-between gap-4">
            <div class="space-y-1">
              <div class="flex flex-wrap items-center gap-2 text-xs">
                <span class="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-semibold uppercase">${esc(String(v.videoType).replace("_", " "))}</span>
                <span class="px-2 py-0.5 rounded border ${verdictColor} font-medium">Verdict: ${esc(v.worthWatchingFull)}</span>
                <span class="text-slate-400">Signal ${esc(v.signalScore)}/100 • ${esc(v.durationText)}</span>
              </div>
              <h3 class="text-lg font-bold text-white leading-snug">
                ${/^https?:\/\//i.test(String(v.url ?? "")) ? `<a href="${esc(v.url)}" target="_blank" class="hover:text-red-400 transition">${idx + 1}. ${esc(v.title)}</a>` : `<span>${idx + 1}. ${esc(v.title)}</span>`}
              </h3>
              <div class="text-xs text-slate-400">Channel: <span class="text-slate-200 font-medium">${esc(v.channelName)}</span></div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button data-tts="${idx}" class="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition">🔊 Read Aloud</button>
              ${transcriptPro ? `<button data-transcript="${idx}" title="Download timestamped transcript (.txt)" class="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition">⬇ Transcript</button>` : ""}
              <button data-pin-id="${esc(v.channelId)}" data-pin-name="${esc(v.channelName)}" class="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition">📌 Pin Channel</button>
            </div>
          </div>

          <!-- Core Thesis Box -->
          <div class="bg-slate-950 border border-slate-800 rounded-lg p-3.5 text-sm text-slate-200 leading-relaxed">
            <span class="font-bold text-red-400 uppercase text-xs mr-1.5">Core Takeaway:</span>
            ${esc(v.coreThesis)}
            <div class="text-xs text-slate-400 mt-1 italic">Why watch/skip: ${esc(v.worthWatchingReason)}</div>
          </div>

          <!-- Type-Specific Extracted Details -->
          ${detailsHtml ? `<div class="grid grid-cols-1 md:grid-cols-2 gap-3">${detailsHtml}</div>` : ""}

          <!-- Complete Chronological Chapter Breakdown -->
          <details open class="group">
            <summary class="cursor-pointer text-xs font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200 select-none">
              Chronological Section Breakdown (${(v.chapterBreakdown || []).length} sections — click any timestamp to jump)
            </summary>
            <div class="mt-3 space-y-3">
              ${chaptersHtml}
            </div>
          </details>
        </article>
      `;
    })
    .join("");

  container.innerHTML = `
    <!-- Top Synthesis Card -->
    <section class="bg-gradient-to-br from-indigo-950/60 via-slate-900 to-slate-900 border border-indigo-500/30 rounded-xl p-5 space-y-3 shadow-lg">
      <div class="flex items-center justify-between">
        <div class="text-xs font-bold uppercase tracking-wider text-indigo-300 flex items-center gap-1.5">
          <span>🌐 Cross-Video Topic Synthesis</span>
          <span class="text-slate-400 font-normal">(${digest.videos.length} videos analyzed)</span>
        </div>
        <button id="btnReadSynthesis" class="text-xs bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 px-2.5 py-1 rounded border border-indigo-500/30">🔊 Read Synthesis</button>
      </div>
      ${skipNote}
      <p class="text-sm text-slate-200 leading-relaxed">${esc(digest.crossVideoSynthesis)}</p>
      ${
        subtopicsHtml
          ? `<div class="pt-2 border-t border-slate-800/80 flex flex-wrap items-center gap-2">
               <span class="text-xs text-slate-400">AI Suggested Sub-topics:</span>
               ${subtopicsHtml}
             </div>`
          : ""
      }
    </section>

    <!-- Video Digest Cards -->
    <section class="space-y-5">
      ${videosHtml}
    </section>
  `;

  // Bind subtopic pills
  container.querySelectorAll("[data-subtopic]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const st = btn.getAttribute("data-subtopic");
      if (st && !state.sync.topics.includes(st)) {
        if (!canAddMoreTopics()) return;
        activeTopic = st;
        saveSync({
          ...state.sync,
          topics: [...state.sync.topics, st],
        });
        showToast(`Added "${st}" to your topics`);
      }
    });
  });

  // Bind timestamp buttons -> open Side Panel Player at exact second & record metric
  container.querySelectorAll("[data-ts]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const vid = btn.getAttribute("data-vid");
      const vtitle = decodeURIComponent(btn.getAttribute("data-vtitle") || "");
      const ts = btn.getAttribute("data-ts");
      const sec = parseTimestampToSec(ts);
      const videoObj = digest.videos.find((x) => x.videoId === vid);
      recordMetricEvent("timestampClick");
      openSidePanelPlayer(vid, vtitle, sec, videoObj);
    });
  });

  // Bind Read Aloud (TTS) & record metric
  const synthBtn = el("btnReadSynthesis");
  if (synthBtn) {
    synthBtn.addEventListener("click", () => {
      recordMetricEvent("ttsPlay");
      speakText(digest.crossVideoSynthesis);
    });
  }
  container.querySelectorAll("[data-tts]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-tts"));
      const v = digest.videos[idx];
      if (!v) return;
      recordMetricEvent("ttsPlay");
      const script = `${v.title} by ${v.channelName}. Core takeaway: ${v.coreThesis}. ${v.chapterBreakdown
        .map((c) => `At ${c.timestamp}, ${c.sectionTitle}: ${c.keyPoints.join(". ")}`)
        .join(". ")}`;
      speakText(script);
    });
  });

  // Bind Transcript Download (Pro-only; button isn't rendered when free)
  container.querySelectorAll("[data-transcript]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.getAttribute("data-transcript"));
      const v = digest.videos[idx];
      if (!v) return;
      await downloadTranscript(v);
    });
  });

  // Bind Pin Channel
  container.querySelectorAll("[data-pin-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const channelId = btn.getAttribute("data-pin-id") || "";
      const channelName = btn.getAttribute("data-pin-name") || "Channel";
      if (!channelId) return;
      const exists = state.sync.pinnedChannels.some(
        (c) => c.channelId === channelId
      );
      if (!exists) {
        saveSync({
          ...state.sync,
          pinnedChannels: [
            ...state.sync.pinnedChannels,
            { channelId, channelName, topic: activeTopic },
          ],
        });
        showToast(`Pinned ${channelName} to RSS monitor`);
      }
    });
  });
}

// --- TTS voice cache ---
// Chrome returns [] from getVoices() until its async voiceschanged fires, so a
// naive empty-check would false-positive on first click. Warm the cache at load
// and keep updating it; speakText waits briefly before declaring unsupported.
let ttsVoices = [];
function refreshTtsVoices() {
  try {
    const v = window.speechSynthesis?.getVoices?.() || [];
    if (v.length > 0) ttsVoices = v;
  } catch {}
}
refreshTtsVoices();
try {
  window.speechSynthesis?.addEventListener?.("voiceschanged", refreshTtsVoices);
} catch {}

function waitForTtsVoices(timeoutMs = 800) {
  refreshTtsVoices();
  if (ttsVoices.length > 0) return Promise.resolve(ttsVoices);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      refreshTtsVoices();
      resolve(ttsVoices);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      window.speechSynthesis.addEventListener("voiceschanged", () => {
        clearTimeout(timer);
        finish();
      }, { once: true });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

function ttsBrowserName() {
  try {
    return getBrowserName(
      navigator.userAgent,
      typeof navigator.brave !== "undefined",
      navigator.userAgentData?.brands
    );
  } catch {
    return "this browser";
  }
}

async function speakText(text) {
  const browser = ttsBrowserName();
  if (!("speechSynthesis" in window)) {
    showToast(`Read aloud not supported on ${browser}: speech synthesis unavailable`, true);
    return;
  }
  const voices = await waitForTtsVoices();
  if (ttsSupportStatus(true, voices.length) !== "ok") {
    showToast(`Read aloud not supported on ${browser}: no voices available`, true);
    return;
  }
  // cancel() before speak fires an error event ("interrupted"/"canceled") on
  // the previous utterance — that's the restart flow, not a failure.
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.05;
  utter.onerror = (e) => {
    if (e?.error === "interrupted" || e?.error === "canceled") return;
    showToast(`Read aloud failed on ${browser}`, true);
  };
  window.speechSynthesis.speak(utter);
  showToast("🔊 Reading aloud... (click again to restart)");
}

function openSidePanelPlayer(videoId, title, startSec, videoObj) {
  if (IS_EXTENSION_PAGE) {
    // Embeds can't play from chrome-extension:// (YT Error 153) — keep the
    // panel hidden and jump straight to the timestamp on YouTube instead.
    el("videoSidePanel").classList.add("hidden");
    openWatchAtTimestamp(videoId, startSec);
    return;
  }
  const panel = el("videoSidePanel");
  panel.classList.remove("hidden");
  el("sidePanelTitle").textContent = title;
  const safeVid = encodeURIComponent(videoId);
  const startNum = Number(startSec) || 0;
  el("ytPlayerIframe").src = `https://www.youtube.com/embed/${safeVid}?start=${startNum}&autoplay=1`;
  syncYouTubeWatchTab(videoId, startNum);

  const notes = el("sidePanelNotes");
  const watchLinkHtml = `<a id="sidePanelYtWatchLink" href="https://www.youtube.com/watch?v=${safeVid}&t=${startNum}s" target="_blank" rel="noopener noreferrer" class="inline-block text-xs text-indigo-300 hover:underline">↗ Open on YouTube at ${esc(formatTimestampFromSec(startNum))}</a>`;

  if (videoObj) {
    notes.innerHTML = `
      ${watchLinkHtml}
      <div class="text-xs font-semibold uppercase text-red-400">Docked Summary Notes</div>
      <p class="text-xs text-slate-300">${esc(videoObj.coreThesis)}</p>
      <div class="space-y-2 pt-2">
        ${(videoObj.chapterBreakdown || [])
          .map(
            (c) => `
          <div class="p-2 rounded bg-slate-950 border border-slate-800">
            <button data-jump="${parseTimestampToSec(c.timestamp)}" class="font-mono text-xs text-red-400 hover:underline">[${esc(c.timestamp)}] ${esc(c.sectionTitle)}</button>
            <ul class="list-disc list-inside text-xs text-slate-300 mt-1 space-y-0.5">
              ${c.keyPoints.map((k) => `<li>${esc(k)}</li>`).join("")}
            </ul>
          </div>`
          )
          .join("")}
      </div>
    `;
    notes.querySelectorAll("[data-jump]").forEach((b) => {
      b.addEventListener("click", () => {
        const s = Number(b.getAttribute("data-jump")) || 0;
        recordMetricEvent("timestampClick");
        el("ytPlayerIframe").src = `https://www.youtube.com/embed/${safeVid}?start=${s}&autoplay=1`;
        const watchLink = el("sidePanelYtWatchLink");
        if (watchLink) {
          watchLink.href = `https://www.youtube.com/watch?v=${safeVid}&t=${s}s`;
          watchLink.textContent = `↗ Open on YouTube at ${formatTimestampFromSec(s)}`;
        }
        syncYouTubeWatchTab(videoId, s);
      });
    });
  } else {
    notes.innerHTML = watchLinkHtml;
  }
}

// Plain-text transcript format (one [MM:SS] line per block). If format specs
// later call for .srt/.vtt, only this formatter changes — endpoint stays JSON.
function transcriptToText(video, blocks) {
  const lines = [
    video.title,
    `Channel: ${video.channelName}`,
    `https://www.youtube.com/watch?v=${video.videoId}`,
    "",
  ];
  for (const b of blocks) lines.push(`[${b.timestamp}] ${b.text}`);
  return lines.join("\n");
}

async function downloadTranscript(v) {
  try {
    const res = await fetch(`/api/transcript?videoId=${encodeURIComponent(v.videoId)}`);
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) {
      showToast("Transcript download is a Pro feature — upgrade to unlock", true);
      return;
    }
    if (!res.ok || !Array.isArray(data.blocks) || data.blocks.length === 0) {
      throw new Error(data.error || "Transcript unavailable for this video");
    }
    const blob = new Blob([transcriptToText(v, data.blocks)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safe = v.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || v.videoId;
    a.download = `${safe}-${v.videoId}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Downloaded transcript");
  } catch (err) {
    if (isServerUnreachable(err)) {
      setOfflineMode(true);
      serverUnreachableToast("download transcript");
    } else {
      showToast(err?.message || "Transcript download failed", true);
    }
  }
}

// Event Listeners
el("btnToggleSidebar")?.addEventListener("click", () => {
  const isOpen = el("topicsSidebar")?.classList.contains("sidebar-open");
  setSidebarDrawerOpen(!isOpen);
});

el("sidebarBackdrop")?.addEventListener("click", () => {
  setSidebarDrawerOpen(false);
});

el("btnCloseSidePanel").addEventListener("click", () => {
  el("ytPlayerIframe").src = "";
  el("videoSidePanel").classList.add("hidden");
});

el("btnSettingsToggle").addEventListener("click", () => {
  el("settingsPanel").classList.toggle("hidden");
});

el("btnDismissTelemetryNotice")?.addEventListener("click", () => {
  try {
    el("telemetryNotice")?.classList.add("hidden");
    chrome.storage?.local
      ?.set({ [TELEMETRY_NOTICE_FLAG]: true })
      .catch(() => {});
  } catch {}
});

el("telemetryToggle").addEventListener("change", async (e) => {
  await saveSync({ ...state.sync, telemetryOptIn: Boolean(e.target.checked) });
  captureDashboardOpened();
  showToast(
    state.sync.telemetryOptIn
      ? "Anonymous usage stats enabled"
      : "Anonymous usage stats disabled"
  );
});

el("proToggle")?.addEventListener("change", async (e) => {
  const nextIsPro = Boolean(e.target.checked);
  try {
    const res = await fetch("/api/entitlements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPro: nextIsPro }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to update Pro status");
    setOfflineMode(false);
    try {
      if (
        !(
          typeof __RADAR_STANDALONE_BUILD__ !== "undefined" &&
          __RADAR_STANDALONE_BUILD__
        ) &&
        typeof chrome !== "undefined" &&
        chrome.alarms
      ) {
        if (nextIsPro) {
          chrome.alarms.create("rss-poll", { periodInMinutes: 30 });
        } else {
          await chrome.alarms.clear("rss-poll");
          if (chrome.storage?.local) {
            await chrome.storage.local.set({ rssSeen: {}, rssUnread: 0 });
          }
          if (chrome.action?.setBadgeText) {
            chrome.action.setBadgeText({ text: "" });
          }
        }
      }
      if (
        !(
          typeof __RADAR_STANDALONE_BUILD__ !== "undefined" &&
          __RADAR_STANDALONE_BUILD__
        )
      ) {
        try {
          await chrome.runtime?.sendMessage?.({ type: "proChanged", isPro: nextIsPro });
        } catch {}
      }
    } catch {}
    await loadState();
    showToast(nextIsPro ? "Pro unlocked" : "Pro disabled");
  } catch (err) {
    await loadState();
    showToast(err?.message || "Failed to update Pro status", true);
  }
});

el("topicFilterInput").addEventListener("input", (e) => {
  topicFilterQuery = e.target.value || "";
  renderSidebar();
});

el("topicFilterTabs")
  .querySelectorAll("[data-tab]")
  .forEach((btn) => {
    btn.addEventListener("click", () => {
      topicFilterTab = btn.getAttribute("data-tab") || "all";
      renderSidebar();
    });
  });

el("btnSaveKey").addEventListener("click", async () => {
  if (isServerOffline) {
    serverUnreachableToast("save key");
    return;
  }
  const key = el("apiKeyInput").value.trim();
  if (!key) return;
  if (state.hasApiKey && !confirm("Replace the saved Gemini API key?")) return;
  try {
    const res = await fetch("/api/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: key }),
    });
    if (!res.ok) throw new Error("Save failed");
    setOfflineMode(false);
  } catch (err) {
    if (isServerUnreachable(err)) {
      setOfflineMode(true);
      serverUnreachableToast("save key");
      return;
    }
    showToast(err?.message || "Save failed", true);
    return;
  }
  el("apiKeyInput").value = "";
  void captureUsage("api_key_saved");
  showToast("Saved Gemini API key");
  await loadState();
});

el("btnForgetKey").addEventListener("click", async () => {
  if (isServerOffline) {
    serverUnreachableToast("forget key");
    return;
  }
  if (!confirm("Forget the saved Gemini API key? You will need to paste it again to scan.")) return;
  try {
    const res = await fetch("/api/key/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error("Forget failed");
    setOfflineMode(false);
  } catch (err) {
    if (isServerUnreachable(err)) {
      setOfflineMode(true);
      serverUnreachableToast("forget key");
      return;
    }
    showToast(err?.message || "Forget failed", true);
    return;
  }
  showToast("Forgot Gemini API key");
  await loadState();
});

el("addTopicForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (isServerOffline) {
    serverUnreachableToast("add topic");
    return;
  }
  const val = el("newTopicInput").value.trim();
  if (!val) return;
  if (!state.sync.topics.includes(val) && !canAddMoreTopics()) return;
  el("newTopicInput").value = "";
  activeTopic = val;
  closeSidebarOnMobile();
  if (!state.sync.topics.includes(val)) {
    saveSync({ ...state.sync, topics: [val, ...state.sync.topics] });
  } else {
    renderAll();
  }
});

// Task 1 Fix: Call renderAll() on scan completion so the sidebar green dot & video count badge update immediately!
el("btnScanTopic").addEventListener("click", async () => {
  if (isServerOffline) {
    serverUnreachableToast("scan");
    return;
  }
  if (!activeTopic || scanningTopic) return;
  const topic = activeTopic;
  const scanStartedAt = Date.now();
  const metricsBefore = { ...state.metrics };
  let scanOutcome = "unknown";
  scanningTopic = topic;
  el("btnScanTopic").disabled = true;
  el("scanBtnText").textContent = "Scanning...";
  renderSidebar();
  renderMainDigest();

  try {
    const maxVideos = Number(el("scanCountSelect").value || 3);
    void captureUsage("scan_started", { max_videos: maxVideos });
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, maxVideos }),
    });
    const data = await res.json();
    if (!res.ok) {
      scanOutcome = scanErrorClass(data.error);
      if (data.error === "provider_unavailable") {
        showToast("Gemini is temporarily unavailable. Please try again later.", true);
        return;
      }
      if (data.error === "gemini_api_not_enabled" || data.error === "invalid_api_key") {
        showToast(`${data.message || "Gemini rejected this API key."} Your previous digest is unchanged.`, true);
        return;
      }
      if (data.error === "quota_exhausted" || data.error === "rate_limited") {
        const retry = Number(data.retryAfterSeconds);
        const retryText = Number.isFinite(retry) && retry > 0
          ? ` Try again in ${Math.ceil(retry)} seconds.`
          : " Please try again later.";
        const reason = data.error === "quota_exhausted"
          ? "Gemini quota exhausted."
          : "Gemini is rate limiting requests.";
        showToast(`${reason}${retryText} Your previous digest is unchanged.`, true);
        return;
      }
      if (data.error === "scan_in_progress") {
        showToast(
          `"${data.topic || "Another topic"}" is already scanning — please wait`,
          true
        );
        return;
      }
      throw new Error(data.error === "topic_changed"
        ? "Topic changed while scanning. Please scan it again."
        : data.error || "Scan failed");
    }
    scanOutcome = null;
    void captureUsage("scan_completed", {
      duration_bucket: durationBucket(Date.now() - scanStartedAt),
      videos_summarized: Math.max(0, (data.metrics?.videosSummarized || 0) - (metricsBefore.videosSummarized || 0)),
      requested_count: Number(data.digest.requestedCount ?? data.digest.videos.length),
      skipped_count: data.digest.skippedVideos?.length || 0,
      slop_filtered: Math.max(0, (data.metrics?.slopVideosFiltered || 0) - (metricsBefore.slopVideosFiltered || 0)),
      seconds_saved_delta: Math.max(0, (data.metrics?.secondsSaved || 0) - (metricsBefore.secondsSaved || 0)),
    });
    setOfflineMode(false);
    // Reload authoritative state: deletion/re-addition may have happened during this scan.
    await loadState();
    if (data.metrics) state.metrics = data.metrics;
    resetRssUnread();
    const summarized = data.digest.videos.length;
    const requested = Number(data.digest.requestedCount || summarized);
    const skipped = Array.isArray(data.digest.skippedVideos)
      ? data.digest.skippedVideos.length
      : 0;
    if (skipped > 0) {
      const msg =
        summarized === requested
          ? `Summarized ${summarized} videos for "${topic}" (${skipped} skipped & replaced)`
          : `Summarized ${summarized} of ${requested} videos for "${topic}" (${skipped} skipped)`;
      showToast(msg);
    } else if (summarized < requested) {
      showToast(`Summarized ${summarized} of ${requested} videos for "${topic}"`);
    } else {
      showToast(`Summarized ${summarized} videos for "${topic}"`);
    }
  } catch (err) {
    if (isServerUnreachable(err)) {
      setOfflineMode(true);
      serverUnreachableToast("scan");
    } else {
      showToast(err.message || "Scan failed", true);
    }
  } finally {
    if (scanOutcome !== null) void captureUsage("scan_failed", {
      duration_bucket: durationBucket(Date.now() - scanStartedAt),
      error_class: scanOutcome,
    });
    scanningTopic = "";
    el("btnScanTopic").disabled = isServerOffline;
    el("scanBtnText").textContent = "Scan Topic Now";
    renderAll();
  }
});

// 1-Click Export Backup
el("btnExportBackup").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/backup/export");
    if (!res.ok) throw new Error("Export failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `yt-topic-radar-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    void captureUsage("backup_exported");
    showToast("Exported backup .json");
  } catch (err) {
    void captureUsage("backup_export_failed", { error_class: "unknown" });
    showToast(err?.message || "Export failed", true);
  }
});

// 1-Click Import Backup
el("inputImportBackup").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  let importFailure = "unknown";
  try {
    const text = await file.text();
    const res = await fetch("/api/backup/import", {
      method: "POST",
      body: text,
    });
    const data = await res.json();
    if (!res.ok) {
      importFailure = importErrorClass(data.error);
      throw new Error(data.error || "Import failed");
    }
    void captureUsage("backup_imported", {
      topics_count_bucket: countBucket(data.topicsCount),
      digests_count_bucket: countBucket(data.digestsCount),
    });
    setOfflineMode(false);
    showToast(
      `Restored ${data.topicsCount} topics & ${data.digestsCount} digests`
    );
    await loadState();
  } catch (err) {
    void captureUsage("backup_import_failed", { error_class: importFailure });
    if (isServerUnreachable(err)) {
      setOfflineMode(true);
      serverUnreachableToast("import");
    } else {
      showToast(err.message || "Invalid backup file", true);
    }
  } finally {
    e.target.value = "";
  }
});

loadState();
ensureTelemetryNotice();
