import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, chmodSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Lane C storage-integrity suite (items 4, 5, 8, 9). Subprocesses isolate the
// storage module cache (CLI_STORE_PATH is captured at import) and the store
// file, mirroring tests/helpers/topic-lifecycle-worker.ts. No sockets used,
// except the route-table scenarios which call the server/standalone handlers
// in-process like the lifecycle worker does.
async function runWorker(scenario: string, dir: string, extraEnv: Record<string, string> = {}, extraArgs: string[] = []) {
  const proc = Bun.spawn(["bun", "tests/helpers/storage-integrity-worker.ts", scenario, ...extraArgs], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, RADAR_STORE_PATH: join(dir, "store.json"), GEMINI_API_KEY: "", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 25000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  return { out, err, code };
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "radar-integrity-"));
}

const modeOf = (p: string) => statSync(p).mode & 0o777;

test("item 4: new store is 0600; pre-existing 0664 is tightened without content change", async () => {
  const dir = freshDir();
  try {
    const seed = JSON.stringify({
      sync: { topics: ["Seed"], pinnedChannels: [], minDurationSec: 180, topicMeta: {}, telemetryOptIn: false, revision: 3 },
      apiKey: "",
      digests: {},
      seenVideoIds: [],
    });
    writeFileSync(join(dir, "store.json"), seed, { mode: 0o664 });
    chmodSync(join(dir, "store.json"), 0o664);
    expect(modeOf(join(dir, "store.json"))).toBe(0o664);
    const { out, err, code } = await runWorker("perm", dir);
    expect(`${out}\n${err}`).toContain("PERM_OK");
    expect(code, `${out}\n${err}`).toBe(0);
    expect(modeOf(join(dir, "store.json"))).toBe(0o600);
    const disk = JSON.parse(readFileSync(join(dir, "store.json"), "utf8"));
    expect(disk.sync.topics).toContain("Seed");
    expect(disk.sync.topics).toContain("Perm Topic");
    expect(disk.apiKey).toBe("perm-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("item 5+8: rejected backups leave the store byte-identical; valid backup still merges", async () => {
  const dir = freshDir();
  try {
    const { out, err, code } = await runWorker("atomicity", dir);
    for (const marker of ["REJECTED_seen42", "REJECTED_topics42", "REJECTED_oversize", "REJECTED_oversize-bytes", "REJECTED_badDigest", "REJECTED_badMetrics", "BYTE_IDENTICAL", "VALID_MERGED"]) {
      expect(`${out}\n${err}`, `${out}\n${err}`).toContain(marker);
    }
    expect(code, `${out}\n${err}`).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("item 8: corrupt store raises a named error and the file is left unchanged", async () => {
  const dir = freshDir();
  try {
    writeFileSync(join(dir, "store.json"), "{not json, do not erase");
    const { out, err, code } = await runWorker("corrupt", dir);
    expect(`${out}\n${err}`).toContain("CORRUPT_UNCHANGED");
    expect(code, `${out}\n${err}`).toBe(0);
    expect(readFileSync(join(dir, "store.json"), "utf8")).toBe("{not json, do not erase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("item 8: one failed write does not poison the queue", async () => {
  const dir = freshDir();
  try {
    const { out, err, code } = await runWorker("queue", dir);
    expect(`${out}\n${err}`).toContain("QUEUE_RECOVERED");
    expect(code, `${out}\n${err}`).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("item 9: second writer fails fast with store_locked; succeeds after holder exits; stale lock reclaimed", async () => {
  const dir = freshDir();
  try {
    const holder = Bun.spawn(["bun", "tests/helpers/storage-integrity-worker.ts", "hold"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, RADAR_STORE_PATH: join(dir, "store.json"), GEMINI_API_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const holderKill = setTimeout(() => holder.kill(), 20000);
    // Wait for READY (holder has written and holds the lock).
    const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
    let ready = "";
    const deadline = Date.now() + 10000;
    while (!ready.includes("READY") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      ready += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    expect(ready).toContain("READY");
    expect(modeOf(join(dir, "store.json.lock"))).toBe(0o600);

    const first = await runWorker("try-write", dir, {}, ["First Topic"]);
    expect(first.code).toBe(0);
    expect(`${first.out}\n${first.err}`).toContain("store_locked");

    const holderCode = await holder.exited;
    clearTimeout(holderKill);
    reader.releaseLock();
    const holderErr = await new Response(holder.stderr).text();
    expect(holderCode, `${ready}\n${holderErr}`).toBe(0);
    // P1: clean exit releases the lock instead of leaving a stale file.
    expect(existsSync(join(dir, "store.json.lock"))).toBe(false);

    const disk = JSON.parse(readFileSync(join(dir, "store.json"), "utf8"));
    expect(disk.sync.topics).toContain("Hold Topic");
    expect(disk.sync.topics).not.toContain("First Topic");

    const second = await runWorker("try-write", dir, {}, ["Second Topic"]);
    expect(second.code).toBe(0);
    expect(`${second.out}\n${second.err}`).toContain("WRITE_OK");
    const disk2 = JSON.parse(readFileSync(join(dir, "store.json"), "utf8"));
    expect(disk2.sync.topics).toContain("Hold Topic");
    expect(disk2.sync.topics).toContain("Second Topic");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("item 9: locked /api/sync returns 409 store_locked", async () => {
  const dir = freshDir();
  let holder: ReturnType<typeof Bun.spawn> | null = null;
  try {
    holder = Bun.spawn(["bun", "tests/helpers/storage-integrity-worker.ts", "hold"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, RADAR_STORE_PATH: join(dir, "store.json"), GEMINI_API_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
    let ready = "";
    const deadline = Date.now() + 10000;
    while (!ready.includes("READY") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      ready += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    expect(ready).toContain("READY");
    const res = await runWorker("sync-locked", dir);
    expect(res.code, `${res.out}\n${res.err}`).toBe(0);
    expect(`${res.out}\n${res.err}`).toContain("LOCKED_HTTP_409");
    expect(`${res.out}\n${res.err}`).toContain("store_locked");
  } finally {
    holder?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("item 9: lock left by a dead pid does not wedge the next writer", async () => {
  const dir = freshDir();
  try {
    // Harvest a genuinely dead pid from a reaped child.
    const probe = Bun.spawn(["bun", "--version"], { stdout: "pipe", stderr: "pipe" });
    await probe.exited;
    writeFileSync(join(dir, "store.json.lock"), String(probe.pid));
    const res = await runWorker("try-write", dir, {}, ["Stale Topic"]);
    expect(res.code).toBe(0);
    expect(`${res.out}\n${res.err}`).toContain("WRITE_OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("item 5: server and standalone /api/sync reject topics [42] with 400", async () => {
  for (const scenario of ["sync-server", "sync-standalone"]) {
    const dir = freshDir();
    try {
      const { out, err, code } = await runWorker(scenario, dir);
      expect(`${out}\n${err}`).toContain(scenario === "sync-server" ? "SERVER_ROUTES_OK" : "STANDALONE_ROUTES_OK");
      expect(code, `${out}\n${err}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("item 1: 20 concurrent updateMetrics increments land at exactly 20", async () => {
  const dir = freshDir();
  try {
    const { out, err, code } = await runWorker("metrics-concurrency", dir);
    expect(`${out}\n${err}`).toContain("METRICS_CONCURRENT_OK");
    expect(code, `${out}\n${err}`).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("item 7: fresh restore derives 0 for slopVideosFiltered and accurate counts", async () => {
  const dir = freshDir();
  try {
    const { out, err, code } = await runWorker("restore-metrics", dir);
    expect(`${out}\n${err}`).toContain("RESTORE_METRICS_OK");
    expect(code, `${out}\n${err}`).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
