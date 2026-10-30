import { describe, expect, mock, test } from "bun:test";
import { runStandaloneScan, type EngineDeps } from "../lib/engine";
import type { VideoCandidate } from "../lib/youtube";
import type { VideoSummary } from "../lib/summarizer";
import type { UsageMetrics } from "../lib/storage";
import { ProviderAvailabilityError, ProviderFailureError } from "../lib/provider-errors";

function candidate(videoId: string, durationSec: number): VideoCandidate {
  return {
    videoId,
    title: `Title ${videoId}`,
    channelName: "Channel",
    channelId: "channel-id",
    durationSec,
    durationText: `${Math.floor(durationSec / 60)}:00`,
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

const baseMetrics: UsageMetrics = {
  scansCompleted: 1,
  videosSummarized: 2,
  slopVideosFiltered: 4,
  secondsSaved: 1320,
  timestampClicks: 0,
  ttsPlays: 0,
  backupsExported: 0,
};

function makeHarness(overrides: Partial<EngineDeps> = {}) {
  const a = candidate("video-a", 1200);
  const b = candidate("video-b", 300);

  const search = mock(async () => ({
    candidates: [a, b],
    rankedPool: [a, b],
    slopFilteredCount: 4,
    totalEvaluated: 6,
  }));
  const transcript = mock(async () => ({
    blocks: [],
    fullDescription: "",
    chapters: [],
  }));
  const summarize = mock(async (_apiKey: string, video: VideoCandidate) =>
    summaryFor(video)
  );
  const synthesize = mock(async () => ({
    crossVideoSynthesis: "cross",
    suggestedSubtopics: ["sub"],
  }));
  const saveDigest = mock(async (_digest: unknown) => {});
  const markSeen = mock(async (_videoId: string) => {});
  const updateMetrics = mock(async (_delta: Partial<UsageMetrics>) => baseMetrics);

  let lockHeld = false;
  let released = false;
  const acquireLock = mock(async (_topic: string) => {
    if (lockHeld) return false;
    lockHeld = true;
    return true;
  });
  const releaseLock = mock(async () => {
    lockHeld = false;
    released = true;
  });

  const deps: EngineDeps = {
    search: search as unknown as EngineDeps["search"],
    transcript: transcript as unknown as EngineDeps["transcript"],
    summarize: summarize as unknown as EngineDeps["summarize"],
    synthesize: synthesize as unknown as EngineDeps["synthesize"],
    saveDigest: saveDigest as unknown as EngineDeps["saveDigest"],
    markSeen: markSeen as unknown as EngineDeps["markSeen"],
    updateMetrics: updateMetrics as unknown as EngineDeps["updateMetrics"],
    acquireLock: acquireLock as unknown as EngineDeps["acquireLock"],
    releaseLock: releaseLock as unknown as EngineDeps["releaseLock"],
    ...overrides,
  };

  return {
    deps,
    search,
    transcript,
    summarize,
    synthesize,
    saveDigest,
    markSeen,
    updateMetrics,
    acquireLock,
    releaseLock,
    isLockHeld: () => lockHeld,
    wasReleased: () => released,
  };
}

describe("runStandaloneScan", () => {
  test("mixed outage and video error stops scan without saving", async () => {
    const { generateWithFallback } = await import("../lib/summarizer");
    let calls = 0;
    const ai = { models: { generateContent: async () => { calls++; throw calls === 1 ? { status: 503, message: "503 unavailable" } : { status: 400, message: "invalid video" }; } } };
    const summarize = mock(async () => await generateWithFallback(ai as any, { contents: "test" }, async () => {}) as any);
    const h = makeHarness({ summarize: summarize as unknown as EngineDeps["summarize"] });
    const result = await runStandaloneScan("AI Agents", 3, "key", h.deps);
    expect(result.status).toBe(502);
    expect((result.body as any).error).toBe("provider_unavailable");
    expect(summarize.mock.calls.length).toBe(1);
    expect(h.saveDigest.mock.calls.length).toBe(0);
    expect(h.updateMetrics.mock.calls.length).toBe(0);
    expect(h.markSeen.mock.calls.length).toBe(0);
    expect(h.wasReleased()).toBe(true);
  });
  test("provider failure stops replacement and preserves state", async () => {
    const summarize = mock(async () => { throw new ProviderFailureError(); });
    const h = makeHarness({ summarize: summarize as unknown as EngineDeps["summarize"] });
    const result = await runStandaloneScan("AI Agents", 3, "key", h.deps);
    expect(result.status).toBe(502);
    expect((result.body as any).error).toBe("provider_unavailable");
    expect(summarize.mock.calls.length).toBe(1);
    expect(h.saveDigest.mock.calls.length).toBe(0);
    expect(h.updateMetrics.mock.calls.length).toBe(0);
    expect(h.markSeen.mock.calls.length).toBe(0);
    expect(h.wasReleased()).toBe(true);
  });
  test("unexpected synthesis failure is sanitized and preserves state", async () => {
    const synthesize = mock(async () => { throw new Error("provider secret detail"); });
    const h = makeHarness({ synthesize: synthesize as unknown as EngineDeps["synthesize"] });
    const result = await runStandaloneScan("AI Agents", 2, "key", h.deps);
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain("provider secret detail");
    expect(h.saveDigest.mock.calls.length).toBe(0);
    expect(h.updateMetrics.mock.calls.length).toBe(0);
    expect(h.markSeen.mock.calls.length).toBe(0);
    expect(h.wasReleased()).toBe(true);
  });
  for (const failure of ["first", "third", "synthesis"] as const) {
    test(`quota failure at ${failure} preserves state and releases the lock`, async () => {
      const videos = ["a", "b", "c", "d"].map((id) => candidate(id, 600));
      const search = mock(async () => ({ candidates: videos.slice(0, 3), rankedPool: videos, slopFilteredCount: 0, totalEvaluated: 4 }));
      const summarize = mock(async (_key: string, video: VideoCandidate) => {
        if ((failure === "first" && video.videoId === "a") || (failure === "third" && video.videoId === "c")) {
          throw new ProviderAvailabilityError("quota_exhausted");
        }
        return summaryFor(video);
      });
      const synthesize = mock(async () => {
        if (failure === "synthesis") throw new ProviderAvailabilityError("rate_limited", 7);
        return { crossVideoSynthesis: "cross", suggestedSubtopics: [] };
      });
      const h = makeHarness({ search: search as unknown as EngineDeps["search"], summarize: summarize as unknown as EngineDeps["summarize"], synthesize: synthesize as unknown as EngineDeps["synthesize"] });
      const result = await runStandaloneScan("AI Agents", 3, "key", h.deps);
      expect(result.status).toBe(429);
      expect((result.body as any).error).toBe(failure === "synthesis" ? "rate_limited" : "quota_exhausted");
      if (failure === "synthesis") expect((result.body as any).retryAfterSeconds).toBe(7);
      expect(summarize.mock.calls.length).toBe(failure === "first" ? 1 : 3);
      expect(h.saveDigest.mock.calls.length).toBe(0);
      expect(h.updateMetrics.mock.calls.length).toBe(0);
      expect(h.markSeen.mock.calls.length).toBe(0);
      expect(h.wasReleased()).toBe(true);
    });
  }

  test("distinguishes attempt limit from exhausted pool, including equality", async () => {
    for (const [poolSize, expected] of [[5, "pool_exhausted"], [6, "attempt_limit"]] as const) {
      const videos = Array.from({ length: poolSize }, (_, i) => candidate(String(i), 600));
      const search = mock(async () => ({ candidates: videos.slice(0, 3), rankedPool: videos, slopFilteredCount: 0, totalEvaluated: poolSize }));
      const summarize = mock(async (_key: string, video: VideoCandidate) => {
        if (video.videoId !== "0") throw new Error("private provider detail");
        return summaryFor(video);
      });
      const h = makeHarness({ search: search as unknown as EngineDeps["search"], summarize: summarize as unknown as EngineDeps["summarize"] });
      const result = await runStandaloneScan("AI Agents", 3, "key", h.deps);
      const digest = (result.body as any).digest;
      expect(digest.stopReason).toBe(expected);
      expect(digest.attemptedCount).toBe(5);
      expect(digest.candidatePoolCount).toBe(poolSize);
      expect(JSON.stringify(digest)).not.toContain("private provider detail");
    }
  });
  test("success path saves one digest, updates metrics, marks both videos seen, releases the lock", async () => {
    const h = makeHarness();

    const result = await runStandaloneScan("AI Agents", 2, "key", h.deps);

    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.ok).toBe(true);
    expect(body.skippedVideos).toEqual([]);
    expect(body.digest.topic).toBe("AI Agents");
    expect(body.digest.videos).toHaveLength(2);
    expect(body.digest.videos.map((v: VideoSummary) => v.videoId)).toEqual([
      "video-a",
      "video-b",
    ]);

    expect(h.saveDigest.mock.calls.length).toBe(1);
    expect(h.saveDigest.mock.calls[0]?.[0]).toBe(body.digest);

    expect(h.updateMetrics.mock.calls.length).toBe(1);
    expect(h.updateMetrics.mock.calls[0]?.[0]).toMatchObject({
      scansCompleted: 1,
      videosSummarized: 2,
      slopVideosFiltered: 4,
      secondsSaved: 1320,
    });

    expect(h.markSeen.mock.calls.map((call) => call[0])).toEqual([
      "video-a",
      "video-b",
    ]);
    expect(h.wasReleased()).toBe(true);
    expect(h.isLockHeld()).toBe(false);
  });

  test("skip path continues past a failed summarize and marks only the successful video", async () => {
    const summarize = mock(async (_apiKey: string, video: VideoCandidate) => {
      if (video.videoId === "video-a") throw new Error("transcript exploded");
      return summaryFor(video);
    });
    const h = makeHarness({
      summarize: summarize as unknown as EngineDeps["summarize"],
    });

    const result = await runStandaloneScan("AI Agents", 3, "key", h.deps);

    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.skippedVideos).toEqual(["video-a"]);
    expect(body.digest.videos.map((v: VideoSummary) => v.videoId)).toEqual([
      "video-b",
    ]);
    expect(h.transcript.mock.calls.length).toBe(2);
    expect(h.markSeen.mock.calls.map((call) => call[0])).toEqual(["video-b"]);
    expect(h.saveDigest.mock.calls.length).toBe(1);
    expect(h.wasReleased()).toBe(true);
  });

  test("all-fail path returns 502 and performs no digest, metrics, or seen writes", async () => {
    const summarize = mock(async () => {
      throw new Error("always fails");
    });
    const h = makeHarness({
      summarize: summarize as unknown as EngineDeps["summarize"],
    });

    const result = await runStandaloneScan("AI Agents", 3, "key", h.deps);

    expect(result.status).toBe(502);
    const body = result.body as any;
    expect(body.skippedVideos).toEqual(["video-a", "video-b"]);
    expect(body.error).toContain("None of the candidate videos");
    expect(h.saveDigest.mock.calls.length).toBe(0);
    expect(h.updateMetrics.mock.calls.length).toBe(0);
    expect(h.markSeen.mock.calls.length).toBe(0);
    expect(h.wasReleased()).toBe(true);
  });

  test("lock-held path returns 409 before search; release is skipped because this scan never owned the lock", async () => {
    const acquireLock = mock(async () => false);
    const releaseLock = mock(async () => {});
    const search = mock(async () => ({
      candidates: [],
      rankedPool: [],
      slopFilteredCount: 0,
      totalEvaluated: 0,
    }));
    const h = makeHarness({
      acquireLock: acquireLock as unknown as EngineDeps["acquireLock"],
      releaseLock: releaseLock as unknown as EngineDeps["releaseLock"],
      search: search as unknown as EngineDeps["search"],
    });

    const result = await runStandaloneScan("AI Agents", 3, "key", h.deps);

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: "scan_in_progress" });
    expect(search.mock.calls.length).toBe(0);
    expect(releaseLock.mock.calls.length).toBe(0);
  });

  test("search-failure path returns 502 without touching transcripts", async () => {
    const search = mock(async () => {
      throw new Error("search down");
    });
    const h = makeHarness({
      search: search as unknown as EngineDeps["search"],
    });

    const result = await runStandaloneScan("AI Agents", 3, "key", h.deps);

    expect(result.status).toBe(502);
    expect(result.body).toEqual({
      error: "YouTube search temporarily failed for this topic. Please retry.",
    });
    expect(h.transcript.mock.calls.length).toBe(0);
    expect(h.saveDigest.mock.calls.length).toBe(0);
    expect(h.wasReleased()).toBe(true);
  });

  test("a failed seen-write does not fail an otherwise committed scan", async () => {
    const markSeen = mock(async (_videoId: string) => {
      throw new Error("storage quota");
    });
    const h = makeHarness({
      markSeen: markSeen as unknown as EngineDeps["markSeen"],
    });

    const result = await runStandaloneScan("AI Agents", 2, "key", h.deps);

    expect(result.status).toBe(200);
    expect(h.saveDigest.mock.calls.length).toBe(1);
    expect(h.updateMetrics.mock.calls.length).toBe(1);
    expect(markSeen.mock.calls.length).toBe(2);
    expect(h.wasReleased()).toBe(true);
  });

  test("clamps requested count to 5 at the top and 1 at the bottom", async () => {
    const search = mock(async (_topic: string, _maxResults: number) => ({
      candidates: [],
      rankedPool: [],
      slopFilteredCount: 0,
      totalEvaluated: 0,
    }));
    const h = makeHarness({
      search: search as unknown as EngineDeps["search"],
    });

    await runStandaloneScan("AI Agents", 99, "key", h.deps);
    await runStandaloneScan("AI Agents", 0, "key", h.deps);

    expect(search.mock.calls[0]?.[1]).toBe(5);
    expect(search.mock.calls[1]?.[1]).toBe(1);
  });
});
