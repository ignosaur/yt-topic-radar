/**
 * Manual MV3 extension smoke for Phase 4 M2 (not run by `bun test`).
 *
 * Prereqs: an isolated server on :3456, e.g.
 *   PORT=3456 RADAR_STORE_PATH=/tmp/radar-smoke-store.json bun run server.ts &
 * Then:
 *   bun tests/extension-smoke.mjs
 *
 * Verifies: service worker loads, free => no alarms, digest renders with
 * 0 page errors, ?topic= deep link, Pro => rss-poll:30 alarm at startup.
 * Cleans up by setting isPro back to false at the end.
 */
import { chromium } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://localhost:3456";
const extPath = join(import.meta.dir, "..", "extension");

async function setPro(isPro) {
  const res = await fetch(`${BASE}/api/entitlements`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isPro }),
  });
  if (!res.ok) throw new Error(`setPro(${isPro}) failed: ${res.status}`);
}

async function launch() {
  const ctx = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), "radar-smoke-")),
    {
      headless: false,
      args: [
        "--headless=new",
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
      ],
    }
  );
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10000 });
  return { ctx, sw };
}

const getAlarms = (sw) =>
  sw.evaluate(() =>
    chrome.alarms.getAll().then((a) => a.map((x) => `${x.name}:${x.periodInMinutes}`))
  );

// Free: no alarm, digest renders clean
await setPro(false);
{
  const { ctx, sw } = await launch();
  await new Promise((r) => setTimeout(r, 2000));
  console.log("free alarms:", JSON.stringify(await getAlarms(sw)));
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`chrome-extension://${extId}/digest.html?topic=${encodeURIComponent("Local LLMs")}`);
  await page.waitForTimeout(2000);
  console.log("?topic= title:", await page.textContent("#activeTopicTitle"));
  console.log("page errors:", JSON.stringify(errors));
  await ctx.close();
}

// Pro: alarm exists at startup
await setPro(true);
{
  const { ctx, sw } = await launch();
  await new Promise((r) => setTimeout(r, 3000));
  console.log("pro alarms:", JSON.stringify(await getAlarms(sw)));
  await ctx.close();
}

await setPro(false);
console.log("EXT SMOKE DONE");
