import { mock } from "bun:test";

const mode = process.argv[2]; // "timeout" | "reuse"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const yt = await import("../../lib/youtube");
const summarizer = await import("../../lib/summarizer");
const storage = await import("../../lib/storage");

const vids = (ids: string[]) => ids.map((videoId) => ({ videoId, title: videoId, durationSec: 600 }));
let pool = ["a", "b", "c"];
let transcriptCalls = 0;
let summarizeCalls = 0;
let synthCalls = 0;
let saves = 0;
let metricsDeltas: any[] = [];
let seen: string[] = [];
let savedDigests: Record<string, any> = {};

mock.module("../../lib/youtube", () => ({
  ...yt,
  searchAndFilterTopicWithStats: async () => ({ rankedPool: vids(pool), slopFilteredCount: 0 }),
  fetchTimestampedTranscript: async () => {
    transcriptCalls++;
    if (mode === "timeout" && transcriptCalls === 1) await sleep(500); // resolves late
    return { blocks: [], chapters: [] };
  },
}));
mock.module("../../lib/summarizer", () => ({
  ...summarizer,
  summarizeVideo: async (_key: string, video: any) => {
    summarizeCalls++;
    return { videoId: video.videoId };
  },
  synthesizeTopicDigest: async () => {
    synthCalls++;
    return { crossVideoSynthesis: "cross", suggestedSubtopics: [] };
  },
}));
mock.module("../../lib/storage", () => ({
  ...storage,
  getApiKey: async () => "synthetic-key",
  getTopicGeneration: async () => "generation",
  getDigests: async () => ({ ...savedDigests }),
  saveTopicDigest: async (digest: any) => { saves++; savedDigests[digest.topic] = digest; return true; },
  updateMetrics: async (delta: any) => { metricsDeltas.push(delta); return {}; },
  markVideoSeen: async (videoId: string) => { seen.push(videoId); },
}));

let handler: (request: Request) => Promise<Response>;
(Bun as any).serve = (options: any) => { handler = options.fetch; return { port: 0 }; };
await import("../../server");
async function scan() {
  const res = await handler(new Request("http://localhost/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "test", maxVideos: 3 }) }));
  return { status: res.status, body: await res.json() };
}

if (mode === "timeout") {
  const first = await scan();
  const stateAfterFirst = { saves, metrics: metricsDeltas.length, seen: seen.length };
  const second = await scan();
  await sleep(800); // let the superseded body finish; it must not overwrite
  console.log(JSON.stringify({ first, second, stateAfterFirst, saves, metrics: metricsDeltas.length, seen, secondDigestSaved: savedDigests["test"]?.generatedAt === (second.body as any).digest?.generatedAt }));
} else {
  const first = await scan();
  const second = await scan();
  pool = ["a", "b", "x"];
  const third = await scan();
  console.log(JSON.stringify({
    statuses: [first.status, second.status, third.status],
    summarizeCalls, synthCalls, saves, metricsDeltas, seenCount: seen.length,
    keptSynthesis: (second.body as any).digest?.crossVideoSynthesis === (first.body as any).digest?.crossVideoSynthesis,
  }));
}
