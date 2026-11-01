import {
  collectWithBackfill,
  fetchTimestampedTranscript,
  indexByVideoId,
  searchAndFilterTopicWithStats,
  type VideoCandidate,
} from "./youtube";
import {
  summarizeVideo,
  synthesizeTopicDigest,
  type TopicDigest,
  type VideoSummary,
} from "./summarizer";
import { ProviderAvailabilityError, ProviderFailureError, providerErrorResponse } from "./provider-errors";
import {
  getDigests,
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
  /** Previous digest for per-topic summary reuse (item 10); absent in tests means no reuse. */
  getPreviousDigest?: (topic: string) => Promise<TopicDigest | null>;
}

export interface StandaloneScanOptions {
  /** Scan-level deadline; defaults to SCAN_STALE_MS. Must stay short in tests. */
  scanTimeoutMs?: number;
}

const SCAN_LOCK_KEY = "radarScanLock";
const SCAN_STALE_MS = 10 * 60 * 1000;

// Fallback scan mutex when chrome.storage.local is unusable (Bun/CLI/tests).
let memScanLockHeld = false;

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
    // No chrome.storage (Bun/CLI/tests): process-local mutex. The check-and-set
    // below is synchronous with no await in between, so it stays atomic on this
    // single thread and two concurrent scans yield [200, 409].
    return {
      acquireLock: async () => {
        if (memScanLockHeld) return false;
        memScanLockHeld = true;
        return true;
      },
      releaseLock: async () => {
        memScanLockHeld = false;
      },
    };
  }

  let acquired: ScanLock | null = null;

  // shortcut: get-then-set on chrome.storage.local is not atomic, so a tab and
  // side panel racing here can both acquire; the navigator.locks Web Lock held
  // for the whole scan in runStandaloneScan is the real guard where available.
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
    getPreviousDigest: async (topic: string) =>
      (await getDigests())[topic] ?? null,
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
  deps: EngineDeps = defaultEngineDeps,
  opts: StandaloneScanOptions = {}
): Promise<ScanResponse> {
  // Item 6: hold a Web Lock for the whole scan where available. The
  // ifAvailable form rejects the second concurrent scan with 409 before it
  // calls search. The injected acquireLock/releaseLock seam is kept for tests
  // and as the fallback path. In Bun/Node navigator.locks is absent and the
  // seam alone guards.
  const webLocks = (globalThis as { navigator?: any }).navigator?.locks;
  if (webLocks?.request && (await webLockSupportsIfAvailable(webLocks))) {
    return await webLocks.request(
      "radar-scan",
      { ifAvailable: true },
      async (held: unknown) => {
        if (!held) return { status: 409, body: { error: "scan_in_progress" } };
        return await runStandaloneScanLocked(topic, maxVideos, apiKey, deps, opts);
      }
    );
  }
  return await runStandaloneScanLocked(topic, maxVideos, apiKey, deps, opts);
}

// One-time probe (cached): does this locks.request honor the (name, options,
// callback) form? Real Web Locks always do; name-blind test shims serialize
// every lock name on one global queue, so parking the scan body inside their
// callback would wedge unrelated topic writes mid-scan — those shims fail the
// probe and the scan runs on the acquireLock/releaseLock seam alone.
// Only a positive probe is cached: a timeout on a busy event loop must not
// permanently pin a capable browser to the fallback path — re-probe next scan.
let ifAvailableSupported = false;
async function webLockSupportsIfAvailable(webLocks: any): Promise<boolean> {
  if (ifAvailableSupported) return true;
  let entered = false;
  try {
    const probe = webLocks.request(
      "radar-scan-probe",
      { ifAvailable: true },
      async () => { entered = true; }
    );
    await Promise.race([
      Promise.resolve(probe).catch(() => {}),
      new Promise((r) => setTimeout(r, 50)),
    ]);
  } catch {
    entered = false;
  }
  if (entered) ifAvailableSupported = true;
  return entered;
}

async function runStandaloneScanLocked(
  topic: string,
  maxVideos: number,
  apiKey: string,
  deps: EngineDeps,
  opts: StandaloneScanOptions
): Promise<ScanResponse> {
  const requestedCount = clampMaxVideos(maxVideos);

  if (!(await deps.acquireLock(topic))) {
    return { status: 409, body: { error: "scan_in_progress" } };
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await deps.releaseLock();
  };

  // Item 7: scan-level deadline. On timeout the scan settles promptly with an
  // error and the lock is released; the superseded body keeps running in the
  // background but its guarded writes below become no-ops.
  let superseded = false;
  const scanSignal = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onTimeout: Promise<ScanResponse> = new Promise((resolve) => {
    timer = setTimeout(
      () => {
        superseded = true;
        scanSignal.abort();
        resolve({ status: 504, body: { error: "scan_timeout" } });
      },
      opts.scanTimeoutMs ?? SCAN_STALE_MS
    );
    (timer as unknown as { unref?: () => void })?.unref?.();
  });

  try {
    return await Promise.race([executeScan(), onTimeout]);
  } finally {
    clearTimeout(timer);
    await release();
  }

  async function executeScan(): Promise<ScanResponse> {
    try {
      const generation = await deps.getTopicGeneration?.(topic);
      // Item 10: per-topic reuse only — summaries stored in this topic's
      // previous digest. Absent (or throwing) means no reuse, full scan.
      let previous: TopicDigest | null = null;
      try {
        previous = await deps.getPreviousDigest?.(topic) ?? null;
      } catch {
        previous = null;
      }
      const reusable = indexByVideoId<VideoSummary>(previous?.videos);
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
      let freshCount = 0;
      const { results: summaries, skipped, attemptedCount, stopReason } = await collectWithBackfill(
        candidates,
        requestedCount,
        async (video) => {
          const reused = reusable.get(video.videoId);
          if (reused) return reused;
          try {
            const transcript = await deps.transcript(video.videoId, undefined, { signal: scanSignal.signal });
            const summary = await deps.summarize(
              apiKey,
              video,
              transcript.blocks,
              transcript.chapters
            );
            secondsSaved += Math.max(60, (video.durationSec || 600) - 90);
            seenVideoIds.push(video.videoId);
            freshCount++;
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

      // Item 7: a timed-out scan spends no Gemini synthesis call either.
      if (superseded) return { status: 504, body: { error: "scan_timeout" } };

      // Item 10: identical selection (same ids in order, all reused) keeps the
      // previous synthesis with no Gemini call.
      const prevIds = (previous?.videos ?? []).map((v) => v.videoId);
      const identical =
        previous !== null &&
        freshCount === 0 &&
        summaries.length === prevIds.length &&
        summaries.every((s, i) => s.videoId === prevIds[i]);
      const synthesis = identical
        ? {
            crossVideoSynthesis: previous!.crossVideoSynthesis,
            suggestedSubtopics: previous!.suggestedSubtopics,
          }
        : await deps.synthesize(apiKey, topic, summaries);
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

      // Item 7: a superseded scan performs no digest, metrics, or seen writes.
      if (superseded) return { status: 504, body: { error: "scan_timeout" } };
      if (await deps.saveDigest(digest, generation) === false) {
        return { status: 409, body: { error: "topic_changed" } };
      }
      // Fully-reused scans still count the scan but never double-count
      // videosSummarized/secondsSaved for reused videos.
      const metrics = await deps.updateMetrics({
        scansCompleted: 1,
        videosSummarized: freshCount,
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
    }
  }
}
