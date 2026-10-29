import {
  searchAndFilterTopicWithStats,
  fetchTimestampedTranscript,
  fetchChannelRssVideos,
  collectWithBackfill,
  type VideoCandidate,
} from "./lib/youtube";
import {
  summarizeVideo,
  synthesizeTopicDigest,
  type TopicDigest,
} from "./lib/summarizer";
import {
  getSyncState,
  saveSyncState,
  getApiKey,
  saveApiKey,
  getDigests,
  saveTopicDigest,
  getMetrics,
  updateMetrics,
  getEntitlements,
  setEntitlements,
  exportBackupJson,
  importBackupJson,
  markVideoSeen,
  STARTER_TOPICS,
  MONETIZATION_CONFIG,
} from "./lib/storage";

const PORT = Number(process.env.PORT || 3456);

// Single-flight guard: at most one topic scan runs at a time (protects Gemini
// quota when two tabs / the extension panel scan concurrently). In-memory on
// purpose — it dies with the server, so a crash can never wedge it. The
// check-and-set below must stay synchronous (no await between check and set)
// to remain atomic under Bun's single thread.

// Allowed CORS origins: localhost (any port for dev) and chrome-extension pages.
// This prevents any arbitrary website from reading user data or burning Gemini quota.
// MV3 extension pages are already granted access via host_permissions and do not
// require CORS headers at all, but we include them for explicit clarity.
const ALLOWED_ORIGINS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^chrome-extension:\/\//,
];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.some((re) => re.test(origin));
  if (!allowed && origin) return {}; // unknown origin — no CORS headers
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// A hung network hop (search/transcript fetches carry no AbortSignal) could
// otherwise hold the lock forever, answering 409 to every future scan until a
// server restart. After this window the lock is treated as stale and the new
// scan supersedes it; the hung request may still finish in the background and
// its digest write is idempotent per topic.
const SCAN_STALE_MS = 10 * 60 * 1000;

let activeScan: { topic: string; since: number } | null = null;

// The scan pipeline itself (search -> filter -> transcript -> summarize ->
// synthesize). Returns { status, body }; the route handler wraps it with
// json() so CORS headers stay per-request. Separated from the lock/route
// logic so the single-flight guard stays small and auditable.
async function runScan(
  topic: string,
  maxVideos: number,
  apiKey: string
): Promise<{ status: number; body: unknown }> {
  let candidates: VideoCandidate[];
  let slopFilteredCount: number;
  try {
    const filtered = await searchAndFilterTopicWithStats(topic, maxVideos);
    candidates = filtered.rankedPool;
    slopFilteredCount = filtered.slopFilteredCount;
  } catch (err: any) {
    console.warn(`[scan] search failed for "${topic}": ${String(err?.message || err).slice(0, 200)}`);
    return {
      status: 502,
      body: { error: "YouTube search temporarily failed for this topic. Please retry." },
    };
  }
  let secondsSavedDelta = 0;

  const { results: summaries, skipped } = await collectWithBackfill(
    candidates,
    maxVideos,
    async (v) => {
      const t = await fetchTimestampedTranscript(v.videoId);
      const summary = await summarizeVideo(apiKey, v, t.blocks, t.chapters);
      secondsSavedDelta += Math.max(60, (v.durationSec || 600) - 90);
      await markVideoSeen(v.videoId);
      return summary;
    }
  );

  for (const s of skipped) {
    console.warn(`[scan] skipped video ${s.videoId}: ${s.reason}`);
  }
  const skippedVideos = skipped.map((s) => s.videoId);

  if (summaries.length === 0) {
    return {
      status: 502,
      body: {
        error:
          "None of the candidate videos could be summarized. Please retry or try another topic.",
        skippedVideos,
      },
    };
  }

  const synthesis = await synthesizeTopicDigest(apiKey, topic, summaries);
  const digest: TopicDigest = {
    topic,
    generatedAt: new Date().toISOString(),
    crossVideoSynthesis: synthesis.crossVideoSynthesis,
    suggestedSubtopics: synthesis.suggestedSubtopics,
    videos: summaries,
    requestedCount: maxVideos,
    ...(skipped.length > 0 ? { skippedVideos: skipped } : {}),
  };
  await saveTopicDigest(digest);

  const metrics = await updateMetrics({
    scansCompleted: 1,
    videosSummarized: summaries.length,
    slopVideosFiltered: slopFilteredCount,
    secondsSaved: secondsSavedDelta,
  });

  console.log(
    `[scan] topic="${topic}" requested=${maxVideos} summarized=${summaries.length} skipped=${skipped.length}`
  );

  return { status: 200, body: { ok: true, digest, metrics, skippedVideos } };
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const cors = corsHeaders(req);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const json = (data: unknown, status = 200) =>
      Response.json(data, { status, headers: cors });

    const url = new URL(req.url);

    // Serve the Extension Digest UI
    if (url.pathname === "/" || url.pathname === "/digest.html") {
      return new Response(Bun.file("ui/digest.html"), {
        headers: { "Content-Type": "text/html; charset=utf-8", ...cors },
      });
    }

    if (url.pathname === "/digest.js") {
      return new Response(Bun.file("ui/digest.js"), {
        headers: { "Content-Type": "text/javascript; charset=utf-8", ...cors },
      });
    }

    if (url.pathname === "/tts-scan-utils.js") {
      return new Response(Bun.file("ui/tts-scan-utils.js"), {
        headers: { "Content-Type": "text/javascript; charset=utf-8", ...cors },
      });
    }

    if (url.pathname === "/digest.css") {
      return new Response(Bun.file("ui/digest.css"), {
        headers: { "Content-Type": "text/css; charset=utf-8", ...cors },
      });
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(Bun.file("ui/favicon.ico"), {
        headers: { "Content-Type": "image/x-icon", ...cors },
      });
    }

    // API: Get full state (topics, digests, starter topics, metrics, monetization, hasApiKey)
    if (url.pathname === "/api/state" && req.method === "GET") {
      const [sync, digests, apiKey, metrics, entitlements] = await Promise.all([
        getSyncState(),
        getDigests(),
        getApiKey(),
        getMetrics(),
        getEntitlements(),
      ]);
      return json({
        sync,
        digests,
        metrics,
        entitlements,
        monetization: MONETIZATION_CONFIG,
        starterTopics: STARTER_TOPICS,
        hasApiKey: Boolean(apiKey),
        maskedKey: apiKey ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "",
      });
    }

    // API: Update sync state (topics, pinnedChannels, topicMeta, telemetryOptIn)
    if (url.pathname === "/api/sync" && req.method === "POST") {
      const body = (await req.json()) as any;
      const current = await getSyncState();
      const next = {
        topics: Array.isArray(body.topics) ? body.topics : current.topics,
        pinnedChannels: Array.isArray(body.pinnedChannels)
          ? body.pinnedChannels
          : current.pinnedChannels,
        minDurationSec: body.minDurationSec ?? current.minDurationSec,
        topicMeta:
          body.topicMeta && typeof body.topicMeta === "object"
            ? body.topicMeta
            : current.topicMeta || {},
        telemetryOptIn:
          typeof body.telemetryOptIn === "boolean"
            ? body.telemetryOptIn
            : current.telemetryOptIn ?? false,
      };
      const { isPro } = await getEntitlements();
      if (
        !isPro &&
        next.topics.length >
          Math.max(current.topics.length, MONETIZATION_CONFIG.freeTopicLimit)
      ) {
        return json({ error: "upgrade_required" }, 403);
      }
      await saveSyncState(next);
      return json({ ok: true, sync: next });
    }

    // API: Set Pro entitlement (manual unlock, Phase 4; real licence in Phase 5)
    if (url.pathname === "/api/entitlements" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as any;
      if (!body || typeof body.isPro !== "boolean") {
        return json({ error: "isPro boolean required" }, 400);
      }
      const entitlements = await setEntitlements({ isPro: body.isPro });
      return json({ ok: true, entitlements });
    }

    // API: Record usage metric event (timestampClick, ttsPlay)
    if (url.pathname === "/api/metrics" && req.method === "POST") {
      const body = (await req.json()) as { event?: string };
      let metrics = await getMetrics();
      if (body.event === "timestampClick") {
        metrics = await updateMetrics({ timestampClicks: 1 });
      } else if (body.event === "ttsPlay") {
        metrics = await updateMetrics({ ttsPlays: 1 });
      }
      return json({ ok: true, metrics });
    }

    // API: Save Gemini API Key
    if (url.pathname === "/api/key" && req.method === "POST") {
      const body = (await req.json()) as { apiKey?: string };
      if (!body.apiKey) {
        return json({ error: "API key required" }, 400);
      }
      await saveApiKey(body.apiKey);
      return json({ ok: true });
    }

    // API: Scan a Topic (Search -> Filter -> Transcript -> Summarize -> Synthesize)
    if (url.pathname === "/api/scan" && req.method === "POST") {
      try {
        const body = (await req.json()) as { topic: string; maxVideos?: number };
        const topic = (body.topic || "").trim();
        // `|| 3` after Number() collapses NaN (e.g. maxVideos:"abc") to the
        // default; without it collectWithBackfill's attempt cap becomes NaN and
        // the scan walks the whole ranked pool.
        const maxVideos = Math.min(5, Math.max(1, Number(body.maxVideos || 3) || 3));
        if (!topic) {
          return json({ error: "Topic is required" }, 400);
        }

        const apiKey = await getApiKey();
        if (!apiKey) {
          return json(
            { error: "Please set your Gemini API Key in Settings first." },
            400
          );
        }

        // Synchronous check-and-set: no await between the check and the
        // assignment, so concurrent requests cannot both acquire the lock.
        // A lock older than SCAN_STALE_MS is treated as dead (hung network
        // hop) and superseded instead of wedging future scans with 409s.
        if (activeScan && Date.now() - activeScan.since < SCAN_STALE_MS) {
          return json(
            { error: "scan_in_progress", topic: activeScan.topic },
            409
          );
        }
        activeScan = { topic, since: Date.now() };
        try {
          const result = await runScan(topic, maxVideos, apiKey);
          return json(result.body, result.status);
        } finally {
          // Owner-only release: a 409'd or validation-rejected request never
          // reaches here, so this cannot clear another request's lock.
          if (activeScan?.topic === topic) activeScan = null;
        }
      } catch (err: any) {
        return json({ error: String(err?.message || err) }, 500);
      }
    }

    // API: Poll Pinned Channel RSS
    if (url.pathname === "/api/rss" && req.method === "GET") {
      const { isPro } = await getEntitlements();
      if (!isPro) return json({ error: "upgrade_required" }, 403);
      const channelId = url.searchParams.get("channelId") || "";
      if (!channelId) return json({ videos: [] });
      const videos = await fetchChannelRssVideos(channelId);
      return json({ videos });
    }

    // API: 1-Click Export Backup JSON
    if (url.pathname === "/api/backup/export" && req.method === "GET") {
      const backupJson = await exportBackupJson();
      const date = new Date().toISOString().slice(0, 10);
      return new Response(backupJson, {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="yt-topic-radar-backup-${date}.json"`,
          ...cors,
        },
      });
    }

    // API: 1-Click Import Backup JSON
    if (url.pathname === "/api/backup/import" && req.method === "POST") {
      try {
        const raw = await req.text();
        const stats = await importBackupJson(raw);
        return json({ ok: true, ...stats });
      } catch (err: any) {
        return json({ error: String(err?.message || err) }, 400);
      }
    }

    return new Response("Not Found", { status: 404, headers: cors });
  },
});

console.log(`🚀 Topic Digest for YouTube UI running at http://localhost:${server.port}`);
