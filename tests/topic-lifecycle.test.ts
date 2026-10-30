import { expect, test } from "bun:test";

// Subprocesses isolate Bun module mocks, browser globals, and storage caches
// from the existing engine/parser suites. No sockets or service calls are used.
for (const mode of ["server", "standalone"]) {
  for (const scenario of ["cleanup", "stale", "concurrent", "ordinary", "deleted", "readd", "unrelated", ...(mode === "standalone" ? ["sync-failure"] : [])]) {
    test(`${mode}: topic lifecycle ${scenario}`, async () => {
      const proc = Bun.spawn(["bun", "tests/helpers/topic-lifecycle-worker.ts", mode, scenario], {
        cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe",
      });
      const timeout = setTimeout(() => proc.kill(), 8000);
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      clearTimeout(timeout);
      expect(`${out}\n${err}`).not.toContain("External network is forbidden");
      expect(code, `${out}\n${err}`).toBe(0);
    }, 10000);
  }
}

// Execute the actual dashboard function with UI/network boundaries replaced.
const source = await Bun.file(`${import.meta.dir}/../ui/digest.js`).text();
const saveSource = source.slice(source.indexOf("async function saveSync("), source.indexOf("function renderMetricsUI("));
for (const failure of ["network", "http"]) {
  test(`dashboard: ${failure} save failure restores the last confirmed state`, async () => {
    const original = { topics: ["A", "B"], topicMeta: {} };
    const h: any = {
      state: { sync: structuredClone(original), digests: { A: { videos: [] } } },
      activeTopic: "B", starterAutoCollapsedOnce: true,
      fetch: async () => { if (failure === "network") throw new TypeError("Failed to fetch"); return Response.json({ error: "stale_state" }, { status: 409 }); },
      loadState: async () => { h.state.sync = structuredClone(original); },
      isServerUnreachable: () => true, setOfflineMode: () => {}, serverUnreachableToast: () => {},
      showToast: () => {}, renderAll: () => {},
    };
    const save = new Function("h", `with(h) { ${saveSource}; return saveSync; }`)(h);
    await save({ ...original, topics: ["B"] });
    expect(h.state.sync.topics).toEqual(["A", "B"]);
  });
}
test("dashboard: confirmed deletion clears its cached digest", async () => {
  const h: any = {
    state: { sync: { topics: ["A", "B"] }, digests: { A: { videos: [] }, B: { videos: ["keep"] } } },
    activeTopic: "B", starterAutoCollapsedOnce: true,
    fetch: async () => Response.json({ ok: true, sync: { topics: ["B"] } }),
    loadState: async () => {}, setOfflineMode: () => {}, showToast: () => {}, renderAll: () => {},
  };
  const save = new Function("h", `with(h) { ${saveSource}; return saveSync; }`)(h);
  await save({ topics: ["B"] });
  expect(h.state.digests.A).toBeUndefined();
  expect(h.state.digests.B).toEqual({ videos: ["keep"] });
});

test("dashboard: a late successful scan response cannot populate a re-added topic", async () => {
  const begin = source.indexOf('el("btnScanTopic").addEventListener("click",');
  const end = source.indexOf("// 1-Click Export Backup", begin);
  let click: () => Promise<void>;
  let resolveScan: (response: Response) => void = () => {};
  const scan = new Promise<Response>(resolve => { resolveScan = resolve; });
  const nodes = new Map<string, any>();
  const h: any = {
    state: { sync: { topics: ["A"] }, digests: {}, metrics: {} },
    activeTopic: "A", scanningTopic: "", isServerOffline: false,
    el: (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { value: "1", addEventListener: (_event: string, fn: () => Promise<void>) => { click = fn; } });
      return nodes.get(id);
    },
    fetch: () => scan,
    loadState: async () => { h.state = { sync: { topics: ["A"] }, digests: {}, metrics: {} }; },
    renderSidebar: () => {}, renderMainDigest: () => {}, renderAll: () => {},
    setOfflineMode: () => {}, resetRssUnread: () => {}, showToast: () => {},
    isServerUnreachable: () => false, serverUnreachableToast: () => {},
  };
  new Function("h", `with(h) { ${source.slice(begin, end)} }`)(h);
  const pending = click!();
  // The user deletes and re-adds A while the response is in flight.
  h.state = { sync: { topics: ["A"] }, digests: {}, metrics: {} };
  resolveScan(Response.json({ digest: { topic: "A", videos: ["old-scan"] } }));
  await pending;
  expect(h.state.digests.A).toBeUndefined();
  expect(h.scanningTopic).toBe("");
});
