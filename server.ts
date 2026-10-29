import {
  searchAndFilterTopicWithStats,
  fetchTimestampedTranscript,
  fetchChannelRssVideos,
} from "./lib/youtube";
import {
  summarizeVideo,
  synthesizeTopicDigest,
  type VideoSummary,
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

    if (url.pathname === "/digest.css") {
      return new Response(Bun.file("ui/digest.css"), {
        headers: { "Content-Type": "text/css; charset=utf-8", ...cors },
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
        const maxVideos = Math.min(5, Math.max(1, Number(body.maxVideos || 3)));
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

        const { candidates, slopFilteredCount } = await searchAndFilterTopicWithStats(
          topic,
          maxVideos
        );
        const summaries: VideoSummary[] = [];
        let secondsSavedDelta = 0;

        for (const v of candidates) {
          const t = await fetchTimestampedTranscript(v.videoId);
          const summary = await summarizeVideo(apiKey, v, t.blocks, t.chapters);
          summaries.push(summary);
          secondsSavedDelta += Math.max(60, (v.durationSec || 600) - 90);
          await markVideoSeen(v.videoId);
        }

        const synthesis = await synthesizeTopicDigest(apiKey, topic, summaries);
        const digest = {
          topic,
          generatedAt: new Date().toISOString(),
          crossVideoSynthesis: synthesis.crossVideoSynthesis,
          suggestedSubtopics: synthesis.suggestedSubtopics,
          videos: summaries,
        };
        await saveTopicDigest(digest);

        const metrics = await updateMetrics({
          scansCompleted: 1,
          videosSummarized: summaries.length,
          slopVideosFiltered: slopFilteredCount,
          secondsSaved: secondsSavedDelta,
        });

        return json({ ok: true, digest, metrics });
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

console.log(`🚀 YouTube Topic Radar UI running at http://localhost:${server.port}`);
