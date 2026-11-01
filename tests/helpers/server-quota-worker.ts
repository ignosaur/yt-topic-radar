import { mock } from "bun:test";
import { ProviderAvailabilityError, ProviderFailureError } from "../../lib/provider-errors";

const mode = process.argv[2];
const yt = await import("../../lib/youtube");
const summarizer = await import("../../lib/summarizer");
const storage = await import("../../lib/storage");
const videos = ["a", "b", "c", "d"].map((videoId) => ({ videoId, title: videoId, durationSec: 600 }));
let attempts = 0;
let saves = 0;
let metrics = 0;
let seen = 0;
mock.module("../../lib/youtube", () => ({
  ...yt,
  searchAndFilterTopicWithStats: async () => ({ rankedPool: videos, slopFilteredCount: 0 }),
  fetchTimestampedTranscript: async () => ({ blocks: [], chapters: [] }),
}));
mock.module("../../lib/summarizer", () => ({
  ...summarizer,
  summarizeVideo: async (_key: string, video: any) => {
    attempts++;
    if (mode === "mixed") {
      let calls = 0;
      const ai = { models: { generateContent: async () => { calls++; throw calls === 1 ? { status: 503, message: "503 unavailable" } : { status: 400, message: "invalid video" }; } } };
      await summarizer.generateWithFallback(ai as any, { contents: "test" }, async () => {});
    }
    if (mode === "first" || (mode === "third" && video.videoId === "c")) throw new ProviderAvailabilityError("quota_exhausted");
    if (mode === "provider") throw new ProviderFailureError();
    if (mode === "malformed" && video.videoId === "a") summarizer.parseSummaryJson('{"private-provider-output":');
    return { videoId: video.videoId };
  },
  synthesizeTopicDigest: async () => {
    if (mode === "synthesis") throw new ProviderAvailabilityError("rate_limited", 7);
    return { crossVideoSynthesis: "ok", suggestedSubtopics: [] };
  },
}));
mock.module("../../lib/storage", () => ({
  ...storage,
  getApiKey: async () => "synthetic-key",
  getTopicGeneration: async () => "generation",
  saveTopicDigest: async () => { saves++; return true; },
  updateMetrics: async () => { metrics++; return {}; },
  markVideoSeen: async () => { seen++; },
}));
let handler: (request: Request) => Promise<Response>;
(Bun as any).serve = (options: any) => { handler = options.fetch; return { port: 0 }; };
await import("../../server");
async function scan() {
  const res = await handler(new Request("http://localhost/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "test", maxVideos: 3 }) }));
  return { status: res.status, body: await res.json() };
}
const first = await scan();
const second = await scan();
console.log(JSON.stringify({ first, second, attempts, saves, metrics, seen }));
