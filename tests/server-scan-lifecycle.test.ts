import { expect, test } from "bun:test";

async function runWorker(mode: "timeout" | "reuse") {
  const proc = Bun.spawn(["bun", "tests/helpers/server-scan-lifecycle-worker.ts", mode], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RADAR_SCAN_TIMEOUT_MS: "50" },
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

test("server hanging scan hits deadline: 504, zero writes; replacement survives, old body never overwrites", async () => {
  const r = await runWorker("timeout");
  expect(r.first.status).toBe(504);
  expect(r.stateAfterFirst).toEqual({ saves: 0, metrics: 0, seen: 0 });
  expect(r.second.status).toBe(200);
  expect(r.saves).toBe(1);
  expect(r.secondDigestSaved).toBe(true);
}, 30000);

test("server identical rescan reuses summaries and skips synthesis; one-video change summarizes exactly 1", async () => {
  const r = await runWorker("reuse");
  expect(r.statuses).toEqual([200, 200, 200]);
  expect(r.summarizeCalls).toBe(4); // 3 + 0 + 1
  expect(r.synthCalls).toBe(2); // 1 + 0 + 1
  expect(r.saves).toBe(3);
  expect(r.metricsDeltas[1]).toMatchObject({ scansCompleted: 1, videosSummarized: 0, secondsSaved: 0 });
  expect(r.seenCount).toBe(4); // 3 fresh + 0 reused + 1 fresh
  expect(r.keptSynthesis).toBe(true);
}, 30000);
