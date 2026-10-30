import { test, expect } from "bun:test";
import type { GoogleGenAI } from "@google/genai";
import { generateWithFallback } from "../lib/summarizer";
import { classifyProviderError, ProviderAvailabilityError, ProviderFailureError, providerErrorResponse } from "../lib/provider-errors";

const quota = { status: 429, message: JSON.stringify({ error: { code: 429, message: "Quota exceeded: requests per day", status: "RESOURCE_EXHAUSTED" } }) };
const throttled = (delay: string) => ({ status: 429, message: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }] } }) });
function stub(errors: unknown[], success?: object) {
  let calls = 0;
  const ai = { models: { generateContent: async () => { const error = errors[calls++]; if (error) throw error; return success ?? { text: "ok" }; } } } as unknown as GoogleGenAI;
  return { ai, calls: () => calls };
}
const params = { contents: "test" };

test("classifies daily quota and structured retry delays without returning messages", () => {
  expect(classifyProviderError(quota)).toEqual({ code: "quota_exhausted" });
  expect(classifyProviderError(throttled("2.1s"))).toEqual({ code: "rate_limited", retryAfterSeconds: 3 });
  expect(classifyProviderError({ status: 429, message: "broken json secret" })).toEqual({ code: "rate_limited" });
  expect(classifyProviderError({ status: 500, message: "requests per day" })).toBeUndefined();
  expect(JSON.stringify(providerErrorResponse(new ProviderAvailabilityError("quota_exhausted")))).not.toContain("secret");
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

test("an initial nonretryable video failure remains replaceable", async () => {
  const s = stub([{ status: 400, message: "invalid video" }]);
  try { await generateWithFallback(s.ai, params, async () => {}); throw new Error("expected failure"); }
  catch (error) { expect(error).not.toBeInstanceOf(ProviderFailureError); expect((error as Error).message).toBe("Gemini could not process this request."); }
});
