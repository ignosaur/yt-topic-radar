import { test, expect } from "bun:test";
import {
  collectWithBackfill,
  MAX_REPLACEMENTS,
  type VideoCandidate,
} from "../lib/youtube";

function cand(id: string): VideoCandidate {
  return {
    videoId: id,
    title: `Title ${id}`,
    channelName: "Ch",
    channelId: "ch",
    durationSec: 600,
    durationText: "10:00",
    viewCount: 1000,
    publishedText: "1 day ago",
    ageDays: 1,
    hasChapters: false,
    chapters: [],
    descriptionSnippet: "",
    thumbnailUrl: "",
    signalScore: 50,
    url: `https://youtube.com/watch?v=${id}`,
  };
}

const pool = (ids: string[]) => ids.map(cand);

test("MAX_REPLACEMENTS stays at the agreed cap of 2", () => {
  expect(MAX_REPLACEMENTS).toBe(2);
});

test("backfills a failed candidate to reach the requested count, in rank order", async () => {
  const calls: string[] = [];
  const { results, skipped } = await collectWithBackfill(
    pool(["a", "b", "c", "d", "e"]),
    3,
    async (v) => {
      calls.push(v.videoId);
      if (v.videoId === "b") throw new Error("boom");
      return v.videoId;
    }
  );
  expect(results).toEqual(["a", "c", "d"]);
  expect(skipped.map((s) => s.videoId)).toEqual(["b"]);
  expect(skipped[0]!.reason).toBe("Video processing failed");
  expect(skipped[0]!.title).toBe("Title b");
  expect(calls).toEqual(["a", "b", "c", "d"]);
});

test("caps total attempts at requested + MAX_REPLACEMENTS", async () => {
  const calls: string[] = [];
  const { results, skipped } = await collectWithBackfill(
    pool(["a", "b", "c", "d", "e", "f", "g"]),
    3,
    async (v) => {
      calls.push(v.videoId);
      if (v.videoId !== "a" && v.videoId !== "e") throw new Error("x");
      return v.videoId;
    }
  );
  expect(results).toEqual(["a", "e"]);
  expect(skipped.map((s) => s.videoId)).toEqual(["b", "c", "d"]);
  expect(calls.length).toBe(3 + MAX_REPLACEMENTS);
});

test("no failures → exactly requested attempts and no skips", async () => {
  const calls: string[] = [];
  const { results, skipped } = await collectWithBackfill(
    pool(["a", "b", "c", "d", "e"]),
    3,
    async (v) => {
      calls.push(v.videoId);
      return v.videoId;
    }
  );
  expect(results).toEqual(["a", "b", "c"]);
  expect(skipped).toEqual([]);
  expect(calls).toEqual(["a", "b", "c"]);
});

test("does not persist raw failure reasons", async () => {
  const { skipped } = await collectWithBackfill(
    pool(["a", "b"]),
    1,
    async () => {
      throw new Error("x".repeat(500));
    }
  );
  expect(skipped.length).toBeGreaterThan(0);
  expect(skipped[0]!.reason).toBe("Video processing failed");
});

test("stops on fatal provider failures and distinguishes exhaustion boundaries", async () => {
  const fatal = new Error("fatal");
  const calls: string[] = [];
  await expect(collectWithBackfill(pool(["a", "b", "c"]), 3, async (v) => {
    calls.push(v.videoId);
    if (v.videoId === "b") throw fatal;
    return v.videoId;
  }, (error) => error === fatal)).rejects.toBe(fatal);
  expect(calls).toEqual(["a", "b"]);
  const exhausted = await collectWithBackfill(pool(["a", "b"]), 3, async (v) => v.videoId);
  expect(exhausted.stopReason).toBe("pool_exhausted");
  const capped = await collectWithBackfill(pool(["a", "b", "c", "d", "e", "f"]), 3, async () => { throw Error("fail"); });
  expect(capped.stopReason).toBe("attempt_limit");
});
