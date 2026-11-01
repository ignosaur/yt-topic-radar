import { test, expect } from "bun:test";
import { isBenignParserWarning, handleParserError, decodeXmlEntities, searchWithTimeout } from "../lib/youtube";

test("benign parser drift is silenced", () => {
  expect(isBenignParserWarning("class_not_found")).toBe(true);
  expect(isBenignParserWarning("class_changed")).toBe(true);
});

test("real parser errors stay loud", () => {
  for (const t of ["typecheck", "mutation_data_missing", "mutation_data_invalid", undefined, null, ""]) {
    expect(isBenignParserWarning(t)).toBe(false);
  }
});

test("installed handler suppresses benign types, warns on real ones", () => {
  const calls: string[] = [];
  handleParserError({ classname: "Clarification", error_type: "class_not_found" }, (m) => calls.push(m));
  handleParserError({ classname: "Foo", error_type: "class_changed" }, (m) => calls.push(m));
  expect(calls).toEqual([]);
  handleParserError({ classname: "Bar", error_type: "typecheck" }, (m) => calls.push(m));
  expect(calls).toEqual(["[youtubei.js][typecheck]: Bar"]);
});

test("importing the module installs the handler without throwing", async () => {
  const { Parser } = await import("youtubei.js");
  expect(typeof Parser.setParserErrorHandler).toBe("function");
});

test("decodeXmlEntities decodes XML entities and strips CDATA", () => {
  expect(decodeXmlEntities("Q&amp;A Session")).toBe("Q&A Session");
  expect(decodeXmlEntities("&lt;tag&gt;")).toBe("<tag>");
  expect(decodeXmlEntities("It&#39;s a &quot;quote&quot;")).toBe("It's a \"quote\"");
  expect(decodeXmlEntities("<![CDATA[Unescaped & Title]]>")).toBe("Unescaped & Title");
  expect(decodeXmlEntities("Plain title without entities")).toBe("Plain title without entities");
  expect(decodeXmlEntities("&amp;lt;")).toBe("&lt;"); // amp decoded last, so does not double-decode to <
});

test("searchWithTimeout rejects promptly if search hangs past deadline", async () => {
  const hangingYt = {
    search: async () => new Promise(() => {}), // never resolves
  };
  const start = Date.now();
  await expect(
    searchWithTimeout(hangingYt as any, "hanging topic", { type: "video", sort_by: "relevance" }, 50)
  ).rejects.toThrow("YouTube search timed out");
  expect(Date.now() - start).toBeLessThan(500);
});

test("default search timeout works without the Node process global", async () => {
  const proc = Bun.spawn(["bun", "-e", `
    const { searchWithTimeout } = await import("./lib/youtube.ts");
    const originalProcess = globalThis.process;
    try {
      globalThis.process = undefined;
      const result = await searchWithTimeout(
        { search: async () => ({ videos: [] }) },
        "browser topic", { type: "video", sort_by: "relevance" }
      );
      if (result.videos.length !== 0) throw new Error("Unexpected search result");
    } finally {
      globalThis.process = originalProcess;
    }
  `], { stdout: "pipe", stderr: "pipe" });
  const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(exit, stderr).toBe(0);
});

test("searchWithTimeout resolves if search finishes before deadline", async () => {
  const fastYt = {
    search: async () => ({ videos: [] }),
  };
  const res = await searchWithTimeout(fastYt as any, "fast topic", { type: "video", sort_by: "relevance" }, 1000);
  expect(res.videos).toEqual([]);
});
