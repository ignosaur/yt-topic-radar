import {
  collectWithBackfill,
  fetchTimestampedTranscript,
  searchAndFilterTopicWithStats,
  type VideoCandidate,
} from "./youtube";
import {
  summarizeVideo,
  synthesizeTopicDigest,
  type TopicDigest,
} from "./summarizer";
import { ProviderAvailabilityError, ProviderFailureError, providerErrorResponse } from "./provider-errors";
import {
  markVideoSeen,
  saveTopicDigest,
  getTopicGeneration,
  updateMetrics,
} from "./storage";

export interface ScanResponse {
  status: number;
  body: unknown;
}

export interface EngineDeps {
  search: typeof searchAndFilterTopicWithStats;
  transcript: typeof fetchTimestampedTranscript;
  summarize: typeof summarizeVideo;
  synthesize: typeof synthesizeTopicDigest;
  saveDigest: typeof saveTopicDigest;
  getTopicGeneration?: typeof getTopicGeneration;
  markSeen: (videoId: string) => Promise<void>;
  updateMetrics: typeof updateMetrics;
  acquireLock: (topic: string) => Promise<boolean>;
  releaseLock: () => Promise<void>;
}

const SCAN_LOCK_KEY = "radarScanLock";
const SCAN_STALE_MS = 10 * 60 * 1000;

interface ScanLock {
  topic: string;
  since: number;
}

interface ChromeLocalStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

function createChromeScanLock(): Pick<EngineDeps, "acquireLock" | "releaseLock"> {
  const chromeApi = (globalThis as { chrome?: any }).chrome;
  const local = chromeApi?.storage?.local as ChromeLocalStore | undefined;
  const usable =
    local &&
    typeof local.get === "function" &&
    typeof local.set === "function" &&
    typeof local.remove === "function";

  if (!usable) {
    return {
      acquireLock: async () => true,
      releaseLock: async () => {},
    };
  }

  let acquired: ScanLock | null = null;

  return {
    async acquireLock(topic: string): Promise<boolean> {
      const data = await local.get(SCAN_LOCK_KEY);
      const existing = data?.[SCAN_LOCK_KEY] as Partial<ScanLock> | undefined;
      if (
        existing &&
        typeof existing.since === "number" &&
        Date.now() - existing.since < SCAN_STALE_MS
      ) {
        return false;
      }
      acquired = { topic, since: Date.now() };
      await local.set({ [SCAN_LOCK_KEY]: acquired });
      return true;
    },
    async releaseLock(): Promise<void> {
      const owned = acquired;
      acquired = null;
      if (!owned) return;
      const data = await local.get(SCAN_LOCK_KEY);
      const existing = data?.[SCAN_LOCK_KEY] as Partial<ScanLock> | undefined;
      if (
        existing &&
        existing.topic === owned.topic &&
        existing.since === owned.since
      ) {
        await local.remove(SCAN_LOCK_KEY);
      }
    },
  };
}

export function createEngineDeps(): EngineDeps {
  return {
    search: searchAndFilterTopicWithStats,
    transcript: fetchTimestampedTranscript,
    summarize: summarizeVideo,
    synthesize: synthesizeTopicDigest,
    saveDigest: saveTopicDigest,
    getTopicGeneration,
    markSeen: (videoId: string) => markVideoSeen(videoId),
    updateMetrics,
    ...createChromeScanLock(),
  };
}

export const defaultEngineDeps: EngineDeps = createEngineDeps();

function clampMaxVideos(maxVideos: number): number {
  const numeric = Number(maxVideos);
  const requested = numeric === 0 ? 0 : numeric || 3;
  return Math.min(5, Math.max(1, requested));
}

export async function runStandaloneScan(
  topic: string,
  maxVideos: number,
  apiKey: string,
  deps: EngineDeps = defaultEngineDeps
): Promise<ScanResponse> {
  const requestedCount = clampMaxVideos(maxVideos);

  if (!(await deps.acquireLock(topic))) {
    return { status: 409, body: { error: "scan_in_progress" } };
  }

  try {
    const generation = await deps.getTopicGeneration?.(topic);
    let candidates: VideoCandidate[];
    let slopFilteredCount: number;
    try {
      const filtered = await deps.search(topic, requestedCount);
      candidates = filtered.rankedPool;
      slopFilteredCount = filtered.slopFilteredCount;
    } catch (err: any) {
      console.warn(
        `[scan] search failed for "${topic}": ${String(err?.message || err).slice(0, 200)}`
      );
      return {
        status: 502,
        body: {
          error: "YouTube search temporarily failed for this topic. Please retry.",
        },
      };
    }

    const seenVideoIds: string[] = [];
    let secondsSaved = 0;
    const { results: summaries, skipped, attemptedCount, stopReason } = await collectWithBackfill(
      candidates,
      requestedCount,
      async (video) => {
        try {
          const transcript = await deps.transcript(video.videoId);
          const summary = await deps.summarize(
            apiKey,
            video,
            transcript.blocks,
            transcript.chapters
          );
          secondsSaved += Math.max(60, (video.durationSec || 600) - 90);
          seenVideoIds.push(video.videoId);
          return summary;
        } catch (err) {
          if (err instanceof ProviderAvailabilityError || err instanceof ProviderFailureError) throw err;
          console.warn(`[scan] skipped video ${video.videoId}: Video processing failed`);
          throw err;
        }
      },
      (err) => err instanceof ProviderAvailabilityError || err instanceof ProviderFailureError
    );

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

    const synthesis = await deps.synthesize(apiKey, topic, summaries);
    const digest: TopicDigest = {
      topic,
      generatedAt: new Date().toISOString(),
      crossVideoSynthesis: synthesis.crossVideoSynthesis,
      suggestedSubtopics: synthesis.suggestedSubtopics,
      videos: summaries,
      requestedCount,
      attemptedCount,
      candidatePoolCount: candidates.length,
      ...(stopReason ? { stopReason } : {}),
      ...(skipped.length > 0 ? { skippedVideos: skipped } : {}),
    };

    if (await deps.saveDigest(digest, generation) === false) {
      return { status: 409, body: { error: "topic_changed" } };
    }
    const metrics = await deps.updateMetrics({
      scansCompleted: 1,
      videosSummarized: summaries.length,
      slopVideosFiltered: slopFilteredCount,
      secondsSaved,
    });

    for (const videoId of seenVideoIds) {
      try {
        await deps.markSeen(videoId);
      } catch (err: any) {
        // The digest and metrics are already committed; a failed seen-write
        // must not turn a successful scan into a user-visible failure.
        console.warn(
          `[scan] failed to mark ${videoId} seen: ${String(err?.message || err).slice(0, 200)}`
        );
      }
    }

    return {
      status: 200,
      body: { ok: true, digest, metrics, skippedVideos },
    };
  } catch (err) {
    if (err instanceof ProviderAvailabilityError) {
      return { status: 429, body: providerErrorResponse(err) };
    }
    if (err instanceof ProviderFailureError) {
      return { status: 502, body: providerErrorResponse(err) };
    }
    return { status: 502, body: { error: "Scan failed. Please try again." } };
  } finally {
    await deps.releaseLock();
  }
}
