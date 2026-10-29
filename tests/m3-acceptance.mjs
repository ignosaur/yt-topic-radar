/**
 * Env: M3_SCAN_MAX_VIDEOS (default 3, 1..5), M3_SCAN_TIMEOUT_MS (default 480000),
 * STANDALONE_EXT_DIR (defaults to the newest dist zip).
 * Manual/opt-in acceptance run for M3. Requires network + GEMINI_API_KEY in .env.local. Not part of `bun test`.
 *
 * Exercises the *packaged zip* (dist/yt-topic-radar-v*.zip) in a real Chromium
 * profile with the extension loaded. Override the build with STANDALONE_EXT_DIR
 * to test an unpacked directory instead.
 *
 * Usage:
 *   bun run package:chrome
 *   node tests/m3-acceptance.mjs
 *   STANDALONE_EXT_DIR=/path/to/unpacked node tests/m3-acceptance.mjs
 *
 * Runs under node even though the product repo is Bun-only; imports only
 * @playwright/test and node builtins.
 */
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DUMMY_KEY = "m3-acceptance-dummy-key-1234567890";
const SCAN_TOPIC = "Local LLMs";
const SCAN_MAX_VIDEOS = Number(process.env.M3_SCAN_MAX_VIDEOS || 3);
const SCAN_TIMEOUT_MS = Number(process.env.M3_SCAN_TIMEOUT_MS || 8 * 60 * 1000);
const LOCALHOST_HOST = "localhost:3456";
const SERVICE_WORKER_TIMEOUT_MS = 10000;

const results = new Map();
let skipped = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(id, fn) {
  try {
    const detail = await fn();
    results.set(id, { ok: true, detail });
  } catch (error) {
    results.set(id, { ok: false, detail: error?.message || String(error) });
  }
}

function skip(id, detail) {
  skipped = true;
  results.set(id, { skip: true, detail });
}

function resolveExtensionDir() {
  if (process.env.STANDALONE_EXT_DIR) {
    const dir = resolve(process.env.STANDALONE_EXT_DIR);
    if (!existsSync(join(dir, "manifest.json"))) {
      throw new Error(
        `STANDALONE_EXT_DIR=${dir} has no manifest.json — point it at an unpacked build root.`
      );
    }
    return { dir, cleanup: [], source: dir };
  }

  const distDir = join(REPO_ROOT, "dist");
  if (!existsSync(distDir)) {
    throw new Error(
      `No dist/ directory at ${distDir}. Run \`bun run package:chrome\` first.`
    );
  }

  const zips = readdirSync(distDir)
    .filter((name) => /^yt-topic-radar-v.*\.zip$/.test(name))
    .map((name) => join(distDir, name));

  if (zips.length === 0) {
    throw new Error(
      `No dist/yt-topic-radar-v*.zip found in ${distDir}. Run \`bun run package:chrome\` first.`
    );
  }

  zips.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const zipPath = zips[0];
  const extractDir = mkdtempSync(join(tmpdir(), "radar-m3-extract-"));

  const unzip = spawnSync("unzip", ["-q", zipPath, "-d", extractDir], {
    encoding: "utf8",
  });
  if (unzip.error) {
    rmSync(extractDir, { recursive: true, force: true });
    throw new Error(
      `Could not run \`unzip\` on ${zipPath}: ${unzip.error.message}. Install unzip or set STANDALONE_EXT_DIR.`
    );
  }
  if (unzip.status !== 0) {
    rmSync(extractDir, { recursive: true, force: true });
    throw new Error(
      `\`unzip -q ${zipPath}\` exited ${unzip.status}: ${(unzip.stderr || unzip.stdout || "").trim()}`
    );
  }
  if (!existsSync(join(extractDir, "manifest.json"))) {
    rmSync(extractDir, { recursive: true, force: true });
    throw new Error(
      `Extracted ${zipPath} but found no manifest.json at its root (${extractDir}).`
    );
  }

  return { dir: extractDir, cleanup: [extractDir], source: zipPath };
}

function readEnvLocalKey() {
  const envPath = join(REPO_ROOT, ".env.local");
  if (!existsSync(envPath)) return "";
  const text = readFileSync(envPath, "utf8");
  const match = text.match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/m);
  if (!match) return "";
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

async function main() {
  let context;
  let fatal = null;
  const cleanup = [];
  const pageErrors = [];
  const localhostRequests = [];

  try {
    const ext = resolveExtensionDir();
    cleanup.push(...ext.cleanup);
    console.log(`Using extension build: ${ext.source}`);

    const userDataDir = mkdtempSync(join(tmpdir(), "radar-m3-profile-"));
    cleanup.push(userDataDir);

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--headless=new",
        "--disable-blink-features=AutomationControlled",
        `--disable-extensions-except=${ext.dir}`,
        `--load-extension=${ext.dir}`,
      ],
    });

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      try {
        serviceWorker = await context.waitForEvent("serviceworker", {
          timeout: SERVICE_WORKER_TIMEOUT_MS,
        });
      } catch {
        throw new Error(
          `No extension service worker appeared within ${SERVICE_WORKER_TIMEOUT_MS / 1000}s for "${ext.dir}". ` +
            "Playwright cannot derive the extension id without one (chrome://extensions is not scriptable)."
        );
      }
    }

    const extensionId = new URL(serviceWorker.url()).host;
    assert(extensionId, `Could not parse extension id from ${serviceWorker.url()}`);
    console.log(`Extension id: ${extensionId}`);

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

    await check("A1", () => {
      assert(
        errorsDuringLoad.length === 0,
        `${errorsDuringLoad.length} page/console error(s) during load + 2s settle:\n    ${errorsDuringLoad.join("\n    ")}`
      );
      return "zero page/console errors during load + 2s settle";
    });

    await check("A2", async () => {
      await page.waitForFunction(
        () => {
          const container = document.querySelector("#starterPacksContainer");
          return Boolean(container && (container.textContent || "").trim());
        },
        undefined,
        { timeout: 10000 }
      );

      const itemCount = await page.evaluate(() => {
        const container = document.querySelector("#starterPacksContainer");
        return container
          ? container.querySelectorAll("button, label").length
          : 0;
      });
      assert(
        itemCount > 0,
        `#starterPacksContainer has no rendered buttons/labels (count=${itemCount})`
      );

      const unique = [...new Set(localhostRequests)];
      assert(
        unique.length === 0,
        `${unique.length} request(s) to ${LOCALHOST_HOST}:\n    ${unique.join("\n    ")}`
      );

      return `starter packs rendered (${itemCount} item(s)); zero ${LOCALHOST_HOST} requests`;
    });

    await check("A3", async () => {
      if (!(await page.locator("#settingsPanel").isVisible())) {
        await page.click("#btnSettingsToggle");
      }

      await page.fill("#apiKeyInput", DUMMY_KEY);
      await page.click("#btnSaveKey");

      await page.waitForFunction(
        (key) =>
          new Promise((resolve) => {
            chrome.storage.local.get("geminiApiKey", (value) =>
              resolve(value?.geminiApiKey === key)
            );
          }),
        DUMMY_KEY,
        { timeout: 10000 }
      );

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);

      const stored = await page.evaluate(
        () =>
          new Promise((resolve) => {
            chrome.storage.local.get("geminiApiKey", (value) =>
              resolve(value?.geminiApiKey)
            );
          })
      );

      assert(
        stored === DUMMY_KEY,
        `expected chrome.storage.local.geminiApiKey === ${JSON.stringify(DUMMY_KEY)}, got ${JSON.stringify(stored)}`
      );
      return "dummy key saved via #btnSaveKey and persisted in chrome.storage.local across reload";
    });

    await check("A4", async () => {
      const topics = [
        SCAN_TOPIC,
        ...Array.from({ length: 5 }, (_, index) => `M3 Acceptance Topic ${index + 2}`),
      ];

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
          error: data?.error,
          topics: data?.sync?.topics,
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
      return "POST /api/sync accepted 6 topics (no cap) and returned sync.topics.length === 6";
    });

    const geminiKey = readEnvLocalKey();
    if (!geminiKey) {
      const reason = "GEMINI_API_KEY not found in .env.local";
      for (const id of ["A5", "A6", "A7"]) skip(id, reason);
    } else {
      await check("A5", async () => {
        const keyResponse = await page.evaluate(async (apiKey) => {
          const res = await fetch("/api/key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey }),
          });
          return { ok: res.ok, status: res.status };
        }, geminiKey);
        assert(
          keyResponse.ok,
          `POST /api/key failed with status ${keyResponse.status}`
        );

        const scanPromise = page.evaluate(
          async ({ topic, maxVideos }) => {
            const res = await fetch("/api/scan", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ topic, maxVideos }),
            });
            let data = null;
            try {
              data = await res.json();
            } catch {}
            return {
              ok: res.ok,
              status: res.status,
              error: data?.error,
              digest: data?.digest,
            };
          },
          { topic: SCAN_TOPIC, maxVideos: SCAN_MAX_VIDEOS }
        );
        const scan = await Promise.race([
          scanPromise,
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `scan exceeded ${SCAN_TIMEOUT_MS}ms (Gemini model fallback can take ~35s per candidate; raise M3_SCAN_TIMEOUT_MS or lower M3_SCAN_MAX_VIDEOS)`,
                  ),
                ),
              SCAN_TIMEOUT_MS,
            ),
          ),
        ]).catch((error) => {
          throw new Error(String(error?.message || error));
        });

        assert(
          scan.status === 200,
          `POST /api/scan status ${scan.status}${scan.error ? ` (${scan.error})` : ""}`
        );
        const videos = scan.digest?.videos;
        assert(
          Array.isArray(videos) &&
            videos.length >= 1 &&
            videos.length <= SCAN_MAX_VIDEOS,
          `expected digest.videos.length between 1 and ${SCAN_MAX_VIDEOS}, got ${Array.isArray(videos) ? videos.length : JSON.stringify(videos)}`
        );

        const state = await page.evaluate(async (topic) => {
          const res = await fetch("/api/state");
          let data = null;
          try {
            data = await res.json();
          } catch {}
          return {
            ok: res.ok,
            status: res.status,
            hasDigest: Boolean(data?.digests?.[topic]?.videos?.length),
          };
        }, SCAN_TOPIC);

        assert(
          state.hasDigest,
          `/api/state (status ${state.status}) has no digest for "${SCAN_TOPIC}"`
        );

        return `scan 200 with ${videos.length} video(s); /api/state contains the "${SCAN_TOPIC}" digest`;
      });

      await check("A6", async () => {
        await page.goto(
          `chrome-extension://${extensionId}/digest.html?topic=${encodeURIComponent(SCAN_TOPIC)}`,
          { waitUntil: "domcontentloaded" }
        );

        const button = page
          .locator("button[data-ts], button[data-jump]")
          .first();
        await button.waitFor({ state: "visible", timeout: 15000 });

        const readPlayerState = () =>
          page.evaluate(() => {
            const iframe = document.querySelector("#ytPlayerIframe");
            const watch = document.querySelector("#sidePanelYtWatchLink");
            return {
              iframeSrc: iframe?.getAttribute("src") || "",
              watchHref: watch?.getAttribute("href") || "",
            };
          });

        const label = (await button.textContent())?.trim() || "";
        const before = await readPlayerState();
        await button.click();
        await page.waitForTimeout(300);
        const after = await readPlayerState();

        const iframeOk = after.iframeSrc.includes("start=");
        const watchOk = after.watchHref.includes("t=");
        assert(
          iframeOk,
          `clicking ${JSON.stringify(label)} did not set the in-app player start=. ` +
            `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
        );
        if (!watchOk) {
          console.log(`WARN A6: watch link did not update (t=) for ${JSON.stringify(label)}`);
        }

        return (
          `chapter ${JSON.stringify(label)} clicked: ` +
          `before=${JSON.stringify(before)} -> after=${JSON.stringify(after)}`
        );
      });

      await check("A7", async () => {
        const exported = await page.evaluate(async () => {
          const res = await fetch("/api/backup/export");
          return { ok: res.ok, status: res.status, text: await res.text() };
        });

        assert(
          exported.ok,
          `GET /api/backup/export failed with status ${exported.status}`
        );
        assert(
          !/"(?:geminiApiKey|isPro|entitlements)"\s*:/.test(exported.text),
          "backup export contains a geminiApiKey/isPro/entitlements key"
        );

        let backup;
        try {
          backup = JSON.parse(exported.text);
        } catch (error) {
          throw new Error(`backup export is not valid JSON: ${error?.message || error}`);
        }

        const baseTopics =
          (Array.isArray(backup?.sync?.topics) && backup.sync.topics) ||
          (Array.isArray(backup?.topics) && backup.topics) ||
          [];
        assert(
          baseTopics.length > 0,
          "backup export has no topics (sync.topics missing/empty)"
        );

        backup.sync = backup.sync || {};
        backup.sync.topics = [
          ...new Set([
            ...baseTopics,
            ...Array.from({ length: 7 }, (_, index) => `M3 Import Topic ${index + 1}`),
          ]),
        ];

        const imported = await page.evaluate(async (payload) => {
          const res = await fetch("/api/backup/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          let data = null;
          try {
            data = await res.json();
          } catch {}
          return {
            ok: res.ok,
            status: res.status,
            error: data?.error,
            topicsCount: data?.topicsCount,
          };
        }, backup);

        assert(
          imported.ok,
          `POST /api/backup/import failed with status ${imported.status}${imported.error ? ` (${imported.error})` : ""}`
        );
        const expectedTopics = backup.sync.topics.length;
        assert(
          imported.topicsCount === expectedTopics,
          `expected import topicsCount === ${expectedTopics} (no clamp), got ${JSON.stringify(imported.topicsCount)}`
        );

        const stateTopics = await page.evaluate(async () => {
          const res = await fetch("/api/state");
          let data = null;
          try {
            data = await res.json();
          } catch {}
          return Array.isArray(data?.sync?.topics) ? data.sync.topics : [];
        });

        assert(
          stateTopics.length === expectedTopics,
          `expected /api/state sync.topics.length === ${expectedTopics}, got ${stateTopics.length}`
        );
        const missingImported = backup.sync.topics.filter(
          (topic) => !stateTopics.includes(topic)
        );
        assert(
          missingImported.length === 0,
          `imported topics missing from /api/state: ${JSON.stringify(missingImported)}`
        );

        return (
          `export clean (no key/isPro/entitlements, ${baseTopics.length} base topics); ` +
          `import topicsCount=${imported.topicsCount}, /api/state topics=${stateTopics.length}`
        );
      });
    }
  } catch (error) {
    fatal = error;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    for (const path of cleanup.reverse()) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {}
    }
  }

  const order = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"];
  let failed = false;

  for (const id of order) {
    const result = results.get(id);
    if (!result) {
      console.log(`FAIL ${id}: (not reached)`);
      failed = true;
    } else if (result.skip) {
      console.log(`SKIP ${id}: ${result.detail}`);
    } else if (result.ok) {
      console.log(`PASS ${id}: ${result.detail}`);
    } else {
      console.log(`FAIL ${id}: ${result.detail}`);
      failed = true;
    }
  }

  if (fatal) {
    console.error(`FAIL SETUP: ${fatal?.message || String(fatal)}`);
    failed = true;
  }

  if (failed) {
    console.log("M3 ACCEPTANCE: FAIL");
  } else if (skipped) {
    console.log("M3 ACCEPTANCE: PASS (with skips)");
  } else {
    console.log("M3 ACCEPTANCE: PASS");
  }

  process.exit(failed ? 1 : 0);
}

await main();
