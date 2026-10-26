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
  exportBackupJson,
  importBackupJson,
  markVideoSeen,
  STARTER_TOPICS,
  MONETIZATION_CONFIG,
} from "./lib/storage";

const PORT = Number(process.env.PORT || 3456);

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    // Serve the Extension Digest UI
    if (url.pathname === "/" || url.pathname === "/digest.html") {
      return new Response(Bun.file("ui/digest.html"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // API: Get full state (topics, digests, starter topics, metrics, monetization, hasApiKey)
    if (url.pathname === "/api/state" && req.method === "GET") {
      const [sync, digests, apiKey, metrics] = await Promise.all([
        getSyncState(),
        getDigests(),
        getApiKey(),
        getMetrics(),
      ]);
      return Response.json({
        sync,
        digests,
        metrics,
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
      await saveSyncState(next);
      return Response.json({ ok: true, sync: next });
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
      return Response.json({ ok: true, metrics });
    }

    // API: Save Gemini API Key
    if (url.pathname === "/api/key" && req.method === "POST") {
      const body = (await req.json()) as { apiKey?: string };
      if (!body.apiKey) {
        return Response.json({ error: "API key required" }, { status: 400 });
      }
      await saveApiKey(body.apiKey);
      return Response.json({ ok: true });
    }

    // API: Scan a Topic (Search -> Filter -> Transcript -> Summarize -> Synthesize)
    if (url.pathname === "/api/scan" && req.method === "POST") {
      try {
        const body = (await req.json()) as { topic: string; maxVideos?: number };
        const topic = (body.topic || "").trim();
        const maxVideos = Math.min(5, Math.max(1, Number(body.maxVideos || 3)));
        if (!topic) {
          return Response.json({ error: "Topic is required" }, { status: 400 });
        }

        const apiKey = await getApiKey();
        if (!apiKey) {
          return Response.json(
            { error: "Please set your Gemini API Key in Settings first." },
            { status: 400 }
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

        return Response.json({ ok: true, digest, metrics });
      } catch (err: any) {
        return Response.json(
          { error: String(err?.message || err) },
          { status: 500 }
        );
      }
    }

    // API: Poll Pinned Channel RSS
    if (url.pathname === "/api/rss" && req.method === "GET") {
      const channelId = url.searchParams.get("channelId") || "";
      if (!channelId) return Response.json({ videos: [] });
      const videos = await fetchChannelRssVideos(channelId);
      return Response.json({ videos });
    }

    // API: 1-Click Export Backup JSON
    if (url.pathname === "/api/backup/export" && req.method === "GET") {
      const json = await exportBackupJson();
      const date = new Date().toISOString().slice(0, 10);
      return new Response(json, {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="yt-topic-radar-backup-${date}.json"`,
        },
      });
    }

    // API: 1-Click Import Backup JSON
    if (url.pathname === "/api/backup/import" && req.method === "POST") {
      try {
        const raw = await req.text();
        const stats = await importBackupJson(raw);
        return Response.json({ ok: true, ...stats });
      } catch (err: any) {
        return Response.json(
          { error: String(err?.message || err) },
          { status: 400 }
        );
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🚀 YouTube Topic Radar UI running at http://localhost:${server.port}`);
