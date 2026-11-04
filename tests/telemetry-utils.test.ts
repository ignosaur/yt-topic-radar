import { test, expect } from "bun:test";
import {
  countBucket,
  durationBucket,
  scanErrorClass,
  importErrorClass,
  browserBucket,
  buildCapturePayload,
} from "../ui/telemetry-utils.js";

const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const FIREFOX_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";

test("countBucket boundaries", () => {
  expect(countBucket(0)).toBe("0");
  expect(countBucket(-3)).toBe("0");
  expect(countBucket(NaN)).toBe("0");
  expect(countBucket(undefined)).toBe("0");
  expect(countBucket(1)).toBe("1");
  expect(countBucket(2)).toBe("2-5");
  expect(countBucket(5)).toBe("2-5");
  expect(countBucket(6)).toBe("6+");
  expect(countBucket(100)).toBe("6+");
});

test("durationBucket boundaries (lower-inclusive)", () => {
  expect(durationBucket(-1)).toBe("unknown");
  expect(durationBucket(NaN)).toBe("unknown");
  expect(durationBucket(undefined)).toBe("unknown");
  expect(durationBucket(0)).toBe("0-5s");
  expect(durationBucket(4999)).toBe("0-5s");
  expect(durationBucket(5000)).toBe("5-15s");
  expect(durationBucket(14999)).toBe("5-15s");
  expect(durationBucket(15000)).toBe("15-30s");
  expect(durationBucket(29999)).toBe("15-30s");
  expect(durationBucket(30000)).toBe("30-60s");
  expect(durationBucket(59999)).toBe("30-60s");
  expect(durationBucket(60000)).toBe("60s+");
  expect(durationBucket(600000)).toBe("60s+");
});

test("browserBucket: chrome family collapses, firefox distinct", () => {
  expect(browserBucket(CHROME_UA)).toBe("chrome");
  expect(browserBucket(EDGE_UA)).toBe("chrome");
  // Brave's UA mimics Chrome — runs the chrome build, counts as chrome.
  expect(browserBucket(CHROME_UA, true)).toBe("chrome");
  expect(browserBucket(CHROME_UA, false, [{ brand: "Brave", version: "131" }])).toBe("chrome");
  expect(browserBucket(FIREFOX_UA)).toBe("firefox");
  expect(browserBucket(SAFARI_UA)).toBe("other");
  expect(browserBucket("")).toBe("other");
  expect(browserBucket(undefined)).toBe("other");
});

test("scanErrorClass: every mapping row + unknown fallback", () => {
  expect(scanErrorClass("quota_exhausted")).toBe("quota_or_rate_limit");
  expect(scanErrorClass("rate_limited")).toBe("quota_or_rate_limit");
  expect(scanErrorClass("invalid_api_key")).toBe("api_key_problem");
  expect(scanErrorClass("gemini_api_not_enabled")).toBe("api_key_problem");
  expect(scanErrorClass("provider_unavailable")).toBe("provider_unavailable");
  expect(scanErrorClass("scan_timeout")).toBe("timeout");
  expect(scanErrorClass("scan_in_progress")).toBe("scan_in_progress");
  expect(scanErrorClass("topic_changed")).toBe("topic_changed");
  expect(scanErrorClass("boom")).toBe("unknown");
  expect(scanErrorClass("")).toBe("unknown");
  expect(scanErrorClass(undefined)).toBe("unknown");
});

test("importErrorClass: storage message shapes", () => {
  expect(importErrorClass("backup_too_large: backup exceeds 10 MiB")).toBe("backup_too_large");
  expect(importErrorClass("backup is not valid JSON")).toBe("invalid_backup");
  expect(importErrorClass("Invalid backup file format: missing sync state.")).toBe("invalid_backup");
  expect(importErrorClass("backup must be a JSON string")).toBe("invalid_backup");
  expect(importErrorClass("sync must be an object")).toBe("invalid_backup");
  expect(importErrorClass("sync.topics must be an array")).toBe("invalid_backup");
  expect(importErrorClass("seenVideoIds must be a string array")).toBe("invalid_backup");
  expect(importErrorClass("metrics must be finite numbers >= 0")).toBe("invalid_backup");
  expect(importErrorClass("digests[] must have string topic/generatedAt and a videos[] array")).toBe(
    "invalid_backup"
  );
  expect(importErrorClass("something unexpected")).toBe("invalid_backup");
  expect(importErrorClass("")).toBe("unknown");
  expect(importErrorClass(undefined)).toBe("unknown");
});

test("buildCapturePayload: envelope exact, non-allowlisted dropped", () => {
  const payload = buildCapturePayload({
    apiKey: "phc_test",
    event: "scan_completed",
    distinctId: "anon-id-1",
    version: "1.0.0",
    props: {
      duration_bucket: "5-15s",
      videos_summarized: 3,
      requested_count: 5,
      skipped_count: 1,
      slop_filtered: 1,
      seconds_saved_delta: 120,
      browser: "firefox",
      // Must never survive:
      topic: "cats",
      apiKey: "sk-secret",
      videoId: "abc123",
      url: "https://youtube.com/watch?v=abc123",
      error: "raw provider text",
    },
  });
  expect(payload).toEqual({
    api_key: "phc_test",
    event: "scan_completed",
    distinct_id: "anon-id-1",
    properties: {
      $process_person_profile: false,
      $geoip_disable: true,
      ext_version: "1.0.0",
      build: "standalone",
      schema_version: 1,
      duration_bucket: "5-15s",
      videos_summarized: 3,
      requested_count: 5,
      skipped_count: 1,
      slop_filtered: 1,
      seconds_saved_delta: 120,
      browser: "firefox",
    },
  });
});

test("buildCapturePayload: invalid browser/enum values dropped, unknown event keeps common only", () => {
  const p1 = buildCapturePayload({
    apiKey: "phc_test",
    event: "dashboard_opened",
    distinctId: "id",
    version: "1.0.0",
    props: {
      has_api_key: true,
      topics_count_bucket: "2-5",
      digests_count_bucket: "bogus",
      browser: "safari-full-ua-string",
    },
  });
  expect(p1.properties.has_api_key).toBe(true);
  expect(p1.properties.topics_count_bucket).toBe("2-5");
  expect(p1.properties.digests_count_bucket).toBeUndefined();
  expect(p1.properties.browser).toBeUndefined();

  const p2 = buildCapturePayload({
    apiKey: "phc_test",
    event: "nope_unknown",
    distinctId: "id",
    version: "1.0.0",
    props: { browser: "chrome", topic: "x" },
  });
  expect(p2.properties.browser).toBe("chrome");
  expect(p2.properties.topic).toBeUndefined();
});

test("buildCapturePayload: error_class is per-event, foreign enums dropped", () => {
  const scan = buildCapturePayload({
    apiKey: "phc_test",
    event: "scan_failed",
    distinctId: "id",
    version: "1.0.0",
    props: { duration_bucket: "5-15s", error_class: "invalid_backup", browser: "chrome" },
  });
  expect(scan.properties.error_class).toBeUndefined();
  expect(scan.properties.duration_bucket).toBe("5-15s");

  const badImport = buildCapturePayload({
    apiKey: "phc_test",
    event: "backup_import_failed",
    distinctId: "id",
    version: "1.0.0",
    props: { error_class: "quota_or_rate_limit", browser: "chrome" },
  });
  expect(badImport.properties.error_class).toBeUndefined();

  const goodImport = buildCapturePayload({
    apiKey: "phc_test",
    event: "backup_import_failed",
    distinctId: "id",
    version: "1.0.0",
    props: { error_class: "invalid_backup", browser: "chrome" },
  });
  expect(goodImport.properties.error_class).toBe("invalid_backup");
});
