import { Innertube, UniversalCache, Parser } from "youtubei.js";

/**
 * YouTube ships new watch-page nodes (e.g. `Clarification` info panels on
 * finance/news videos) faster than youtubei.js models them. The library
 * JIT-generates the missing class and continues, so `class_not_found` and
 * `class_changed` are benign drift — not failures. Everything else stays loud.
 */
export function isBenignParserWarning(errorType: unknown): boolean {
  return errorType === "class_not_found" || errorType === "class_changed";
}

export function handleParserError(
  err: { classname: string; error_type: string },
  warn: (msg: string) => void = console.warn
): void {
  if (isBenignParserWarning(err?.error_type)) return;
  warn(`[youtubei.js][${err?.error_type}]: ${err?.classname}`);
}

try {
  Parser.setParserErrorHandler((err: any) => handleParserError(err));
} catch {
  // Older/newer youtubei.js without the hook — default handler applies.
  console.warn("[youtubei.js] setParserErrorHandler unavailable; parser warnings unsuppressed.");
}

export interface VideoCandidate {
  videoId: string;
  title: string;
  channelName: string;
  channelId: string;
  durationSec: number;
  durationText: string;
  viewCount: number;
  publishedText: string;
  ageDays: number;
  hasChapters: boolean;
  chapters: { title: string; startSec: number; timestamp: string }[];
  descriptionSnippet: string;
  thumbnailUrl: string;
  signalScore: number;
  url: string;
}

export interface TranscriptSegment {
  startSec: number;
  timestamp: string;
  text: string;
}

const CLICKBAIT_RE =
  /\b(SHOCKING|DESTROYED|IT'S OVER|YOU WON'T BELIEVE|INSANE|EXPOSED|RIP|DEAD\?!|EMERGENCY)\b/i;

/**
 * Default deadline for direct YouTube fetches (player POST, caption XML, RSS).
 * Injectable per call via FetchDeadlineOpts.timeoutMs so tests never wait this long.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export interface FetchDeadlineOpts {
  /** Aborts the fetch early when the owning scan is superseded/times out. */
  signal?: AbortSignal;
  /** Deadline for this fetch; defaults to DEFAULT_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Test seam for the fetch implementation. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Direct fetch with an AbortSignal + deadline. Timer is unref'd so scans never hold the loop open. */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit = {},
  opts: FetchDeadlineOpts = {}
): Promise<Response> {
  const impl = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  (timer as unknown as { unref?: () => void })?.unref?.();
  const external = opts.signal;
  const onExternalAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    return await impl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    external?.removeEventListener?.("abort", onExternalAbort);
  }
}

/** Index stored summaries by videoId for per-topic reuse (item 10). */
export function indexByVideoId<T extends { videoId: string }>(
  items: readonly T[] | undefined
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items ?? []) map.set(item.videoId, item);
  return map;
}

let ytPromise: Promise<Innertube> | null = null;

// shortcut: youtubei.js search/getInfo take no per-call AbortSignal — cancellation
// only exists via a session-level custom `fetch`, which the shared singleton cannot
// scope per scan. These calls are bounded-but-not-cancelled; upgrade to a per-scan
// Innertube session with a signal-wired fetch if hangs are observed here.
export function getInnertube(): Promise<Innertube> {
  if (!ytPromise) {
    ytPromise = Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
    });
  }
  return ytPromise;
}

export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function parseRelativeAgeDays(text: string): number {
  const lower = (text || "").toLowerCase();
  const match = lower.match(/(\d+)\s*(hour|day|week|month|year)/);
  if (!match) return 7;
  const n = Number(match[1]) || 1;
  const unit = match[2];
  if (unit === "hour") return Math.max(0.25, n / 24);
  if (unit === "day") return n;
  if (unit === "week") return n * 7;
  if (unit === "month") return n * 30;
  if (unit === "year") return n * 365;
  return 7;
}

export function parseDurationSec(text: string): number {
  if (!text) return 0;
  const parts = text.split(":").map((p) => Number(p.trim()) || 0);
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0] || 0;
}

export function parseViewCount(text: string): number {
  if (!text) return 0;
  const clean = text.replace(/,/g, "").toLowerCase();
  const m = clean.match(/([\d.]+)\s*([kmb])?/);
  if (!m) return 0;
  const num = parseFloat(m[1] || "0");
  const mult = m[2] === "b" ? 1e9 : m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1;
  return Math.round(num * mult);
}

export function scoreCandidate(v: Omit<VideoCandidate, "signalScore">): number {
  if (v.durationSec < 180) return -1; // Drop Shorts / clips < 3 mins
  const viewsPerDay = v.viewCount / Math.max(1, v.ageDays);
  let score = Math.log10(Math.max(10, viewsPerDay)) * 20;

  // Structured depth bonus: chapters & meaningful length (8–60 mins)
  if (v.hasChapters) score += 25;
  if (v.durationSec >= 480 && v.durationSec <= 3600) score += 12;

  // Anti-slop clickbait penalty
  if (CLICKBAIT_RE.test(v.title)) score -= 25;
  const upperRatio =
    v.title.replace(/[^a-zA-Z]/g, "").length > 10
      ? v.title.replace(/[^A-Z]/g, "").length / v.title.replace(/[^a-zA-Z]/g, "").length
      : 0;
  if (upperRatio > 0.6) score -= 15;

  return Math.round(Math.max(1, Math.min(100, score)));
}

/**
 * Step 1 & 2: Search topic on YouTube and apply the Anti-Slop Quality Filter (with filter stats).
 */
export async function searchAndFilterTopicWithStats(
  topic: string,
  maxResults = 4
): Promise<{
  candidates: VideoCandidate[];
  rankedPool: VideoCandidate[];
  slopFilteredCount: number;
  totalEvaluated: number;
}> {
  const yt = await getInnertube();
  const search = await yt.search(topic, {
    type: "video",
    sort_by: "relevance",
  });

  const candidates: VideoCandidate[] = [];
  let totalEvaluated = 0;
  let droppedCount = 0;

  for (const item of search.videos) {
    const raw = item as any;
    const videoId: string = raw.id || raw.video_id || "";
    const title: string = raw.title?.toString?.() || raw.title?.text || "";
    if (!videoId || !title) continue;
    totalEvaluated++;

    const durationSec: number =
      raw.duration?.seconds || parseDurationSec(raw.duration?.text || "");
    if (durationSec < 180) {
      droppedCount++;
      continue; // Skip Shorts and < 3 min videos
    }

    const viewText =
      raw.view_count?.toString?.() || raw.short_view_count?.toString?.() || "0";
    const viewCount = parseViewCount(viewText);
    const publishedText = raw.published?.toString?.() || "";
    const ageDays = parseRelativeAgeDays(publishedText);

    // Check expandableMetadata in search payload for chapters (zero extra HTTP requests)
    const chapters: { title: string; startSec: number; timestamp: string }[] = [];
    const hasChapters = Boolean(
      raw.expandable_metadata ||
        raw.chapters?.length ||
        /\b00?:00\b/.test(raw.description_snippet?.toString?.() || "")
    );

    const base: Omit<VideoCandidate, "signalScore"> = {
      videoId,
      title,
      channelName: raw.author?.name || "Unknown Channel",
      channelId: raw.author?.id || "",
      durationSec,
      durationText: raw.duration?.text || formatTimestamp(durationSec),
      viewCount,
      publishedText,
      ageDays,
      hasChapters,
      chapters,
      descriptionSnippet: raw.description_snippet?.toString?.() || "",
      thumbnailUrl:
        raw.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };

    const signalScore = scoreCandidate(base);
    if (signalScore > 0) {
      candidates.push({ ...base, signalScore });
    } else {
      droppedCount++;
    }
  }

  const sorted = candidates.sort((a, b) => b.signalScore - a.signalScore);
  const selected = sorted.slice(0, maxResults);
  const slopFilteredCount = droppedCount + Math.max(0, sorted.length - selected.length);

  return {
    candidates: selected,
    rankedPool: sorted,
    slopFilteredCount,
    totalEvaluated,
  };
}

export async function searchAndFilterTopic(
  topic: string,
  maxResults = 4
): Promise<VideoCandidate[]> {
  const res = await searchAndFilterTopicWithStats(topic, maxResults);
  return res.candidates;
}

/**
 * Backfill guardrail: how many extra candidates a scan may attempt to replace
 * ones that failed summarization. Caps Gemini spend during a provider outage.
 */
export const MAX_REPLACEMENTS = 2;

export interface SkippedVideo {
  videoId: string;
  title: string;
  reason: string;
}

/**
 * Attempt candidates in rank order until `requested` succeed, allowing up to
 * `MAX_REPLACEMENTS` extra attempts for failures. Results stay in rank order
 * (iteration order), and each failure is recorded with a truncated reason.
 */
export async function collectWithBackfill<T>(
  rankedPool: VideoCandidate[],
  requested: number,
  process: (v: VideoCandidate) => Promise<T>,
  isFatal: (err: unknown) => boolean = () => false,
): Promise<{ results: T[]; skipped: SkippedVideo[]; attemptedCount: number; stopReason?: "pool_exhausted" | "attempt_limit" }> {
  const results: T[] = [];
  const skipped: SkippedVideo[] = [];
  const attemptsLimit = Math.max(0, requested) + MAX_REPLACEMENTS;

  for (const v of rankedPool) {
    if (results.length >= requested) break;
    if (results.length + skipped.length >= attemptsLimit) break;
    try {
      results.push(await process(v));
    } catch (err: any) {
      if (isFatal(err)) throw err;
      skipped.push({
        videoId: v.videoId,
        title: v.title,
        reason: "Video processing failed",
      });
    }
  }

  const attemptedCount = results.length + skipped.length;
  const stopReason = results.length >= requested ? undefined :
    attemptedCount >= rankedPool.length ? "pool_exhausted" : "attempt_limit";
  return { results, skipped, attemptedCount, ...(stopReason ? { stopReason } : {}) };
}


/**
 * Step 3: Fetch timed transcript grouped into ~45-second timestamped blocks.
 * If captions are disabled or blocked, returns empty segments so caller falls back to Gemini native YouTube URL.
 */
export async function fetchTimestampedTranscript(
  videoId: string,
  windowSec = 45,
  opts: FetchDeadlineOpts = {}
): Promise<{
  blocks: TranscriptSegment[];
  fullDescription: string;
  chapters: { title: string; startSec: number; timestamp: string }[];
}> {
  const yt = await getInnertube();
  let fullDescription = "";
  const chapters: { title: string; startSec: number; timestamp: string }[] = [];

  try {
    const info = await yt.getInfo(videoId);
    fullDescription = info.secondary_info?.description?.toString?.() || "";

    // Extract description timestamps as chapters if present
    for (const line of fullDescription.split("\n")) {
      const m = line.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—:]?\s*(.+)/);
      if (m?.[1] && m?.[2]) {
        const startSec = parseDurationSec(m[1]);
        chapters.push({
          startSec,
          timestamp: formatTimestamp(startSec),
          title: m[2].trim().slice(0, 100),
        });
      }
    }

    const transcriptRes = await fetchWithDeadline(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: "20.10.38",
              androidSdkVersion: 34,
            },
          },
        }),
      },
      opts
    );
    const playerData = (await transcriptRes.json()) as any;
    const tracks: any[] =
      playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const enTrack =
      tracks.find((t) => t.languageCode === "en") ||
      tracks.find((t) => String(t.languageCode || "").startsWith("en")) ||
      tracks[0];

    const blocks: TranscriptSegment[] = [];
    if (enTrack?.baseUrl) {
      const xml = await (await fetchWithDeadline(enTrack.baseUrl, {}, opts)).text();
      const pMatches = [...xml.matchAll(/<p\s+t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)];
      let currentStart = -1;
      let buffer: string[] = [];

      for (const m of pMatches) {
        const startMs = Number(m[1] || 0);
        const startSec = Math.floor(startMs / 1000);
        const rawInner = m[2] || "";
        const text = rawInner
          .replace(/<[^>]+>/g, "")
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) continue;

        if (currentStart < 0) currentStart = startSec;
        buffer.push(text);

        if (startSec - currentStart >= windowSec) {
          blocks.push({
            startSec: currentStart,
            timestamp: formatTimestamp(currentStart),
            text: buffer.join(" ").replace(/\s+/g, " "),
          });
          currentStart = -1;
          buffer = [];
        }
      }

      if (buffer.length > 0 && currentStart >= 0) {
        blocks.push({
          startSec: currentStart,
          timestamp: formatTimestamp(currentStart),
          text: buffer.join(" ").replace(/\s+/g, " "),
        });
      }
    }

    return { blocks, fullDescription, chapters };
  } catch {
    // shortcut: when Innertube getTranscript fails or captions are disabled, return empty blocks so summarizer uses Gemini native fileUri fallback
    return { blocks: [], fullDescription, chapters };
  }
}

/**
 * Poll a YouTube channel's native RSS feed (zero API quota).
 */
export async function fetchChannelRssVideos(
  channelId: string,
  opts: FetchDeadlineOpts = {}
): Promise<{ videoId: string; title: string; published: string; url: string }[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const res = await fetchWithDeadline(url, {}, opts);
  if (!res.ok) return [];
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map((e) => {
    const body = e[1] || "";
    const videoId = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || "";
    const title = body.match(/<title>([^<]+)<\/title>/)?.[1] || "";
    const published = body.match(/<published>([^<]+)<\/published>/)?.[1] || "";
    return {
      videoId,
      title,
      published,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  });
}
