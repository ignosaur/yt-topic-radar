import { expect, test } from "bun:test";

test("server skips malformed video output, saves replacements, and releases the lock", async () => {
  const proc = Bun.spawn(["bun", "tests/helpers/server-quota-worker.ts", "malformed"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(exit, stderr).toBe(0);
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
  for (const scan of [result.first, result.second]) {
    expect(scan.status).toBe(200);
    expect(scan.body.digest.videos.map((video: { videoId: string }) => video.videoId)).toEqual(["b", "c", "d"]);
    expect(scan.body.skippedVideos).toEqual(["a"]);
  }
  expect(result.attempts).toBe(8);
  expect([result.saves, result.metrics, result.seen]).toEqual([2, 2, 6]);
  expect(stdout + stderr).not.toContain("private-provider-output");
});

for (const [mode, expected, calls] of [["first", "quota_exhausted", 2], ["third", "quota_exhausted", 6], ["synthesis", "rate_limited", 6], ["provider", "provider_unavailable", 2], ["mixed", "provider_unavailable", 2]] as const) {
  test(`server ${mode} failure preserves state and releases scan lock`, async () => {
    const proc = Bun.spawn(["bun", "tests/helpers/server-quota-worker.ts", mode], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.first.status).toBe(mode === "provider" || mode === "mixed" ? 502 : 429);
    expect(result.first.body.error).toBe(expected);
    expect(result.second.status).toBe(result.first.status);
    expect(result.second.body.error).toBe(expected);
    expect(result.attempts).toBe(calls);
    expect([result.saves, result.metrics, result.seen]).toEqual([0, 0, 0]);
  });
}
