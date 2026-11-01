import { test, expect } from "bun:test";
import type { GoogleGenAI } from "@google/genai";
import { generateWithFallback, parseSummaryJson, buildSummaryObject } from "../lib/summarizer";
import { classifyProviderConfigError, classifyProviderError, ProviderAvailabilityError, ProviderConfigError, ProviderFailureError, providerErrorResponse } from "../lib/provider-errors";

const quota = { status: 429, message: JSON.stringify({ error: { code: 429, message: "Quota exceeded: requests per day", status: "RESOURCE_EXHAUSTED" } }) };
const throttled = (delay: string) => ({ status: 429, message: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }] } }) });
function stub(errors: unknown[], success?: object) {
  let calls = 0;
  const ai = { models: { generateContent: async () => { const error = errors[calls++]; if (error) throw error; return success ?? { text: "ok" }; } } } as unknown as GoogleGenAI;
  return { ai, calls: () => calls };
}
const params = { contents: "test" };
// Sanitized shape of the real HAR failure: key maps to a project with the API disabled.
const apiDisabled = { status: 403, message: JSON.stringify({ error: { code: 403, message: "Gemini API has not been used in project 123456789 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com", metadata: { service: "generativelanguage.googleapis.com" } }] } }) };
const invalidKey = { status: 400, message: JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }] } }) };

test("classifies daily quota and structured retry delays without returning messages", () => {
  expect(classifyProviderError(quota)).toEqual({ code: "quota_exhausted" });
  expect(classifyProviderError(throttled("2.1s"))).toEqual({ code: "rate_limited", retryAfterSeconds: 3 });
  expect(classifyProviderError({ status: 429, message: "broken json secret" })).toEqual({ code: "rate_limited" });
  expect(classifyProviderError({ status: 500, message: "requests per day" })).toBeUndefined();
  expect(JSON.stringify(providerErrorResponse(new ProviderAvailabilityError("quota_exhausted")))).not.toContain("secret");
});

test("classifies provider config faults strictly, without leaking provider data", async () => {
  expect(classifyProviderConfigError(apiDisabled)).toBe("gemini_api_not_enabled");
  expect(classifyProviderConfigError(invalidKey)).toBe("invalid_api_key");
  expect(classifyProviderConfigError({ status: 403, message: "403 denied" })).toBeUndefined();
  expect(classifyProviderError(apiDisabled)).toBeUndefined();
  const s = stub([apiDisabled]);
  let error: unknown;
  try { await generateWithFallback(s.ai, params, async () => {}); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(ProviderConfigError);
  expect((error as ProviderConfigError).code).toBe("gemini_api_not_enabled");
  expect(s.calls()).toBe(1);
  expect(JSON.stringify(providerErrorResponse(error as ProviderConfigError))).not.toContain("123456789");
});

test("fallback succeeds after one model quota failure", async () => {
  const s = stub([quota]);
  expect((await generateWithFallback(s.ai, params, async () => {})).text).toBe("ok");
  expect(s.calls()).toBe(2);
});

test("all models quota fail produces typed sanitized error", async () => {
  const s = stub([quota, quota, quota, quota]);
  let error: unknown;
  try { await generateWithFallback(s.ai, params, async () => {}); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(ProviderAvailabilityError);
  expect((error as ProviderAvailabilityError).code).toBe("quota_exhausted");
  expect((error as Error).message).not.toContain("requests per day");
});

test("retry delay is bounded and applied only when provided", async () => {
  const s = stub([throttled("2s"), throttled("60s"), throttled("0.5s"), throttled("1s")]);
  const waits: number[] = [];
  await expect(generateWithFallback(s.ai, params, async n => { waits.push(n); })).rejects.toBeInstanceOf(ProviderAvailabilityError);
  expect(waits).toEqual([2000, 1000]);
});

test("mixed quota and provider outage is not reported as quota", async () => {
  const s = stub([quota, { status: 503, message: "503 unavailable" }, quota, quota]);
  try { await generateWithFallback(s.ai, params, async () => {}); throw new Error("expected failure"); }
  catch (e) { expect(e).toBeInstanceOf(ProviderFailureError); expect((e as Error).message).toBe("Gemini is temporarily unavailable. Please try again later."); }
});

test("quota followed by a nonretryable failure remains a fatal provider failure", async () => {
  const s = stub([quota, { status: 403, message: "403 denied" }]);
  await expect(generateWithFallback(s.ai, params, async () => {})).rejects.toBeInstanceOf(ProviderFailureError);
  expect(s.calls()).toBe(2);
});

test("outage followed by a nonretryable failure is fatal, but missing model alone is not", async () => {
  const outage = stub([{ status: 503, message: "503 unavailable" }, { status: 400, message: "invalid video" }]);
  await expect(generateWithFallback(outage.ai, params, async () => {})).rejects.toBeInstanceOf(ProviderFailureError);
  const missing = stub([{ status: 404, message: "404 model unavailable" }, { status: 400, message: "invalid video" }]);
  try { await generateWithFallback(missing.ai, params, async () => {}); throw new Error("expected failure"); }
  catch (error) { expect(error).not.toBeInstanceOf(ProviderFailureError); }
});

test("fallback telemetry logs sanitized model outcomes without provider messages", async () => {
  const s = stub([quota, quota, quota, quota]);
  const logs: string[] = [];
  await expect(generateWithFallback(s.ai, params, async () => {}, (m) => logs.push(m))).rejects.toBeInstanceOf(ProviderAvailabilityError);
  expect(logs.some((m) => m.includes("[provider]") && m.includes("outcome=quota_exhausted"))).toBe(true);
  expect(logs.some((m) => m.includes("chain_exhausted outcome=quota_exhausted"))).toBe(true);
  expect(logs.join("\n")).not.toContain("requests per day");
  const ok = stub([quota]);
  const okLogs: string[] = [];
  await generateWithFallback(ok.ai, params, async () => {}, (m) => okLogs.push(m));
  expect(okLogs.some((m) => m.includes("outcome=ok"))).toBe(true);
});

test("throwing telemetry observer never changes provider behavior", async () => {
  const throwing = () => { throw new Error("sink failed"); };
  const okStub = stub([]);
  expect((await generateWithFallback(okStub.ai, params, async () => {}, throwing)).text).toBe("ok");
  expect(okStub.calls()).toBe(1);
  const failStub = stub([quota, quota, quota, quota]);
  await expect(generateWithFallback(failStub.ai, params, async () => {}, throwing)).rejects.toBeInstanceOf(ProviderAvailabilityError);
  expect(failStub.calls()).toBe(4);
  const genericStub = stub([{ status: 400, message: "invalid video" }]);
  await expect(generateWithFallback(genericStub.ai, params, async () => {}, throwing)).rejects.toThrow("Gemini could not process this request.");
  expect(genericStub.calls()).toBe(1);
});

test("an initial nonretryable video failure remains replaceable", async () => {
  const s = stub([{ status: 400, message: "invalid video" }]);
  try { await generateWithFallback(s.ai, params, async () => {}); throw new Error("expected failure"); }
  catch (error) { expect(error).not.toBeInstanceOf(ProviderFailureError); expect((error as Error).message).toBe("Gemini could not process this request."); }
});

test("parseSummaryJson rejects invalid output with replaceable, sanitized errors", () => {
  for (const text of ['{"truncated": ', "not json at all", "null", "[]", '"string"', "42"]) {
    expect(() => parseSummaryJson(text)).toThrow(Error);
    try {
      parseSummaryJson(text);
    } catch (error) {
      expect(error).not.toBeInstanceOf(ProviderFailureError);
      expect(error).not.toBeInstanceOf(SyntaxError);
      expect((error as Error).message).toMatch(/^Gemini returned /);
    }
  }

  const valid = parseSummaryJson('{"coreThesis": "test thesis"}');
  expect(valid.coreThesis).toBe("test thesis");
});

test("buildSummaryObject rejects empty/degenerate summaries", () => {
  const dummyCandidate: any = {
    videoId: "vid1",
    title: "Title",
    channelName: "Chan",
    channelId: "c1",
    url: "https://youtube.com/watch?v=vid1",
    durationSec: 600,
    durationText: "10:00",
    signalScore: 80,
  };

  expect(() => buildSummaryObject(dummyCandidate, {})).toThrow("Gemini returned empty summary structure");

  // Valid thesis or chapter breakdown passes
  const valid = buildSummaryObject(dummyCandidate, { coreThesis: "Something" });
  expect(valid.coreThesis).toBe("Something");
  expect(valid.videoId).toBe("vid1");
});
