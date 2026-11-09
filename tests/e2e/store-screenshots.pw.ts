/**
 * Store screenshots — neutral, curiosity-led demo content.
 *
 * Captures the REAL standalone prod bundle (extension/digest.html, Pro
 * disabled) with neutral seeded state in IndexedDB — no mocks, no live
 * YouTube/Gemini, no dev-server-only UI.
 *
 * Run:
 *   bun run build:ext
 *   (serve extension/ at http://localhost:3460, e.g. python3 -m http.server 3460 -d extension)
 *   BASE_URL=http://localhost:3460 bunx playwright test tests/e2e/store-screenshots.pw.ts
 *
 * Produces 5 × 1280×800 PNGs in store/screenshots/ for the Chrome Web Store /
 * AMO listing. Content rules (store-safe): neutral everyday-curiosity topics,
 * no politics / health / finance claims, no accuracy guarantees, no speed or
 * metric claims, no real creator names, no Google/YouTube branding beyond
 * factual labels.
 */

import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3460";
const SHOWCASE = JSON.parse(
  readFileSync("scripts/screenshot-showcase.json", "utf8")
);

// idb-keyval defaults: DB "keyval-store", store "keyval".
async function seedIndexedDB(page: import("@playwright/test").Page) {
  await page.evaluate(
    ({ sync, digests }: { sync: unknown; digests: unknown }) => {
      const openReq = indexedDB.open("keyval-store", 1);
      return new Promise<void>((resolve, reject) => {
        openReq.onupgradeneeded = () => {
          openReq.result.createObjectStore("keyval");
        };
        openReq.onsuccess = () => {
          const db = openReq.result;
          const tx = db.transaction("keyval", "readwrite");
          const store = tx.objectStore("keyval");
          // Clearly fake demo key: settings badge shows "Key: ••••".
          store.put("demo-key", "geminiApiKey");
          store.put(sync, "radarSync");
          store.put(digests, "radarDigests");
          store.put({}, "radarMetrics");
          store.put([], "seenVideoIds");
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        openReq.onerror = () => reject(openReq.error);
      });
    },
    { sync: SHOWCASE.sync, digests: SHOWCASE.digests }
  );
}

test.use({ viewport: { width: 1280, height: 800 } });

test("capture store screenshots (neutral curiosity topics)", async ({ page }) => {
  // Never load real YouTube embeds during capture.
  await page.route("**://*.youtube.com/**", (route) => route.abort());
  await page.route("**://*.youtube-nocookie.com/**", (route) => route.abort());

  await page.goto(`${BASE}/digest.html`);
  await seedIndexedDB(page);
  await page.reload();
  await page.locator("#digestContainer article").first().waitFor();
  await page.waitForTimeout(800);

  const digestScroll = page.locator("#digestContainer");
  await digestScroll.evaluate((el) => el.scrollTo({ top: 0 }));

  // 1 — Overview: sidebar topics + digest.
  await expect(page.locator("#activeTopicTitle")).toContainText(
    "How octopuses solve puzzles"
  );
  await expect(page.locator("#footerUpgradeLine")).toBeHidden();
  await page.screenshot({ path: "store/screenshots/01-digest-overview.png" });

  // 2 — Chapters close-up: first video's timestamp breakdown.
  const firstArticle = page.locator("#digestContainer article").first();
  await firstArticle.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "store/screenshots/02-video-chapters.png" });

  // 3 — Synthesis, reframed lower in the scroll view.
  await digestScroll.evaluate((el) => el.scrollTo({ top: 220 }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: "store/screenshots/03-synthesis.png" });

  // 4 — Settings drawer (key stored locally, never synced).
  await digestScroll.evaluate((el) => el.scrollTo({ top: 0 }));
  await page.click("#btnSettingsToggle");
  await expect(page.locator("#settingsPanel")).toBeVisible();
  await expect(page.locator("#keyStatusBadge")).toContainText("Key:");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "store/screenshots/04-settings-key.png" });
  await page.click("#btnSettingsToggle");
  await expect(page.locator("#settingsPanel")).toBeHidden();

  // 5 — Starred topics filter.
  await page.click('#topicFilterTabs button[data-tab="starred"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: "store/screenshots/05-topics-starred.png" });
});
