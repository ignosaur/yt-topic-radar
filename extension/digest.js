const API_BASE =
  typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
    ? "http://localhost:3456"
    : "";
const origFetch = window.fetch;
window.fetch = function (input, init) {
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
    mode: "free_byok",
    freeTopicLimit: 10,
    supportUrl: "https://rzp.io/rzp/ypHoq1R",
  },
  starterTopics: {},
  hasApiKey: false,
  maskedKey: "",
};
let activeTopic = "";
let isScanning = false;
let topicFilterQuery = "";
let topicFilterTab = "all"; // "all" | "ready" | "starred"
let starterAutoCollapsedOnce = false;

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
    if (data?.metrics) {
      state.metrics = data.metrics;
      renderMetricsUI();
    }
  } catch {}
}

async function loadState() {
  const res = await fetch("/api/state");
  state = await res.json();
  state.sync.topicMeta = state.sync.topicMeta || {};
  if (!activeTopic && state.sync.topics.length > 0) {
    activeTopic = state.sync.topics[0];
  }
  if (!starterAutoCollapsedOnce && state.sync.topics.length >= 4) {
    el("starterPacksDetails").removeAttribute("open");
    starterAutoCollapsedOnce = true;
  }
  renderAll();
}

async function saveSync(nextSync) {
  state.sync = nextSync;
  await fetch("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextSync),
  });
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
    el("supportLinkBtn").href = state.monetization.supportUrl;
  }

  el("telemetryToggle").checked = Boolean(state.sync?.telemetryOptIn);
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
  renderSidebar();
  renderMainDigest();
}

function canAddMoreTopics() {
  const cfg = state.monetization || {};
  if (
    cfg.mode === "freemium" &&
    state.sync.topics.length >= (cfg.freeTopicLimit || 10)
  ) {
    showToast(
      `Free tier limit (${cfg.freeTopicLimit} topics) reached — click ☕ Support to unlock Pro!`,
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

  if (isScanning) {
    el("lastScannedBadge").textContent =
      "Scanning YouTube & extracting insights...";
    container.innerHTML = `
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center space-y-3 animate-pulse">
        <div class="text-3xl">🛰️</div>
        <div class="text-lg font-semibold text-white">Scanning YouTube for "${activeTopic}"...</div>
        <p class="text-sm text-slate-400 max-w-md mx-auto">
          Searching recent uploads → Filtering out clickbait & shorts → Extracting timed transcripts → Running structured Gemini breakdown...
        </p>
      </div>
    `;
    return;
  }

  if (!digest || !digest.videos || digest.videos.length === 0) {
    el("lastScannedBadge").textContent = "Not scanned yet";
    container.innerHTML = `
      <div class="bg-slate-900/60 border border-slate-800 rounded-xl p-10 text-center space-y-3">
        <div class="text-3xl">🔭</div>
        <div class="text-lg font-semibold text-slate-200">No digest generated for "${activeTopic}" yet</div>
        <p class="text-sm text-slate-400 max-w-md mx-auto">
          Click <b>Scan Topic Now</b> in the top-right to discover the highest-signal YouTube videos and extract their complete timestamped breakdown.
        </p>
      </div>
    `;
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
              <button data-vid="${v.videoId}" data-vtitle="${encodeURIComponent(v.title)}" data-ts="${c.timestamp}" class="font-mono text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 px-2 py-0.5 rounded border border-red-500/30 transition">
                ▶ [${c.timestamp}]
              </button>
              <span class="font-semibold text-slate-200 text-sm">${c.sectionTitle}</span>
            </div>
            <ul class="list-disc list-inside text-slate-300 text-sm space-y-0.5 pl-1">
              ${(c.keyPoints || []).map((kp) => `<li>${kp}</li>`).join("")}
            </ul>
          </div>`
        )
        .join("");

      const detailsHtml = (v.typeSpecificDetails || [])
        .map(
          (d) => `
          <div class="bg-slate-950/70 border border-slate-800/80 rounded-lg p-3">
            <div class="text-xs font-bold uppercase tracking-wider text-indigo-400 mb-1.5">${d.label}</div>
            <ul class="list-disc list-inside text-xs text-slate-300 space-y-1">
              ${(d.items || []).map((item) => `<li>${item}</li>`).join("")}
            </ul>
          </div>`
        )
        .join("");

      return `
        <article class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4 shadow">
          <div class="flex items-start justify-between gap-4">
            <div class="space-y-1">
              <div class="flex flex-wrap items-center gap-2 text-xs">
                <span class="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-semibold uppercase">${v.videoType.replace("_", " ")}</span>
                <span class="px-2 py-0.5 rounded border ${verdictColor} font-medium">Verdict: ${v.worthWatchingFull}</span>
                <span class="text-slate-400">Signal ${v.signalScore}/100 • ${v.durationText}</span>
              </div>
              <h3 class="text-lg font-bold text-white leading-snug">
                <a href="${esc(v.url)}" target="_blank" class="hover:text-red-400 transition">${idx + 1}. ${esc(v.title)}</a>
              </h3>
              <div class="text-xs text-slate-400">Channel: <span class="text-slate-200 font-medium">${esc(v.channelName)}</span></div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button data-tts="${idx}" class="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition">🔊 Read Aloud</button>
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
      <p class="text-sm text-slate-200 leading-relaxed">${digest.crossVideoSynthesis}</p>
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

function speakText(text) {
  if (!("speechSynthesis" in window)) {
    showToast("Speech synthesis not supported in this browser", true);
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.05;
  window.speechSynthesis.speak(utter);
  showToast("🔊 Reading aloud... (click again to restart)");
}

function openSidePanelPlayer(videoId, title, startSec, videoObj) {
  const panel = el("videoSidePanel");
  panel.classList.remove("hidden");
  el("sidePanelTitle").textContent = title;
  el("ytPlayerIframe").src = `https://www.youtube.com/embed/${videoId}?start=${startSec}&autoplay=1`;
  syncYouTubeWatchTab(videoId, startSec);

  const notes = el("sidePanelNotes");
  const watchLinkHtml = `<a id="sidePanelYtWatchLink" href="https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${startSec}s" target="_blank" rel="noopener noreferrer" class="inline-block text-xs text-indigo-300 hover:underline">↗ Open on YouTube at ${formatTimestampFromSec(startSec)}</a>`;

  if (videoObj) {
    notes.innerHTML = `
      ${watchLinkHtml}
      <div class="text-xs font-semibold uppercase text-red-400">Docked Summary Notes</div>
      <p class="text-xs text-slate-300">${videoObj.coreThesis}</p>
      <div class="space-y-2 pt-2">
        ${(videoObj.chapterBreakdown || [])
          .map(
            (c) => `
          <div class="p-2 rounded bg-slate-950 border border-slate-800">
            <button data-jump="${parseTimestampToSec(c.timestamp)}" class="font-mono text-xs text-red-400 hover:underline">[${c.timestamp}] ${c.sectionTitle}</button>
            <ul class="list-disc list-inside text-xs text-slate-300 mt-1 space-y-0.5">
              ${c.keyPoints.map((k) => `<li>${k}</li>`).join("")}
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
        el("ytPlayerIframe").src = `https://www.youtube.com/embed/${videoId}?start=${s}&autoplay=1`;
        const watchLink = el("sidePanelYtWatchLink");
        if (watchLink) {
          watchLink.href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${s}s`;
          watchLink.textContent = `↗ Open on YouTube at ${formatTimestampFromSec(s)}`;
        }
        syncYouTubeWatchTab(videoId, s);
      });
    });
  } else {
    notes.innerHTML = watchLinkHtml;
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

el("telemetryToggle").addEventListener("change", (e) => {
  saveSync({ ...state.sync, telemetryOptIn: Boolean(e.target.checked) });
  showToast(
    e.target.checked
      ? "Anonymous usage stats enabled"
      : "Anonymous usage stats disabled"
  );
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
  const key = el("apiKeyInput").value.trim();
  if (!key) return;
  await fetch("/api/key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: key }),
  });
  el("apiKeyInput").value = "";
  showToast("Saved Gemini API key");
  await loadState();
});

el("addTopicForm").addEventListener("submit", (e) => {
  e.preventDefault();
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
  if (!activeTopic || isScanning) return;
  isScanning = true;
  el("btnScanTopic").disabled = true;
  el("scanBtnText").textContent = "Scanning...";
  renderMainDigest();

  try {
    const maxVideos = Number(el("scanCountSelect").value || 3);
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: activeTopic, maxVideos }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Scan failed");
    state.digests[activeTopic] = data.digest;
    if (data.metrics) state.metrics = data.metrics;
    showToast(
      `Summarized ${data.digest.videos.length} videos for "${activeTopic}"`
    );
  } catch (err) {
    showToast(err.message || "Scan failed", true);
  } finally {
    isScanning = false;
    el("btnScanTopic").disabled = false;
    el("scanBtnText").textContent = "Scan Topic Now";
    renderAll();
  }
});

// 1-Click Export Backup
el("btnExportBackup").addEventListener("click", () => {
  window.location.href = `${API_BASE}/api/backup/export`;
  showToast("Exported backup .json");
});

// 1-Click Import Backup
el("inputImportBackup").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const res = await fetch("/api/backup/import", {
      method: "POST",
      body: text,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Import failed");
    showToast(
      `Restored ${data.topicsCount} topics & ${data.digestsCount} digests`
    );
    await loadState();
  } catch (err) {
    showToast(err.message || "Invalid backup file", true);
  } finally {
    e.target.value = "";
  }
});

loadState();
