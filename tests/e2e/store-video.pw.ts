/**
 * Store promo clips — scripted 1280×720 screen recordings of the REAL
 * standalone prod bundle with neutral seeded state (no mocks, no network).
 *
 * Run:
 *   bun run build:ext
 *   (serve extension/ at http://localhost:3460)
 *   BASE_URL=http://localhost:3460 bunx playwright test tests/e2e/store-video.pw.ts
 *
 * Each test records one raw WebM (kept on pass) for the ffmpeg caption pass.
 * Timings are fixed sleeps so captions land on known windows; the ffmpeg
 * script trims each clip to its exact storyboard length.
 */

import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3460";
const SHOWCASE = JSON.parse(
  readFileSync("scripts/screenshot-showcase.json", "utf8")
);

test.use({
  viewport: { width: 1280, height: 720 },
  video: { mode: "on", size: { width: 1280, height: 720 } },
});

async function seedIndexedDB(page: Page) {
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

async function gotoSeeded(page: Page) {
  await page.route("**://*.youtube.com/**", (route) => route.abort());
  await page.route("**://*.youtube-nocookie.com/**", (route) => route.abort());
  await page.goto(`${BASE}/digest.html`);
  await seedIndexedDB(page);
  await page.reload();
  await page.locator("#digestContainer article").first().waitFor();
  await page.waitForTimeout(1000);
}

// Human-like cursor glide (recorded, so smoothness matters).
async function glide(page: Page, x: number, y: number) {
  await page.mouse.move(x, y, { steps: 25 });
  await page.waitForTimeout(350);
}

test("clip 1 — one digest, noise filtered", async ({ page }) => {
  await gotoSeeded(page);
  const digestScroll = page.locator("#digestContainer");
  await digestScroll.evaluate((el) => el.scrollTo({ top: 0 }));

  // 0–2.5s: hold the overview.
  await page.waitForTimeout(2500);

  // 2.5–6s: glide to the topic filter and narrow the list live.
  const filter = page.locator("#topicFilterInput");
  const box = await filter.boundingBox();
  if (box) await glide(page, box.x + box.width / 2, box.y + box.height / 2);
  await page.click("#topicFilterInput");
  await page.keyboard.type("octopus", { delay: 90 });
  await page.waitForTimeout(1500);

  // Clear, then slow scroll tour of the digest to the chapters.
  await page.fill("#topicFilterInput", "");
  await page.waitForTimeout(600);
  for (let i = 0; i < 6; i++) {
    await digestScroll.evaluate(
      (el, step) => el.scrollBy({ top: 170, behavior: "smooth" }),
      i
    );
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(800);
});

test("clip 2 — click a timestamp, player jumps", async ({ page }) => {
  await gotoSeeded(page);
  const digestScroll = page.locator("#digestContainer");
  await digestScroll.evaluate((el) => el.scrollTo({ top: 0 }));

  // 0–2.5s: hold overview, then glide down to the chapter breakdown.
  await page.waitForTimeout(2500);
  const stamp = page
    .locator("#digestContainer article")
    .first()
    .locator('button:has-text("05:40")');
  await stamp.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);

  // ~6s: click the timestamp — the player side-panel opens.
  const box = await stamp.boundingBox();
  if (box) await glide(page, box.x + box.width / 2, box.y + box.height / 2);
  await stamp.click();
  await expect(page.locator("#videoSidePanel")).toBeVisible();
  await page.waitForTimeout(1200);

  // Tour the opened panel's notes, then back to the verdict row.
  await page.locator("#sidePanelNotes").evaluate((el) => el.scrollTo({ top: 120 }));
  await page.waitForTimeout(2200);
});

test("clip 3 — the key never leaves this device", async ({ page }) => {
  await gotoSeeded(page);
  const digestScroll = page.locator("#digestContainer");
  await digestScroll.evaluate((el) => el.scrollTo({ top: 0 }));

  // 0–2.5s: hold, then glide to the settings gear.
  await page.waitForTimeout(2500);
  const gear = page.locator("#btnSettingsToggle");
  const box = await gear.boundingBox();
  if (box) await glide(page, box.x + box.width / 2, box.y + box.height / 2);
  await page.click("#btnSettingsToggle");
  await expect(page.locator("#settingsPanel")).toBeVisible();
  await page.waitForTimeout(1200);

  // Slow tour: masked key badge → storage note → stats toggle (off).
  const panel = page.locator("#settingsPanel");
  await panel.evaluate((el) => el.scrollTo({ top: 60 }));
  await page.waitForTimeout(2000);
  await glide(page, 150, 420);
  await page.waitForTimeout(2500);
});
