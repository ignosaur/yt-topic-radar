// Pure telemetry helpers for anonymous usage capture (PostHog).
// DOM-free by design: imported by ui/digest.js (browser) and by bun test.
// Keep it that way — no window/document/chrome/fetch/state references.
import { getBrowserName } from "./tts-scan-utils.js";

export const SCHEMA_VERSION = 1;
export const BUILD = "standalone";

export const COUNT_BUCKETS = ["0", "1", "2-5", "6+"];

/** Bucket a count for privacy: exact small numbers, coarse bands above. */
export function countBucket(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v <= 1) return "1";
  if (v <= 5) return "2-5";
  return "6+";
}

export const DURATION_BUCKETS = ["0-5s", "5-15s", "15-30s", "30-60s", "60s+", "unknown"];

/**
 * Bucket a scan wall-clock duration (scan_started -> terminal event,
 * measured in the digest.js scan handler with Date.now()). Edges are
 * lower-bound inclusive: <5000 -> "0-5s", <15000 -> "5-15s",
 * <30000 -> "15-30s", <60000 -> "30-60s", else "60s+".
 * Non-finite/negative input -> "unknown" (never throws, never leaks input).
 */
export function durationBucket(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return "unknown";
  if (v < 5000) return "0-5s";
  if (v < 15000) return "5-15s";
  if (v < 30000) return "15-30s";
  if (v < 60000) return "30-60s";
  return "60s+";
}

export const SCAN_ERROR_CLASSES = [
  "quota_or_rate_limit",
  "api_key_problem",
  "provider_unavailable",
  "timeout",
  "scan_in_progress",
  "topic_changed",
  "unknown",
];

/** Map a structured /api/scan `error` code to a coarse error_class. Never the raw message. */
export function scanErrorClass(code) {
  switch (String(code ?? "")) {
    case "quota_exhausted":
    case "rate_limited":
      return "quota_or_rate_limit";
    case "invalid_api_key":
    case "gemini_api_not_enabled":
      return "api_key_problem";
    case "provider_unavailable":
      return "provider_unavailable";
    case "scan_timeout":
      return "timeout";
    case "scan_in_progress":
      return "scan_in_progress";
    case "topic_changed":
      return "topic_changed";
    default:
      return "unknown";
  }
}

export const IMPORT_ERROR_CLASSES = ["invalid_backup", "backup_too_large", "unknown"];

/**
 * Map a backup import failure to a coarse error_class. Empty/missing input
 * -> "unknown"; oversize signals -> "backup_too_large"; anything else
 * non-empty -> "invalid_backup" (all parse/validation failures are corrupt
 * backups). Substring rules, case-insensitive — the raw message is never sent.
 */
export function importErrorClass(messageOrCode) {
  const s = String(messageOrCode ?? "").toLowerCase();
  if (!s) return "unknown";
  if (s.includes("backup_too_large") || s.includes("exceeds") || s.includes("too large"))
    return "backup_too_large";
  return "invalid_backup";
}

export const BROWSERS = ["chrome", "firefox", "other"];

/**
 * Which extension build family is running. Built on getBrowserName (same
 * (ua, hasBrave, uaBrands) argument order): Chromium browsers (Chrome, Edge,
 * Brave) share the chrome build, so they map to "chrome"; Firefox maps to
 * "firefox"; anything else (Safari, "this browser") maps to "other".
 * Takes the UA string, navigator.brave signal, and UA-CH brands as inputs
 * (pure for testability) — the full UA string itself is never sent.
 */
export function browserBucket(ua, hasBrave, uaBrands) {
  const name = getBrowserName(ua, hasBrave, uaBrands);
  if (name === "Chrome" || name === "Edge" || name === "Brave") return "chrome";
  if (name === "Firefox") return "firefox";
  return "other";
}

// Per-event property allowlist. `browser` is common to every event (when
// valid) and listed here per event so the guarantee stays explicit.
const EVENT_PROPS = {
  dashboard_opened: ["has_api_key", "topics_count_bucket", "digests_count_bucket", "browser"],
  api_key_saved: ["browser"],
  scan_started: ["max_videos", "browser"],
  scan_completed: [
    "duration_bucket",
    "videos_summarized",
    "requested_count",
    "skipped_count",
    "slop_filtered",
    "seconds_saved_delta",
    "browser",
  ],
  scan_failed: ["duration_bucket", "error_class", "browser"],
  timestamp_clicked: ["browser"],
  tts_played: ["browser"],
  backup_exported: ["browser"],
  backup_export_failed: ["error_class", "browser"],
  backup_imported: ["topics_count_bucket", "digests_count_bucket", "browser"],
  backup_import_failed: ["error_class", "browser"],
};

const BUCKET_SET = new Set(COUNT_BUCKETS);
const DURATION_SET = new Set(DURATION_BUCKETS);
const SCAN_ERROR_SET = new Set(SCAN_ERROR_CLASSES);
const IMPORT_ERROR_SET = new Set(IMPORT_ERROR_CLASSES);
const BROWSER_SET = new Set(BROWSERS);

function pickBucket(v) {
  const s = String(v ?? "");
  return BUCKET_SET.has(s) ? s : undefined;
}

function pickDuration(v) {
  const s = String(v ?? "");
  return DURATION_SET.has(s) ? s : undefined;
}

const EMPTY_SET = new Set();

// error_class is per-event: scan failures use the scan taxonomy, backup
// failures the import taxonomy. A valid-but-foreign value is dropped.
const EVENT_ERROR_SET = {
  scan_failed: SCAN_ERROR_SET,
  backup_export_failed: IMPORT_ERROR_SET,
  backup_import_failed: IMPORT_ERROR_SET,
};

function pickError(event, v) {
  const allowed = EVENT_ERROR_SET[String(event)] ?? EMPTY_SET;
  const s = String(v ?? "");
  return allowed.has(s) ? s : undefined;
}

function pickBrowser(v) {
  const s = String(v ?? "");
  return BROWSER_SET.has(s) ? s : undefined;
}

function pickInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function coerceProp(key, value, event) {
  switch (key) {
    case "has_api_key":
      return typeof value === "boolean" ? value : undefined;
    case "topics_count_bucket":
    case "digests_count_bucket":
      return pickBucket(value);
    case "duration_bucket":
      return pickDuration(value);
    case "error_class":
      return pickError(event, value);
    case "browser":
      return pickBrowser(value);
    case "max_videos":
    case "videos_summarized":
    case "requested_count":
    case "skipped_count":
    case "slop_filtered":
    case "seconds_saved_delta":
      return pickInt(value);
    default:
      return undefined;
  }
}

/**
 * Build the PostHog capture payload. Emits only the envelope keys plus the
 * per-event allowlist above — every other property in `props` (topic,
 * apiKey, videoId, url, raw errors, ...) is silently dropped. Never throws.
 */
export function buildCapturePayload({ apiKey, event, distinctId, version, props }) {
  const allowed = EVENT_PROPS[String(event)] ?? ["browser"];
  const properties = {
    $process_person_profile: false,
    $geoip_disable: true,
    ext_version: String(version ?? ""),
    build: BUILD,
    schema_version: SCHEMA_VERSION,
  };
  const src = props && typeof props === "object" ? props : {};
  for (const key of allowed) {
    const coerced = coerceProp(key, src[key], String(event ?? ""));
    if (coerced !== undefined) properties[key] = coerced;
  }
  return {
    api_key: String(apiKey ?? ""),
    event: String(event ?? ""),
    distinct_id: String(distinctId ?? ""),
    properties,
  };
}
