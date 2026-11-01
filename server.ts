import {
  searchAndFilterTopicWithStats,
  fetchTimestampedTranscript,
  fetchChannelRssVideos,
  collectWithBackfill,
  indexByVideoId,
  type VideoCandidate,
} from "./lib/youtube";
import {
  summarizeVideo,
  synthesizeTopicDigest,
  type TopicDigest,
} from "./lib/summarizer";
import { ProviderAvailabilityError, ProviderFailureError, providerErrorResponse } from "./lib/provider-errors";
import {
  getSyncState,
  saveSyncState,
  StaleSyncError,
  getApiKey,
  saveApiKey,
  getDigests,
  saveTopicDigest,
  getTopicGeneration,
  getMetrics,
  updateMetrics,
  getEntitlements,
  setEntitlements,
  exportBackupJson,
  importBackupJson,
  markVideoSeen,
  validateSyncValue,
  BackupValidationError,
  StoreLockedError,
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

function originBlocked(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return false; // no-Origin clients (curl, same-origin, tests) unaffected
  return !ALLOWED_ORIGINS.some((re) => re.test(origin));
}

function isJsonContent(req: Request): boolean {
  const ct = req.headers.get("Content-Type") || "";
  return ct === "application/json" || ct.startsWith("application/json;");
}

// POST routes that require a JSON body. /api/backup/import is intentionally
// excluded: the dashboard posts it as raw text/plain (see digest.js import).
const JSON_POST_ROUTES = new Set([
  "/api/sync",
  "/api/entitlements",
  "/api/metrics",
  "/api/key",
  "/api/scan",
]);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.some((re) => re.test(origin));
  if (!allowed) return {}; // unknown or missing origin — no CORS headers
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// A hung network hop (Innertube search/getInfo are bounded-but-not-cancelled;
// direct player/caption/RSS fetches carry AbortSignal + 30 s deadline) could
// otherwise hold the lock forever, answering 409 to every future scan until a
// server restart. After this window the lock is treated as stale and the new
// scan supersedes it; the superseded scan's digest/metrics/seen writes are
// guarded off in runScan so it can never overwrite its successor.
const SCAN_STALE_MS = 10 * 60 * 1000;

/** Scan-level deadline override: opts param first, RADAR_SCAN_TIMEOUT_MS env for tests. */
function scanTimeoutMs(optsTimeout?: number): number {
  if (optsTimeout !== undefined) return optsTimeout;
  const fromEnv = Number(process.env.RADAR_SCAN_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : SCAN_STALE_MS;
}

/** Strip log-injection characters from free-form topics and bound length. */
function sanitizeTopic(topic: unknown, max = 80): string {
  return String(topic ?? "").replace(/[\r\n]+/g, " ").slice(0, max);
}

/** Allowlisted scan error category: typed provider codes or *Error names, else "error". */
function scanErrorLabel(err: any): string {
  if (err instanceof ProviderAvailabilityError) return err.code;
  if (err instanceof ProviderFailureError) return err.code;
  const name = typeof err?.name === "string" ? err.name : "";
  if (/^[A-Za-z]{1,30}Error$/.test(name)) return name;
  return "error";
}

let activeScan: { topic: string; since: number } | null = null;

// The scan pipeline itself (search -> filter -> transcript -> summarize ->
// synthesize). Returns { status, body }; the route handler wraps it with
// json() so CORS headers stay per-request. Separated from the lock/route
// logic so the single-flight guard stays small and auditable.
async function runScan(
  topic: string,
  maxVideos: number,
  apiKey: string,
  opts: { scanTimeoutMs?: number } = {}
): Promise<{ status: number; body: unknown }> {
  const scanStartedAt = Date.now();
  console.log(`[scan] start topic="${sanitizeTopic(topic)}" requested=${maxVideos}`);
  // Item 7: scan-level deadline. On timeout the scan settles promptly and frees
  // the lock (route handler finally); the superseded body below keeps running
  // but its guarded writes become no-ops so it never overwrites a successor.
  let superseded = false;
  const scanSignal = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onTimeout: Promise<{ status: number; body: unknown }> = new Promise((resolve) => {
    timer = setTimeout(
      () => {
        superseded = true;
        scanSignal.abort();
        resolve({ status: 504, body: { error: "scan_timeout" } });
      },
      scanTimeoutMs(opts.scanTimeoutMs)
    );
    (timer as unknown as { unref?: () => void })?.unref?.();
  });
  try {
    return await Promise.race([executeScan(), onTimeout]);
  } finally {
    clearTimeout(timer);
  }

  async function executeScan(): Promise<{ status: number; body: unknown }> {
  const generation = await getTopicGeneration(topic);
  // Item 10: per-topic reuse only — summaries stored in this topic's previous
  // digest (read-only; never a cross-topic cache). A failed read degrades to
  // a full scan instead of failing the whole scan.
  let previous: TopicDigest | null = null;
  try {
    previous = (await getDigests())[topic] ?? null;
  } catch {
    previous = null;
  }
  const reusable = indexByVideoId(previous?.videos);
  let candidates: VideoCandidate[];
  let slopFilteredCount: number;
  try {
    const filtered = await searchAndFilterTopicWithStats(topic, maxVideos);
    candidates = filtered.rankedPool;
    slopFilteredCount = filtered.slopFilteredCount;
    console.log(`[scan] search topic="${sanitizeTopic(topic)}" pool=${candidates.length} slopFiltered=${slopFilteredCount} durationMs=${Date.now() - scanStartedAt}`);
  } catch (err: any) {
    console.warn(`[scan] search failed for "${sanitizeTopic(topic)}": ${sanitizeTopic(err?.message || err, 200)}`);
    return {
      status: 502,
      body: { error: "YouTube search temporarily failed for this topic. Please retry." },
    };
  }
  let secondsSavedDelta = 0;
  let freshCount = 0;
  const seenVideoIds: string[] = [];

  const { results: summaries, skipped, attemptedCount, stopReason } = await collectWithBackfill(
    candidates,
    maxVideos,
    async (v) => {
      const videoStartedAt = Date.now();
      const reused = reusable.get(v.videoId);
      if (reused) return reused;
      try {
        const t = await fetchTimestampedTranscript(v.videoId, undefined, { signal: scanSignal.signal });
        const summary = await summarizeVideo(apiKey, v, t.blocks, t.chapters);
        console.log(`[scan] video=${v.videoId} summarized transcriptBlocks=${t.blocks.length} durationMs=${Date.now() - videoStartedAt}`);
        secondsSavedDelta += Math.max(60, (v.durationSec || 600) - 90);
        seenVideoIds.push(v.videoId);
        freshCount++;
        return summary;
      } catch (err: any) {
        console.log(`[scan] video=${v.videoId} failed durationMs=${Date.now() - videoStartedAt} error=${scanErrorLabel(err)}`);
        throw err;
      }
    },
    (err) => err instanceof ProviderAvailabilityError || err instanceof ProviderFailureError
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

  // Item 10: identical selection (same ids in order, all reused) keeps the
  // previous synthesis with no Gemini call.
  const prevIds = (previous?.videos ?? []).map((v) => v.videoId);
  const identical =
    previous !== null &&
    freshCount === 0 &&
    summaries.length === prevIds.length &&
    summaries.every((s, i) => s.videoId === prevIds[i]);
  // Item 7: a timed-out scan spends no Gemini synthesis call either.
  if (superseded) return { status: 504, body: { error: "scan_timeout" } };
  console.log(`[scan] synthesis start topic="${sanitizeTopic(topic)}" summaries=${summaries.length} reused=${summaries.length - freshCount} elapsedMs=${Date.now() - scanStartedAt}`);
  const synthesis = identical
    ? {
        crossVideoSynthesis: previous!.crossVideoSynthesis,
        suggestedSubtopics: previous!.suggestedSubtopics,
      }
    : await synthesizeTopicDigest(apiKey, topic, summaries);
  console.log(`[scan] synthesis done topic="${sanitizeTopic(topic)}" elapsedMs=${Date.now() - scanStartedAt}`);
  const digest: TopicDigest = {
    topic,
    generatedAt: new Date().toISOString(),
    crossVideoSynthesis: synthesis.crossVideoSynthesis,
    suggestedSubtopics: synthesis.suggestedSubtopics,
    videos: summaries,
    requestedCount: maxVideos,
    attemptedCount,
    candidatePoolCount: candidates.length,
    ...(stopReason ? { stopReason } : {}),
    ...(skipped.length > 0 ? { skippedVideos: skipped } : {}),
  };
  // Item 7: a superseded scan performs no digest, metrics, or seen writes.
  if (superseded) return { status: 504, body: { error: "scan_timeout" } };
  if (!await saveTopicDigest(digest, generation)) {
    return { status: 409, body: { error: "topic_changed" } };
  }

  // Fully-reused scans still count the scan but never double-count
  // videosSummarized/secondsSaved for reused videos.
  const metrics = await updateMetrics({
    scansCompleted: 1,
    videosSummarized: freshCount,
    slopVideosFiltered: slopFilteredCount,
    secondsSaved: secondsSavedDelta,
  });

  for (const videoId of seenVideoIds) {
    try { await markVideoSeen(videoId); }
    catch { console.warn(`[scan] failed to mark video seen`); }
  }

  console.log(
    `[scan] topic="${sanitizeTopic(topic)}" requested=${maxVideos} summarized=${summaries.length} skipped=${skipped.length}`
  );

  return { status: 200, body: { ok: true, digest, metrics, skippedVideos } };
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(req) {
    const cors = corsHeaders(req);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const json = (data: unknown, status = 200) =>
      Response.json(data, { status, headers: cors });

    const url = new URL(req.url);

    // Boundary gate: every POST mutation route rejects an untrusted Origin
    // with 403 before any handler runs (no state change, no scan). Requests
    // without an Origin header (curl, same-origin, tests) pass through.
    if (
      req.method === "POST" &&
      (JSON_POST_ROUTES.has(url.pathname) ||
        url.pathname === "/api/backup/import")
    ) {
      if (originBlocked(req)) return json({ error: "forbidden_origin" }, 403);
      if (
        JSON_POST_ROUTES.has(url.pathname) &&
        !isJsonContent(req)
      ) {
        return json({ error: "unsupported_media_type" }, 415);
      }
    }

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
        monetization: { ...MONETIZATION_CONFIG, proEnabled: true },
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
      try {
        validateSyncValue(next);
      } catch (err) {
        const message = err instanceof BackupValidationError ? err.message : String((err as any)?.message || err);
        return json({ error: message }, 400);
      }
      const { isPro } = await getEntitlements();
      if (
        !isPro &&
        next.topics.length >
          Math.max(current.topics.length, MONETIZATION_CONFIG.freeTopicLimit)
      ) {
        return json({ error: "upgrade_required" }, 403);
      }
      try {
        const sync = await saveSyncState(next, typeof body.revision === "number" ? body.revision : undefined);
        return json({ ok: true, sync });
      } catch (err) {
        if (err instanceof StaleSyncError) return json({ error: "stale_state" }, 409);
        if (err instanceof StoreLockedError) return json({ error: String(err.message) }, 409);
        throw err;
      }
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
        const scanStartedAt = Date.now();
        activeScan = { topic, since: scanStartedAt };
        try {
          const result = await runScan(topic, maxVideos, apiKey);
          return json(result.body, result.status);
        } finally {
          // Owner-only release: compare identity, not just topic — a scan that
          // was superseded after SCAN_STALE_MS must not clear its successor's
          // lock for the same topic.
          if (activeScan?.topic === topic && activeScan.since === scanStartedAt) {
            activeScan = null;
          }
        }
      } catch (err: any) {
        console.log(`[scan] request failed error=${scanErrorLabel(err)}`);
        if (err instanceof ProviderAvailabilityError) return json(providerErrorResponse(err), 429);
        if (err instanceof ProviderFailureError) return json(providerErrorResponse(err), 502);
        return json({ error: "Scan failed. Please retry." }, 500);
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
