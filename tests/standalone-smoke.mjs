/**
 * Standalone (serverless) Chrome extension smoke test.
 *
 * Prerequisites:
 *   - A standalone build directory. By default `extension/`, produced by:
 *       bun run build:ext
 *     Override with STANDALONE_EXT_DIR=/path/to/build.
 *     Do NOT use a `build:ext:dev` copy: that shell expects `bun run ui` on
 *     localhost:3456 and has no inert prod worker guarantee.
 *   - No Bun/local server running. This test proves the extension works with
 *     nothing else listening.
 *   - Playwright Chromium installed (`bunx playwright install chromium`).
 *
 * Usage:
 *   bun run build:ext && node tests/standalone-smoke.mjs
 *   STANDALONE_EXT_DIR=dist/unpacked node tests/standalone-smoke.mjs
 *
 * Note: runs under node (Playwright's runner) even though the product repo is
 * Bun-only; it imports only @playwright/test and node builtins.
 */
import { chromium } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT_DIR = resolve(process.env.STANDALONE_EXT_DIR || "extension");
const DUMMY_KEY = "standalone-smoke-key-1234567890";
const LOCALHOST_HOST = "localhost:3456";

const results = new Map();

async function check(id, label, fn) {
  try {
    await fn();
    results.set(id, { label, ok: true });
  } catch (error) {
    results.set(id, { label, ok: false, error: error?.message || String(error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  let context;
  let fatal = null;
  const pageErrors = [];
  const localhostRequests = [];

  try {
    context = await chromium.launchPersistentContext(
      mkdtempSync(join(tmpdir(), "radar-standalone-")),
      {
        headless: false,
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--headless=new",
          "--disable-blink-features=AutomationControlled",
          `--disable-extensions-except=${EXT_DIR}`,
          `--load-extension=${EXT_DIR}`,
        ],
      }
    );

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      try {
        serviceWorker = await context.waitForEvent("serviceworker", {
          timeout: 10000,
        });
      } catch {
        throw new Error(
          `No extension service worker appeared within 10s for "${EXT_DIR}". ` +
            "Playwright cannot read the extension id without one (chrome://extensions is not scriptable). " +
            "Use the standalone build in `extension/` after `bun run build:ext` — that build ships a background worker — " +
            "or point STANDALONE_EXT_DIR at a build whose manifest has a background worker."
        );
      }
    }

    const extensionId = new URL(serviceWorker.url()).host;
    if (!extensionId) {
      throw new Error(
        `Could not parse an extension id from service worker URL: ${serviceWorker.url()}`
      );
    }

    const page = await context.newPage();
    page.on("pageerror", (error) => {
      pageErrors.push(`pageerror: ${error?.message || String(error)}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        pageErrors.push(`console.error: ${message.text()}`);
      }
    });
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes(LOCALHOST_HOST)) localhostRequests.push(url);
    });

    await page.goto(`chrome-extension://${extensionId}/digest.html`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2000);

    const errorsDuringLoad = [...pageErrors];

    await check("A1", "zero page/console errors during load + 2s settle", () => {
      assert(
        errorsDuringLoad.length === 0,
        `${errorsDuringLoad.length} error(s):\n  ${errorsDuringLoad.join("\n  ")}`
      );
    });

    await check(
      "A2",
      "starter packs render at least one non-empty button/label",
      async () => {
        await page.waitForFunction(
          () => {
            const container = document.querySelector("#starterPacksContainer");
            if (!container) return false;
            const item = container.querySelector("button, label");
            return Boolean(item && (item.textContent || "").trim());
          },
          undefined,
          { timeout: 10000 }
        );

        const rendered = await page.evaluate(() => {
          const container = document.querySelector("#starterPacksContainer");
          return {
            itemCount: container
              ? container.querySelectorAll("button, label").length
              : 0,
            text: container ? (container.textContent || "").trim() : "",
          };
        });

        assert(
          rendered.itemCount >= 1,
          `expected at least one starter pack button/label, got ${rendered.itemCount}`
        );
        assert(
          rendered.text.length > 0,
          "#starterPacksContainer textContent is empty"
        );
      }
    );

    await check(
      "A4",
      "Gemini key persists in chrome.storage.local across reload",
      async () => {
        const settingsPanel = page.locator("#settingsPanel");
        if (!(await settingsPanel.isVisible())) {
          await page.click("#btnSettingsToggle");
        }

        await page.fill("#apiKeyInput", DUMMY_KEY);
        await page.click("#btnSaveKey");

        await page.waitForFunction(
          (key) => {
            const badge = document.querySelector("#keyStatusBadge");
            const toast = document.querySelector("#statusToast");
            const prefix = key.slice(0, 6);
            const badgeSaved = Boolean(
              badge && (badge.textContent || "").includes(prefix)
            );
            const toastSaved = Boolean(
              toast &&
                !toast.classList.contains("hidden") &&
                /Saved/i.test(toast.textContent || "")
            );
            return badgeSaved || toastSaved;
          },
          DUMMY_KEY,
          { timeout: 10000 }
        );

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(500);

        const stored = await page.evaluate(
          () =>
            new Promise((resolve) =>
              chrome.storage.local.get("geminiApiKey", (value) =>
                resolve(value.geminiApiKey)
              )
            )
        );

        assert(
          stored === DUMMY_KEY,
          `expected ${JSON.stringify(DUMMY_KEY)} in chrome.storage.local, got ${JSON.stringify(stored)}`
        );
      }
    );

    await check("A5", "Pro toggle exists but is hidden", async () => {
      const proToggle = page.locator("#proToggle");
      assert((await proToggle.count()) === 1, "#proToggle not found");

      await page.waitForFunction(
        () => {
          const container = document.querySelector("#starterPacksContainer");
          return Boolean(container && (container.textContent || "").trim());
        },
        undefined,
        { timeout: 10000 }
      );

      if (!(await page.locator("#settingsPanel").isVisible())) {
        await page.click("#btnSettingsToggle");
      }

      const labelHasHiddenClass = await page.evaluate(() => {
        const toggle = document.querySelector("#proToggle");
        const label = toggle && toggle.closest("label");
        return Boolean(label && label.classList.contains("hidden"));
      });
      const isVisible = await proToggle.isVisible();

      assert(
        labelHasHiddenClass || !isVisible,
        "Pro toggle is visible and its closest label does not have class 'hidden'"
      );
    });

    await check(
      "A6",
      "add-topic cap is off: /api/sync accepts 6 topics",
      async () => {
        const topics = Array.from(
          { length: 6 },
          (_, index) => `Standalone Smoke Topic ${index + 1}`
        );

        const response = await page.evaluate(async (nextTopics) => {
          const res = await fetch("/api/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ topics: nextTopics }),
          });
          let data = null;
          try {
            data = await res.json();
          } catch {}
          return {
            ok: res.ok,
            status: res.status,
            error: data && data.error,
            topics: data && data.sync && data.sync.topics,
          };
        }, topics);

        assert(
          response.ok,
          `POST /api/sync failed with status ${response.status}${response.error ? ` (${response.error})` : ""}`
        );
        assert(
          Array.isArray(response.topics),
          `response.sync.topics missing or not an array: ${JSON.stringify(response.topics)}`
        );
        assert(
          response.topics.length === 6,
          `expected sync.topics.length === 6, got ${response.topics.length}`
        );
      }
    );

    await check("A3", `no requests to ${LOCALHOST_HOST}`, () => {
      const unique = [...new Set(localhostRequests)];
      assert(
        unique.length === 0,
        `${unique.length} localhost request(s):\n  ${unique.join("\n  ")}`
      );
    });
  } catch (error) {
    fatal = error;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }

  const order = ["A1", "A2", "A3", "A4", "A5", "A6"];
  let failed = false;

  for (const id of order) {
    const result = results.get(id);
    if (!result) {
      console.log(`FAIL  ${id}  (not reached)`);
      failed = true;
    } else if (result.ok) {
      console.log(`PASS  ${id}  ${result.label}`);
    } else {
      console.log(`FAIL  ${id}  ${result.label} — ${result.error}`);
      failed = true;
    }
  }

  if (fatal) {
    console.error(`FAIL  SETUP  ${fatal?.message || String(fatal)}`);
    failed = true;
  }

  console.log(failed ? "STANDALONE SMOKE: FAIL" : "STANDALONE SMOKE: PASS");
  process.exit(failed ? 1 : 0);
}

await main();
