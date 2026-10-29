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

const topics = (n: number) => Array.from({ length: n }, (_, i) => `Topic ${i + 1}`);

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "radar-phase4-"));
  proc = spawn("bun", ["run", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      RADAR_STORE_PATH: join(tmpDir, "store.json"),
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
  expect(data.entitlements).toEqual({ isPro: false });
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

test("downgrade: grandfathered shrink allowed, import clamps to max(current,5)", async () => {
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
  const data: any = await res.json();
  expect(res.status).toBe(200);
  expect(data.topicsCount).toBe(5);
  const state: any = await (await fetch(`${BASE}/api/state`)).json();
  expect(state.sync.topics.length).toBe(5);
});

test("grandfathered free user: re-save at current count ok, growth rejected, import never truncates", async () => {
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
  const data: any = await res.json();
  expect(data.topicsCount).toBe(7);
});
