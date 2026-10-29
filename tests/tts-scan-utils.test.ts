import { test, expect } from "bun:test";
import {
  getBrowserName,
  shouldShowScanning,
  ttsSupportStatus,
} from "../ui/tts-scan-utils.js";

const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// Brave's desktop UA deliberately mimics Chrome — no "Brave" token.
const BRAVE_UA = CHROME_UA;
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const FIREFOX_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";

test("getBrowserName: Brave needs the navigator.brave signal (UA looks like Chrome)", () => {
  expect(getBrowserName(BRAVE_UA, true)).toBe("Brave");
  // Without the flag the same UA reads as Chrome — documents why callers
  // must pass Boolean(navigator.brave).
  expect(getBrowserName(BRAVE_UA, false)).toBe("Chrome");
});

test("getBrowserName: UA-CH brands cover Brave when navigator.brave is gone", () => {
  const braveBrands = [
    { brand: "Chromium", version: "131" },
    { brand: "Brave", version: "131" },
  ];
  expect(getBrowserName(BRAVE_UA, false, braveBrands)).toBe("Brave");
  expect(getBrowserName(BRAVE_UA, false, undefined)).toBe("Chrome");
  expect(getBrowserName(BRAVE_UA, false, [])).toBe("Chrome");
});

test("getBrowserName: common browsers + unknown fallback", () => {
  expect(getBrowserName(CHROME_UA, false)).toBe("Chrome");
  expect(getBrowserName(EDGE_UA, false)).toBe("Edge");
  expect(getBrowserName(FIREFOX_UA, false)).toBe("Firefox");
  expect(getBrowserName(SAFARI_UA, false)).toBe("Safari");
  expect(getBrowserName("", false)).toBe("this browser");
  expect(getBrowserName(undefined, false)).toBe("this browser");
});

test("shouldShowScanning: only the scanned topic shows the skeleton", () => {
  expect(shouldShowScanning("A", "A")).toBe(true);
  expect(shouldShowScanning("A", "B")).toBe(false);
  expect(shouldShowScanning("", "A")).toBe(false);
  expect(shouldShowScanning("A", "")).toBe(false);
  expect(shouldShowScanning("", "")).toBe(false);
});

test("ttsSupportStatus: api/voices matrix", () => {
  expect(ttsSupportStatus(false, 0)).toBe("no-api");
  expect(ttsSupportStatus(false, 5)).toBe("no-api");
  expect(ttsSupportStatus(true, 0)).toBe("no-voices");
  expect(ttsSupportStatus(true, 3)).toBe("ok");
});
