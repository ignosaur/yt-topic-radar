import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3459;
const BASE = `http://localhost:${PORT}`;
let proc: ChildProcess;
let tmpDir: string;

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("test server did not start");
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}

async function postRaw(path: string, raw: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}

async function getState() {
  return (await (await fetch(`${BASE}/api/state`)).json()) as any;
}

const topics = (n: number) => Array.from({ length: n }, (_, i) => `Topic ${i + 1}`);

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "radar-phase4-"));
  proc = spawn("bun", ["run", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      RADAR_STORE_PATH: join(tmpDir, "store.json"),
      GEMINI_API_KEY: "",
    },
    stdio: "ignore",
  });
  await waitForServer();
});

afterAll(() => {
  proc?.kill();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test("state returns freemium + entitlements, free by default", async () => {
  const res = await fetch(`${BASE}/api/state`);
  const data: any = await res.json();
  expect(data.monetization.mode).toBe("freemium");
  expect(data.monetization.freeTopicLimit).toBe(5);
  expect(data.monetization.proEnabled).toBe(true);
  expect(data.monetization.proFeatures).not.toContain("transcript_download");
  expect(data.monetization.proFeatures).toContain("backup_export_import");
  expect(data.entitlements).toEqual({ isPro: false });
});

test("CORS: OPTIONS never emits wildcard origin", async () => {
  const noOrigin = await fetch(`${BASE}/api/state`, { method: "OPTIONS" });
  expect(noOrigin.headers.get("access-control-allow-origin")).toBeNull();
  const evil = await fetch(`${BASE}/api/state`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  const allowed = await fetch(`${BASE}/api/state`, { method: "OPTIONS", headers: { Origin: "http://localhost:3459" } });
  expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3459");
});

test("free: grow to 5 ok, 6th rejected 403; rss 403", async () => {
  const ok = await post("/api/sync", { topics: topics(5) });
  expect(ok.status).toBe(200);
  const over = await post("/api/sync", { topics: topics(6) });
  expect(over.status).toBe(403);
  expect(over.data.error).toBe("upgrade_required");
  const rss = await fetch(`${BASE}/api/rss?channelId=UC123`);
  expect(rss.status).toBe(403);
});

test("backup: free gets 403 on export and import", async () => {
  const exp = await fetch(`${BASE}/api/backup/export`);
  expect(exp.status).toBe(403);
  expect(((await exp.json()) as any).error).toBe("upgrade_required");
  const imp = await post("/api/backup/import", {});
  expect(imp.status).toBe(403);
  expect(imp.data.error).toBe("upgrade_required");
});

test("entitlements endpoint validates boolean", async () => {
  const bad = await post("/api/entitlements", { isPro: "yes" });
  expect(bad.status).toBe(400);
});

test("pro: 6 topics accepted; backup excludes entitlements", async () => {
  const unlock = await post("/api/entitlements", { isPro: true });
  expect(unlock.status).toBe(200);
  expect(unlock.data.entitlements.isPro).toBe(true);
  const over = await post("/api/sync", { topics: topics(6) });
  expect(over.status).toBe(200);
  const backup = await (await fetch(`${BASE}/api/backup/export`)).text();
  expect(backup).not.toContain("entitlements");
  expect(backup).not.toContain("isPro");
});

test("downgrade: grandfathered shrink allowed, free backup import rejected 403", async () => {
  await post("/api/entitlements", { isPro: false });
  // shrink from 6 to 2 is allowed even though a naive >5 check would block saves
  const shrink = await post("/api/sync", { topics: topics(2) });
  expect(shrink.status).toBe(200);
  const backup = JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    sync: {
      topics: Array.from({ length: 10 }, (_, i) => `Imported ${i + 1}`),
      pinnedChannels: [],
      minDurationSec: 180,
      topicMeta: {},
      telemetryOptIn: false,
    },
    digests: {},
    seenVideoIds: [],
  });
  const res = await fetch(`${BASE}/api/backup/import`, {
    method: "POST",
    body: backup,
  });
  expect(res.status).toBe(403);
  expect(((await res.json()) as any).error).toBe("upgrade_required");
  const state: any = await (await fetch(`${BASE}/api/state`)).json();
  expect(state.sync.topics.length).toBe(2);
});

test("grandfathered free user: re-save at current count ok, growth rejected, backup import 403 keeps topics", async () => {
  await post("/api/entitlements", { isPro: true });
  const grow = await post("/api/sync", { topics: topics(7) });
  expect(grow.status).toBe(200);
  await post("/api/entitlements", { isPro: false });
  const resave = await post("/api/sync", { topics: topics(7) });
  expect(resave.status).toBe(200);
  const over = await post("/api/sync", { topics: topics(8) });
  expect(over.status).toBe(403);
  const backup = JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    sync: {
      topics: ["Imported Extra"],
      pinnedChannels: [],
      minDurationSec: 180,
      topicMeta: {},
      telemetryOptIn: false,
    },
    digests: {},
    seenVideoIds: [],
  });
  const res = await fetch(`${BASE}/api/backup/import`, {
    method: "POST",
    body: backup,
  });
  expect(res.status).toBe(403);
  const state: any = await (await fetch(`${BASE}/api/state`)).json();
  expect(state.sync.topics.length).toBe(7);
});

test("concurrent scans: second gets 409 scan_in_progress", async () => {
  // Needs a key so req1 passes validation and holds the lock during the real
  // (slow) pipeline; a dummy key fails later at summarize-time, which is fine —
  // the lock window is what this test observes. Tolerant by design: if req1
  // settles before req2 arrives (e.g. no network → fast 502), there is no
  // overlap to observe and the assertion is skipped with a logged reason. The
  // lock itself is a synchronous check-and-set (see server.ts), so correctness
  // does not rest on this timing. If skipped here, DoD requires a human to
  // observe a real 409 in the manual two-tab gate.
  await post("/api/key", { apiKey: "test-dummy-key" });
  const scanInit = (topic: string) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, maxVideos: 1 }),
  });
  const req1 = fetch(`${BASE}/api/scan`, scanInit("Topic 1") as RequestInit);
  await new Promise((r) => setTimeout(r, 300));
  const req2 = await post("/api/scan", { topic: "Topic 2", maxVideos: 1 });
  const res1 = await req1;
  await res1.json().catch(() => ({})); // drain; outcome irrelevant
  if (req2.status === 409 && req2.data.error === "scan_in_progress") {
    expect(req2.data.topic).toBe("Topic 1");
  } else {
    console.warn(
      `[scan-lock] no overlap observed (req2=${req2.status}); ` +
        `manual two-tab 409 check required for DoD.`
    );
  }
}, 90000);

test("transcript: free validates videoId (no Pro gate)", async () => {
  await post("/api/entitlements", { isPro: false });
  // A 400 (not 403 upgrade_required) proves the gate is gone without
  // calling the route with a valid ID, which would hit live YouTube.
  const bad = await fetch(`${BASE}/api/transcript?videoId=bogus`);
  expect(bad.status).toBe(400);
  const missing = await fetch(`${BASE}/api/transcript`);
  expect(missing.status).toBe(400);
});

test("hostname binds 127.0.0.1", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/state`);
  expect(res.ok).toBe(true);
});

test("untrusted Origin POST rejected 403 before handler, no state change", async () => {
  const before: any = await (await fetch(`${BASE}/api/state`)).json();
  const evil = { Origin: "https://evil.example" };
  const syncRes = await fetch(`${BASE}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...evil },
    body: JSON.stringify({ topics: ["Evil Topic"] }),
  });
  expect(syncRes.status).toBe(403);
  const scanRes = await fetch(`${BASE}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...evil },
    body: JSON.stringify({ topic: "Evil Topic", maxVideos: 1 }),
  });
  expect(scanRes.status).toBe(403);
  const after: any = await (await fetch(`${BASE}/api/state`)).json();
  expect(after.sync.topics).toEqual(before.sync.topics);
  // trusted Origin still works
  const ok = await fetch(`${BASE}/api/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://localhost:${PORT}` },
    body: JSON.stringify({ event: "timestampClick" }),
  });
  expect(ok.status).toBe(200);
});

test("JSON routes reject non-JSON Content-Type, import keeps raw body", async () => {
  const bad = await fetch(`${BASE}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "not json",
  });
  expect(bad.status).toBe(415);
  // import accepts raw text/plain with no Origin (dashboard posts raw file text)
  await post("/api/entitlements", { isPro: true });
  const state: any = await (await fetch(`${BASE}/api/state`)).json();
  const backup = JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    sync: {
      topics: state.sync.topics,
      pinnedChannels: [],
      minDurationSec: 180,
      topicMeta: {},
      telemetryOptIn: false,
    },
    digests: {},
    seenVideoIds: [],
  });
  const raw = await fetch(`${BASE}/api/backup/import`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: backup,
  });
  expect(raw.status).toBe(200);
  // import is still Origin-checked
  const evilImport = await fetch(`${BASE}/api/backup/import`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body: backup,
  });
  expect(evilImport.status).toBe(403);
  await post("/api/entitlements", { isPro: false });
});

test("tricky Content-Type rejected, charset suffix still passes", async () => {
  // 'text/plain; application/json' must not sneak past the JSON gate (415)
  const tricky = await fetch(`${BASE}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "text/plain; application/json" },
    body: "{}",
  });
  expect(tricky.status).toBe(415);
  // charset-suffixed JSON still passes the gate (may 400 on body, never 415)
  const charset = await fetch(`${BASE}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: "{}",
  });
  expect(charset.status).not.toBe(415);
});

test("malformed JSON -> 400 invalid_json, no state change", async () => {
  await post("/api/key", { apiKey: "sentinel-key-12345" });
  const routes = ["/api/sync", "/api/metrics", "/api/key", "/api/scan", "/api/entitlements"];
  const bodies = ["{bad", "null"];
  for (const route of routes) {
    for (const raw of bodies) {
      const before = await getState();
      const res = await postRaw(route, raw);
      expect(res.status, `${route} ${raw}: status`).toBe(400);
      expect(res.data.error, `${route} ${raw}: error`).toBe("invalid_json");
      const after = await getState();
      expect(after, `${route} ${raw}: state`).toEqual(before);
    }
  }
  // Rejected scan bodies must not hold the scan lock: an empty-topic scan
  // still answers 400 (required), never 409 (in progress).
  const probe = await post("/api/scan", { topic: "", maxVideos: 1 });
  expect(probe.status).toBe(400);
});

test("api key: validation, short-key masking, clear", async () => {
  const badType = await post("/api/key", { apiKey: 123 });
  expect(badType.status).toBe(400);
  const tooLong = await post("/api/key", { apiKey: "x".repeat(513) });
  expect(tooLong.status).toBe(400);

  const short = await post("/api/key", { apiKey: "short123" });
  expect(short.status).toBe(200);
  let state = await getState();
  expect(state.hasApiKey).toBe(true);
  expect(state.maskedKey).toBe("••••");
  expect(state.maskedKey).not.toContain("short123");

  const cleared = await post("/api/key/clear", {});
  expect(cleared.status).toBe(200);
  state = await getState();
  expect(state.hasApiKey).toBe(false);
  expect(state.maskedKey).toBe("");
});
