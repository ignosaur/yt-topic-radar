// Each invocation owns its module cache and temporary store. No external fetch is allowed.
import { expect, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mode, scenario] = process.argv.slice(2);
const dir = await mkdtemp(join(tmpdir(), "radar-lifecycle-"));
process.env.RADAR_STORE_PATH = join(dir, "store.json");
process.env.GEMINI_API_KEY = "";
let externalCalls = 0;
globalThis.fetch = (async () => {
  externalCalls++;
  throw new Error("External network is forbidden in lifecycle tests");
}) as typeof fetch;
const A = "Personal Finance India", B = "Topic B";
const fixtureDigest = (topic: string) => ({ topic, generatedAt: "2026-01-01T00:00:00Z", videos: [{ videoId: topic }], crossVideoSynthesis: "old" });
const seed = {
  sync: { topics: [A, B], pinnedChannels: [
    { topic: A, channelId: "a", channelName: "A" },
    { topic: B, channelId: "b", channelName: "B" },
  ], topicMeta: { [A]: { starred: true }, [B]: { starred: true } }, minDurationSec: 180, telemetryOptIn: true },
  digests: { [A]: fixtureDigest(A), [B]: fixtureDigest(B) },
  apiKey: "fixture-key", seenVideoIds: ["shared-video"],
  metrics: { scansCompleted: 2, videosSummarized: 2, slopVideosFiltered: 0, secondsSaved: 100, timestampClicks: 1, ttsPlays: 0, backupsExported: 0 },
  entitlements: { isPro: true },
};
await Bun.write(process.env.RADAR_STORE_PATH, JSON.stringify(seed));
const idb = new Map<string, unknown>([["radarDigests", structuredClone(seed.digests)]]);
let failSyncWrite = false;
if (mode === "standalone") {
  Object.assign(globalThis, { indexedDB: {}, __RADAR_PRO_ENABLED__: false, window: globalThis });
  const sync = new Map<string, unknown>([["radarSync", structuredClone(seed.sync)]]);
  const local = new Map<string, unknown>([["geminiApiKey", "fixture-key"]]);
  const area = (map: Map<string, unknown>) => ({
    get: async (key: string) => ({ [key]: structuredClone(map.get(key)) }),
    set: async (values: Record<string, unknown>) => {
      if (map === sync && failSyncWrite) {
        failSyncWrite = false;
        throw new Error("fixture sync quota exceeded");
      }
      for (const [k,v] of Object.entries(values)) map.set(k, structuredClone(v)); },
    remove: async (key: string) => { map.delete(key); },
  });
  Object.assign(globalThis, { chrome: { storage: { sync: area(sync), local: area(local) } } });
  let lockChain = Promise.resolve();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    locks: { request: (_name: string, write: () => Promise<unknown>) => {
      const next = lockChain.then(write);
      lockChain = next.then(() => {}, () => {});
      return next;
    } },
  } });
  mock.module("idb-keyval", () => ({ get: async (key: string) => structuredClone(idb.get(key)), set: async (key: string, value: unknown) => { idb.set(key, structuredClone(value)); }, del: async (key: string) => { idb.delete(key); } }));
  mock.module("../../ui/digest.js", () => ({}));
}
let releaseScan: () => void = () => {};
let scanStarted: () => void = () => {};
const started = new Promise<void>(resolve => { scanStarted = resolve; });
const gate = new Promise<void>(resolve => { releaseScan = resolve; });
// Preserve pure helpers; replace every external-service entry point.
const youtube = await import("../../lib/youtube");
mock.module("../../lib/youtube", () => ({ ...youtube,
  searchAndFilterTopicWithStats: async () => ({ candidates: [], rankedPool: [{ videoId: "new-video", durationSec: 600, title: "Fixture" }], slopFilteredCount: 0 }),
  fetchTimestampedTranscript: async () => ({ blocks: [], chapters: [] }),
}));
mock.module("../../lib/summarizer", () => ({
  summarizeVideo: async () => ({ videoId: "new-video", title: "New", durationSec: 600 }),
  synthesizeTopicDigest: async () => { scanStarted(); await gate; return { crossVideoSynthesis: "new", suggestedSubtopics: [] }; },
}));
let route: (path: string, init?: RequestInit) => Promise<Response>;
try {
  if (mode === "server") {
    let handler: (req: Request) => Promise<Response>;
    Bun.serve = ((opts: any) => { handler = opts.fetch; return { port: 0 }; }) as typeof Bun.serve;
    await import("../../server");
    route = (path, init) => handler(new Request(`http://localhost${path}`, init));
  } else {
    await import("../../ui/standalone-entry");
    route = (globalThis as any).__RADAR_STANDALONE__;
  }
  const state = async () => (await route("/api/state")).json() as Promise<any>;
  const post = (path: string, body: unknown) => route(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const save = async (sync: any) => { const r = await post("/api/sync", sync); expect(r.status).toBe(200); return r.json(); };
  const initial = await state();
  const remove = async () => { const current = await state(); await save({ ...current.sync, topics: current.sync.topics.filter((t: string) => t !== A) }); };
  const add = async () => { const current = await state(); await save({ ...current.sync, topics: [...current.sync.topics, A] }); };
  if (scenario === "sync-failure") {
    failSyncWrite = true;
    await expect(post("/api/sync", { ...initial.sync, topics: [B] })).rejects.toThrow("fixture sync quota exceeded");
    const failed = await state();
    expect(failed.sync).toEqual(initial.sync);
    expect(failed.digests).toEqual(initial.digests);
    expect(failed.metrics).toEqual(initial.metrics);
    expect(failed.hasApiKey).toBe(initial.hasApiKey);
    // A retry must still be able to commit the deletion after the failure.
    await remove();
    expect((await state()).digests[A]).toBeUndefined();
    expect((await state()).digests[B]).toEqual(initial.digests[B]);
  } else if (scenario === "cleanup") {
    await remove();
    const removed = await state();
    expect(removed.sync.topics).not.toContain(A);
    expect(removed.digests[A]).toBeUndefined();
    expect(removed.sync.topicMeta[A]).toBeUndefined();
    expect(removed.sync.pinnedChannels).toEqual([seed.sync.pinnedChannels[1]]);
    expect(removed.digests[B]).toEqual(initial.digests[B]);
    expect(removed.sync.topicMeta[B]).toEqual(initial.sync.topicMeta[B]);
    expect(removed.metrics).toEqual(initial.metrics);
    expect(removed.entitlements).toEqual(initial.entitlements);
    expect(removed.sync.telemetryOptIn).toBe(true);
    expect(removed.hasApiKey).toBe(true);
    await add();
    expect((await state()).digests[A]).toBeUndefined();
    if (mode === "server") {
      const disk = await Bun.file(process.env.RADAR_STORE_PATH!).json();
      expect(disk.digests[A]).toBeUndefined();
      expect(disk.seenVideoIds).toEqual(seed.seenVideoIds);
      expect(disk.apiKey).toBe(seed.apiKey);
    } else expect((idb.get("radarDigests") as any)[A]).toBeUndefined();
  } else if (scenario === "stale") {
    await remove();
    const response = await post("/api/sync", { ...initial.sync, topics: [...initial.sync.topics, "C"] });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("stale_state");
    expect((await state()).sync.topics).toEqual([B]);
  } else if (scenario === "concurrent") {
    const responses = await Promise.all([
      post("/api/sync", { ...initial.sync, topics: [B] }),
      post("/api/sync", { ...initial.sync, topics: [...initial.sync.topics, "C"] }),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await state()).sync.topics).toEqual([B]);
  } else if (scenario === "ordinary") {
    await save({ ...initial.sync, topics: [...initial.sync.topics, "C"], telemetryOptIn: false });
    const next = await state();
    expect(next.digests).toEqual(initial.digests);
    expect(next.sync.topicMeta).toEqual(initial.sync.topicMeta);
    expect(next.sync.pinnedChannels).toEqual(initial.sync.pinnedChannels);
  } else {
    const pending = post("/api/scan", { topic: A, maxVideos: 1 });
    await started;
    if (scenario !== "unrelated") await remove();
    if (scenario === "readd") await add();
    if (scenario === "unrelated") await save({ ...(await state()).sync, topics: [A] });
    releaseScan();
    const response = await pending;
    expect(response.status).toBe(scenario === "unrelated" ? 200 : 409);
    const after = await state();
    if (scenario === "unrelated") expect(after.digests[A].crossVideoSynthesis).toBe("new");
    else {
      expect(after.digests[A]).toBeUndefined();
      expect(after.digests[B]).toEqual(initial.digests[B]);
      if (scenario === "readd") {
        const fresh = await post("/api/scan", { topic: A, maxVideos: 1 });
        expect(fresh.status).toBe(200);
        expect((await state()).digests[A].crossVideoSynthesis).toBe("new");
      }
    }
  }
  expect(externalCalls).toBe(0);
} finally {
  releaseScan();
  await rm(dir, { recursive: true, force: true });
}
