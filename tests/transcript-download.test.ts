import { expect, test } from "bun:test";

// Transcript download flow: API seam (both shells, transcript fetcher
// mocked in the worker — no network) + dashboard formatter/downloader
// (source-extracted with fetch/document stubs, same pattern as the
// dashboard tests in topic-lifecycle.test.ts).

for (const mode of ["server", "standalone"]) {
  test(`${mode}: transcript download API (free, no Pro gate)`, async () => {
    const proc = Bun.spawn(["bun", "tests/helpers/topic-lifecycle-worker.ts", mode, "transcript"], {
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

const source = await Bun.file(`${import.meta.dir}/../ui/digest.js`).text();
const slice = source.slice(
  source.indexOf("function transcriptToText"),
  source.indexOf("// Event Listeners")
);

function makeDownloader(fetchImpl: (url: string) => Promise<any>) {
  const toasts: Array<[string, boolean | undefined]> = [];
  const anchors: any[] = [];
  let blobText = "";
  let blobType = "";
  let offline: boolean | null = null;
  let offlineToast = "";
  const h: any = {
    fetch: fetchImpl,
    showToast: (msg: string, isErr?: boolean) => { toasts.push([msg, isErr]); },
    isServerUnreachable: (err: any) => Boolean(err?.__unreachable),
    setOfflineMode: (v: boolean) => { offline = v; },
    serverUnreachableToast: (what: string) => { offlineToast = what; },
    Blob: class extends Blob {
      constructor(parts: any[], opts: any) {
        super(parts, opts);
        blobType = opts?.type || "";
        blobText = parts.map(String).join("");
      }
    },
    URL: {
      createObjectURL: () => "blob:fixture",
      revokeObjectURL: () => {},
    },
    document: {
      createElement: () => {
        const a: any = { href: "", download: "", clicked: false, removed: false,
          click() { this.clicked = true; }, remove() { this.removed = true; } };
        anchors.push(a);
        return a;
      },
      body: { appendChild: () => {} },
    },
  };
  const fns = new Function("h", `with(h) { ${slice}; return { transcriptToText, downloadTranscript }; }`)(h);
  return { ...fns, toasts, anchors, get blobText() { return blobText; }, get blobType() { return blobType; },
    get offline() { return offline; }, get offlineToast() { return offlineToast; } };
}

const video = { title: "Hello: World! (2026)", channelName: "Chan", videoId: "dQw4w9WgXcQ" };
const blocks = [
  { timestamp: "00:00", text: "Hello" },
  { timestamp: "00:45", text: "World" },
];
const okRes = (body: any) => ({ status: 200, ok: true, json: async () => body });

test("dashboard: transcriptToText formats header + [MM:SS] lines", () => {
  const d = makeDownloader(async () => okRes({ blocks }));
  expect(d.transcriptToText(video, blocks)).toBe(
    "Hello: World! (2026)\nChannel: Chan\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n[00:00] Hello\n[00:45] World"
  );
});

test("dashboard: downloadTranscript fetches, builds .txt, clicks anchor", async () => {
  let fetchedUrl = "";
  const d = makeDownloader(async (url: string) => { fetchedUrl = url; return okRes({ blocks }); });
  await d.downloadTranscript(video);
  expect(fetchedUrl).toBe("/api/transcript?videoId=dQw4w9WgXcQ");
  expect(d.blobType).toBe("text/plain;charset=utf-8");
  expect(d.blobText).toContain("[00:45] World");
  expect(d.anchors).toHaveLength(1);
  expect(d.anchors[0].download).toBe("Hello World 2026-dQw4w9WgXcQ.txt");
  expect(d.anchors[0].clicked).toBe(true);
  expect(d.toasts).toEqual([["Downloaded transcript", undefined]]);
});

test("dashboard: downloadTranscript surfaces transcript_unavailable, no download", async () => {
  const d = makeDownloader(async () => ({ status: 502, ok: false, json: async () => ({ error: "transcript_unavailable" }) }));
  await d.downloadTranscript(video);
  expect(d.anchors).toHaveLength(0);
  expect(d.toasts).toEqual([["transcript_unavailable", true]]);
});

test("dashboard: downloadTranscript rejects empty blocks, no download", async () => {
  const d = makeDownloader(async () => okRes({ blocks: [] }));
  await d.downloadTranscript(video);
  expect(d.anchors).toHaveLength(0);
  expect(d.toasts).toEqual([["Transcript unavailable for this video", true]]);
});

test("dashboard: downloadTranscript routes unreachable server to offline mode", async () => {
  const d = makeDownloader(async () => { throw Object.assign(new TypeError("Failed to fetch"), { __unreachable: true }); });
  await d.downloadTranscript(video);
  expect(d.anchors).toHaveLength(0);
  expect(d.offline).toBe(true);
  expect(d.offlineToast).toBe("download transcript");
});
