// Shared pure helpers for scan status + TTS support.
// DOM-free by design: imported by ui/digest.js (browser) and by bun test.
// Keep it that way — no window/document/chrome references in this file.

/**
 * Human-readable browser name for user-facing messages.
 * Brave's desktop UA mimics Chrome (no "Brave" token) and navigator.brave has
 * been deprecated/removed in newer builds, so detection is: navigator.brave
 * signal, then UA-CH brands (Brave exposes "Brave" there), then UA string.
 * Falls back to "this browser" when nothing matches.
 */
export function getBrowserName(ua, hasBraveGlobal, uaBrands) {
  if (hasBraveGlobal) return "Brave";
  if (
    Array.isArray(uaBrands) &&
    uaBrands.some((b) => /brave/i.test(String(b?.brand || "")))
  ) {
    return "Brave";
  }
  const s = String(ua || "");
  if (/Edg\//i.test(s)) return "Edge";
  if (/Firefox\//i.test(s)) return "Firefox";
  if (/Safari\//i.test(s) && !/Chrome\//i.test(s)) return "Safari";
  if (/Chrome\//i.test(s)) return "Chrome";
  return "this browser";
}

/**
 * Whether the main panel should show the scanning skeleton for activeTopic.
 * Only the topic actually being scanned shows progress; every other topic
 * renders its cached digest (or the "not scanned yet" empty state).
 */
export function shouldShowScanning(scanningTopic, activeTopic) {
  return Boolean(scanningTopic && activeTopic && scanningTopic === activeTopic);
}

/**
 * TTS readiness: "ok" | "no-api" | "no-voices".
 * hasApi: `"speechSynthesis" in window`. voicesCount: cached
 * `speechSynthesis.getVoices().length` (callers warm the cache, see digest.js).
 */
export function ttsSupportStatus(hasApi, voicesCount) {
  if (!hasApi) return "no-api";
  if (!Number(voicesCount)) return "no-voices";
  return "ok";
}
