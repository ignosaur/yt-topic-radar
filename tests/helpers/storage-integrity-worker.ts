// Lane C storage-integrity worker: each invocation owns a fresh module cache
// and tmp store (RADAR_STORE_PATH from env, set before any storage import).
// No external network is used.
import { rename, mkdir, rmdir, readFile } from "node:fs/promises";

const scenario = process.argv[2];
const storePath = process.env.RADAR_STORE_PATH!;
process.env.GEMINI_API_KEY = "";
if (!storePath) {
  console.error("RADAR_STORE_PATH required");
  process.exit(1);
}

const store = await import("../../lib/storage");
const {
  getSyncState,
  saveSyncState,
  saveApiKey,
  importBackupJson,
  getDigests,
} = store;

const readBytes = () => readFile(storePath, "utf8");
const fail = (msg: string): never => {
  console.error(`ASSERT: ${msg}`);
  process.exit(1);
};

if (scenario === "perm") {
  // Test pre-creates a 0664 seed file; one write must tighten to 0600.
  const current = await getSyncState();
  await saveSyncState({ ...current, topics: [...current.topics, "Perm Topic"] });
  await saveApiKey("perm-key");
  console.log("PERM_OK");
} else if (scenario === "atomicity") {
  const current = await getSyncState();
  await saveSyncState({ ...current, topics: ["Keep A"] });
  await saveApiKey("atomic-key");
  const beforeBytes = await readBytes();
  const beforeRev = (await getSyncState()).revision;
  const bad: Array<[string, string]> = [
    ["seen42", JSON.stringify({ sync: { topics: ["Keep A"], pinnedChannels: [], minDurationSec: 180 }, digests: {}, seenVideoIds: 42 })],
    ["topics42", JSON.stringify({ sync: { topics: [42], pinnedChannels: [], minDurationSec: 180 }, digests: {}, seenVideoIds: [] })],
    ["oversize", "x".repeat(10 * 1024 * 1024 + 1)],
    // Same byte size as oversize, but BMP multibyte: string length stays under
    // 10 MiB while UTF-8 bytes exceed it — the gate must measure bytes.
    ["oversize-bytes", JSON.stringify({ sync: { topics: ["Keep A"], pinnedChannels: [], minDurationSec: 180 }, digests: { K: { topic: "K", generatedAt: "2026-01-01T00:00:00Z", videos: [], crossVideoSynthesis: "é".repeat(6 * 1024 * 1024) } }, seenVideoIds: [] })],
    ["badDigest", JSON.stringify({ sync: { topics: ["Keep A"], pinnedChannels: [], minDurationSec: 180 }, digests: { X: { topic: 42 } }, seenVideoIds: [] })],
    ["badMetrics", JSON.stringify({ sync: { topics: ["Keep A"], pinnedChannels: [], minDurationSec: 180 }, digests: {}, seenVideoIds: [], metrics: { scansCompleted: -1 } })],
  ];
  for (const [name, raw] of bad) {
    let threw = "";
    try {
      await importBackupJson(raw);
    } catch (err: any) {
      threw = String(err?.message || err);
    }
    if (!threw) fail(`${name} did not throw`);
    console.log(`REJECTED_${name}: ${threw.slice(0, 80)}`);
  }
  if ((await readBytes()) !== beforeBytes) fail("store bytes changed after rejected imports");
  if ((await getSyncState()).revision !== beforeRev) fail("revision bumped by rejected import");
  console.log("BYTE_IDENTICAL");
  // A valid backup exercising every validated branch still merges.
  const valid = JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    sync: {
      topics: ["Keep A", "New B"],
      pinnedChannels: [{ channelId: "c1", channelName: "C1", topic: "New B" }],
      minDurationSec: 120,
      topicMeta: { "New B": { starred: true } },
      telemetryOptIn: true,
    },
    digests: {
      "New B": {
        topic: "New B",
        generatedAt: new Date().toISOString(),
        crossVideoSynthesis: "s",
        suggestedSubtopics: [],
        videos: [{
          videoId: "v1", title: "T", channelName: "C", url: "https://u",
          chapterBreakdown: [{ timestamp: "00:00", sectionTitle: "S", keyPoints: ["k"] }],
          typeSpecificDetails: [{ label: "L", items: ["i"] }],
        }],
      },
    },
    seenVideoIds: ["v1"],
    metrics: { scansCompleted: 1, videosSummarized: 1, slopVideosFiltered: 0, secondsSaved: 60, timestampClicks: 0, ttsPlays: 0, backupsExported: 0 },
  });
  const stats = await importBackupJson(valid);
  if (stats.topicsCount !== 2 || stats.digestsCount !== 1) fail(`valid import stats wrong: ${JSON.stringify(stats)}`);
  if ((await getSyncState()).revision !== (beforeRev || 0) + 1) fail("valid import did not bump revision exactly once");
  if (!(await getDigests())["New B"]) fail("valid digest missing");
  console.log("VALID_MERGED");
} else if (scenario === "corrupt") {
  // Test pre-writes garbage bytes; first read must raise a named error.
  let name = "";
  try {
    await getSyncState();
  } catch (err: any) {
    name = err?.name ? `${err.name}: ${err.message}` : String(err);
  }
  if (!name.startsWith("CorruptStoreError")) fail(`wrong error: ${name}`);
  console.log(`CORRUPT_${name.slice(0, 60)}`);
  const after = await readBytes();
  if (!after.startsWith("{not json")) fail("corrupt file was modified");
  console.log("CORRUPT_UNCHANGED");
} else if (scenario === "queue") {
  const current = await getSyncState();
  await saveSyncState({ ...current, topics: ["Q0"] });
  // Sabotage: store path becomes a directory so the atomic rename fails.
  await rename(storePath, `${storePath}.bak`);
  await mkdir(storePath);
  let failed = "";
  try {
    const s = await getSyncState();
    await saveSyncState({ ...s, topics: ["Q1"] });
  } catch (err: any) {
    failed = String(err?.message || err);
  }
  if (!failed) fail("sabotaged write did not fail");
  console.log(`QUEUED_FAIL: ${failed.slice(0, 60)}`);
  await rmdir(storePath);
  await rename(`${storePath}.bak`, storePath);
  // Without a restart, the next write must succeed (queue recovered).
  const s2 = await getSyncState();
  await saveSyncState({ ...s2, topics: ["Q2"] });
  const topics = (await getSyncState()).topics;
  if (!topics.includes("Q2")) fail("recovered write lost");
  console.log("QUEUE_RECOVERED");
} else if (scenario === "hold") {
  const current = await getSyncState();
  await saveSyncState({ ...current, topics: [...current.topics, "Hold Topic"] });
  console.log("READY");
  await new Promise((r) => setTimeout(r, 8000));
  console.log("HOLDER_EXIT");
} else if (scenario === "try-write") {
  const topic = process.argv[3] || "Contender Topic";
  try {
    const current = await getSyncState();
    await saveSyncState({ ...current, topics: [...current.topics, topic] });
    console.log("WRITE_OK");
  } catch (err: any) {
    console.log(`LOCKED: ${err?.name || ""} ${String(err?.message || err).slice(0, 100)}`);
  }
} else if (scenario === "sync-locked") {
  // A second process holds the store lock (see item-9 test); the HTTP sync
  // route must fail fast with 409 store_locked instead of a 500 or clobber.
  let handler: (req: Request) => Promise<Response>;
  Bun.serve = ((opts: any) => {
    handler = opts.fetch;
    return { port: 0 };
  }) as typeof Bun.serve;
  await import("../../server");
  const res = await handler!(new Request("http://localhost/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topics: ["Locked Topic"] }),
  }));
  const body = (await res.json().catch(() => ({}))) as any;
  if (res.status !== 409 || !String(body.error || "").includes("store_locked")) {
    fail(`expected 409 store_locked, got ${res.status}: ${JSON.stringify(body).slice(0, 120)}`);
  }
  console.log(`LOCKED_HTTP_409: ${String(body.error).slice(0, 80)}`);
} else if (scenario === "sync-server") {
  let handler: (req: Request) => Promise<Response>;
  Bun.serve = ((opts: any) => {
    handler = opts.fetch;
    return { port: 0 };
  }) as typeof Bun.serve;
  await import("../../server");
  const route = (path: string, init?: RequestInit) => handler!(new Request(`http://localhost${path}`, init));
  const post = (path: string, body: unknown) =>
    route(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const state = async () => (await (await route("/api/state")).json()) as any;
  const before = await state();
  const bad = await post("/api/sync", { topics: [42] });
  if (bad.status !== 400) fail(`server topics:[42] gave ${bad.status}`);
  console.log(`SERVER_400: ${(await bad.json()).error}`);
  if (JSON.stringify((await state()).sync) !== JSON.stringify(before.sync)) fail("server state changed on 400");
  const badImport = await route("/api/backup/import", { method: "POST", body: JSON.stringify({ sync: { topics: ["T"] }, seenVideoIds: 42 }) });
  if (badImport.status !== 400) fail(`server bad import gave ${badImport.status}`);
  if (JSON.stringify((await state()).sync) !== JSON.stringify(before.sync)) fail("server state changed on bad import");
  const ok = await post("/api/sync", { topics: ["Good Topic"] });
  if (ok.status !== 200) fail(`server valid sync gave ${ok.status}`);
  console.log("SERVER_ROUTES_OK");
} else if (scenario === "sync-standalone") {
  Object.assign(globalThis, { indexedDB: {}, __RADAR_PRO_ENABLED__: false, window: globalThis });
  const idb = new Map<string, unknown>();
  const syncMap = new Map<string, unknown>();
  const localMap = new Map<string, unknown>();
  const area = (map: Map<string, unknown>) => ({
    get: async (key: string) => ({ [key]: structuredClone(map.get(key)) }),
    set: async (values: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(values)) map.set(k, structuredClone(v));
    },
    remove: async (key: string) => {
      map.delete(key);
    },
  });
  Object.assign(globalThis, { chrome: { storage: { sync: area(syncMap), local: area(localMap) } } });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: (_n: string, w: () => Promise<unknown>) => w() } },
  });
  const { mock } = await import("bun:test");
  mock.module("idb-keyval", () => ({
    get: async (key: string) => structuredClone(idb.get(key)),
    set: async (key: string, value: unknown) => {
      idb.set(key, structuredClone(value));
    },
  }));
  mock.module("../../ui/digest.js", () => ({}));
  await import("../../ui/standalone-entry");
  const route = (globalThis as any).__RADAR_STANDALONE__ as (p: string, i?: RequestInit) => Promise<Response>;
  const post = (p: string, b: unknown) =>
    route(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const bad = await post("/api/sync", { topics: [42] });
  if (bad.status !== 400) fail(`standalone topics:[42] gave ${bad.status}`);
  const ok = await post("/api/sync", { topics: ["Good Topic"] });
  if (ok.status !== 200) fail(`standalone valid sync gave ${ok.status}`);
  console.log("STANDALONE_ROUTES_OK");
} else {
  console.error(`unknown scenario: ${scenario}`);
  process.exit(1);
}

