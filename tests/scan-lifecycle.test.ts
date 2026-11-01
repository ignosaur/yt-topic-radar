import { describe, expect, mock, test } from "bun:test";
import { createEngineDeps, runStandaloneScan, type EngineDeps } from "../lib/engine";
import type { VideoCandidate } from "../lib/youtube";
import type { VideoSummary } from "../lib/summarizer";
import type { UsageMetrics } from "../lib/storage";

function candidate(videoId: string): VideoCandidate {
  return {
    videoId,
    title: `Title ${videoId}`,
    channelName: "Channel",
    channelId: "channel-id",
    durationSec: 600,
    durationText: "10:00",
    viewCount: 1000,
    publishedText: "1 day ago",
    ageDays: 1,
    hasChapters: false,
    chapters: [],
    descriptionSnippet: "",
    thumbnailUrl: "",
    signalScore: 80,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

function summaryFor(video: VideoCandidate): VideoSummary {
  return {
    videoId: video.videoId,
    title: video.title,
    channelName: video.channelName,
    channelId: video.channelId,
    url: video.url,
    durationSec: video.durationSec,
    durationText: video.durationText,
    signalScore: video.signalScore,
    videoType: "news_analysis",
    coreThesis: "thesis",
    chapterBreakdown: [],
    typeSpecificDetails: [],
    worthWatchingFull: "Skim timestamps",
    worthWatchingReason: "reason",
    summarizedAt: new Date().toISOString(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeFakes(videos: VideoCandidate[], overrides: Partial<EngineDeps> = {}) {
  const search = mock(async () => ({
    candidates: videos,
    rankedPool: videos,
    slopFilteredCount: 0,
    totalEvaluated: videos.length,
  }));
  const transcript = mock(async () => ({ blocks: [], fullDescription: "", chapters: [] }));
  const summarize = mock(async (_apiKey: string, video: VideoCandidate) => summaryFor(video));
  const synthesize = mock(async () => ({ crossVideoSynthesis: "cross", suggestedSubtopics: ["sub"] }));
  const saveDigest = mock(async (_digest: unknown) => {});
  const markSeen = mock(async (_videoId: string) => {});
  const deltas: Partial<UsageMetrics>[] = [];
  const updateMetrics = mock(async (delta: Partial<UsageMetrics>) => {
    deltas.push(delta);
    return {} as UsageMetrics;
  });
  const getPreviousDigest = mock(async (_topic: string) => null);
  return {
    search, transcript, summarize, synthesize, saveDigest, markSeen, updateMetrics, getPreviousDigest, deltas,
    deps: {
      search, transcript, summarize, synthesize, saveDigest, markSeen, updateMetrics, getPreviousDigest,
    } as unknown as EngineDeps,
    with(over: Partial<EngineDeps>): EngineDeps {
      return { ...this.deps, ...over } as EngineDeps;
    },
  };
}

describe("lane D scan lifecycle (engine)", () => {
  test("two concurrent scans with the real default lock yield [200,409]; lock released after", async () => {
    const videos = ["a", "b"].map(candidate);
    const f = makeFakes(videos);
    // Real default lock (in-memory mutex in Bun, chrome-storage race + Web Lock in browsers).
    const { acquireLock, releaseLock } = createEngineDeps();
    const search = mock(async () => {
      await sleep(50);
      return { candidates: videos, rankedPool: videos, slopFilteredCount: 0, totalEvaluated: 2 };
    });
    const deps = f.with({
      acquireLock, releaseLock,
      search: search as unknown as EngineDeps["search"],
    });

    const [first, second] = await Promise.all([
      runStandaloneScan("T", 2, "key", deps),
      runStandaloneScan("T", 2, "key", deps),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(search.mock.calls.length).toBe(1);
    expect(f.saveDigest.mock.calls.length).toBe(1);

    const third = await runStandaloneScan("T", 2, "key", deps);
    expect(third.status).toBe(200);
    expect(f.saveDigest.mock.calls.length).toBe(2);
  });

  test("hanging transcript hits the scan deadline: 504, lock free, zero writes; replacement survives", async () => {
    const videos = ["a", "b"].map(candidate);
    const f = makeFakes(videos);
    let transcriptCalls = 0;
    const transcript = mock(async (_videoId: string) => {
      transcriptCalls++;
      if (transcriptCalls === 1) await sleep(300); // resolves late, after the deadline
      return { blocks: [], fullDescription: "", chapters: [] };
    });
    let lockHeld = false;
    const deps = f.with({
      transcript: transcript as unknown as EngineDeps["transcript"],
      acquireLock: mock(async () => {
        if (lockHeld) return false;
        lockHeld = true;
        return true;
      }) as unknown as EngineDeps["acquireLock"],
      releaseLock: mock(async () => { lockHeld = false; }) as unknown as EngineDeps["releaseLock"],
    });

    const first = await runStandaloneScan("T", 2, "key", deps, { scanTimeoutMs: 50 });
    expect(first.status).toBe(504);
    expect(lockHeld).toBe(false);
    expect(f.saveDigest.mock.calls.length).toBe(0);
    expect(f.updateMetrics.mock.calls.length).toBe(0);
    expect(f.markSeen.mock.calls.length).toBe(0);

    const second = await runStandaloneScan("T", 2, "key", deps, { scanTimeoutMs: 5000 });
    expect(second.status).toBe(200);
    await sleep(500); // let the superseded body finish; it must not overwrite
    expect(f.saveDigest.mock.calls.length).toBe(1);
    expect(f.saveDigest.mock.calls[0]?.[0]).toBe((second.body as any).digest);
  });

  test("identical rescan reuses summaries and skips synthesis; one-video change summarizes exactly 1", async () => {
    const abc = ["a", "b", "c"].map(candidate);
    const f = makeFakes(abc);
    let previous: any = null;
    let pool: VideoCandidate[] = abc;
    const search = mock(async () => ({
      candidates: pool, rankedPool: pool, slopFilteredCount: 0, totalEvaluated: pool.length,
    }));
    const getPreviousDigest = mock(async () => previous);
    const deps = f.with({
      search: search as unknown as EngineDeps["search"],
      getPreviousDigest: getPreviousDigest as unknown as EngineDeps["getPreviousDigest"],
      acquireLock: mock(async () => true) as unknown as EngineDeps["acquireLock"],
      releaseLock: mock(async () => {}) as unknown as EngineDeps["releaseLock"],
    });

    const first = await runStandaloneScan("T", 3, "key", deps);
    expect(first.status).toBe(200);
    expect(f.summarize.mock.calls.length).toBe(3);
    expect(f.synthesize.mock.calls.length).toBe(1);
    previous = (first.body as any).digest;

    const second = await runStandaloneScan("T", 3, "key", deps);
    expect(second.status).toBe(200);
    expect(f.summarize.mock.calls.length).toBe(3);
    expect(f.synthesize.mock.calls.length).toBe(1);
    expect((second.body as any).digest.crossVideoSynthesis).toBe(previous.crossVideoSynthesis);
    expect(f.deltas.at(-1)).toMatchObject({ scansCompleted: 1, videosSummarized: 0, secondsSaved: 0 });
    expect(f.markSeen.mock.calls.length).toBe(3); // reused videos not re-marked seen

    pool = ["a", "b", "x"].map(candidate);
    const third = await runStandaloneScan("T", 3, "key", deps);
    expect(third.status).toBe(200);
    expect(f.summarize.mock.calls.length).toBe(4);
    expect(f.synthesize.mock.calls.length).toBe(2);
  });
});
