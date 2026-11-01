/**
 * Lane B — Dashboard XSS regression test (docs/performance-security-audit.md item 1)
 *
 * Seeds hostile payloads (<img onerror>, <svg onload>, </button><script>)
 * through every digest render sink (topic title, cross-video synthesis,
 * chapter titles/timestamps/key points, type-specific details, video meta
 * badges, side-panel notes) by mocking GET /api/state, then asserts:
 *   • no payload element is created (no img/svg/script side effects)
 *   • window.__xss is never set (no handler executed)
 *   • the payload text renders literally (escaped, visible)
 *   • benign fields still render normally
 *
 * Run:
 *   PORT=3459 bun run server.ts &
 *   bunx playwright test tests/dashboard-xss.spec.ts
 */

import { test, expect } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3459";

const POISONED_TOPIC =
  `XSS-TOPIC-MARKER<img src=x onerror="window.__xss='topic'">`;

function poisonedState() {
  return {
    sync: {
      topics: [POISONED_TOPIC],
      pinnedChannels: [],
      topicMeta: {},
      minDurationSec: 0,
      telemetryOptIn: false,
    },
    digests: {
      [POISONED_TOPIC]: {
        generatedAt: new Date().toISOString(),
        requestedCount: 2,
        crossVideoSynthesis:
          `SYNTH-MARKER<svg onload="window.__xss='synth'"></svg> synthesis text`,
        suggestedSubtopics: [],
        skippedVideos: [],
        videos: [
          {
            videoId: `dQw4w9WgXcQ"onmouseover="window.__xss='vid`,
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            title: `XSS-TITLE-MARKER<img src=x onerror="window.__xss='title'">`,
            channelId: `chan"onmouseover="window.__xss='chanid`,
            channelName: `CHAN-MARKER<img src=x onerror="window.__xss='chan'">`,
            videoType: `evil_type<img src=x onerror="window.__xss='vtype'">`,
            worthWatchingFull: `No<img src=x onerror="window.__xss='verdict'">`,
            worthWatchingReason: "because reasons",
            signalScore: `99<img src=x onerror="window.__xss='score'>"`,
            durationText: `10:00<img src=x onerror="window.__xss='dur'">`,
            coreThesis:
              `THESIS-MARKER<img src=x onerror="window.__xss='thesis'">`,
            chapterBreakdown: [
              {
                timestamp: `00:07"><img src=x onerror="window.__xss='ts'">`,
                sectionTitle: `CHAPTER-MARKER<img src=x onerror="window.__xss='chapter'">`,
                keyPoints: [
                  `KP-MARKER<img src=x onerror="window.__xss='kp'">`,
                ],
              },
            ],
            typeSpecificDetails: [
              {
                label: `LABEL-MARKER</button><script>window.__xss='label'</script>`,
                items: [
                  `ITEM-MARKER<img src=x onerror="window.__xss='item'">`,
                ],
              },
            ],
          },
          {
            videoId: "clean-video-id-123",
            url: "https://www.youtube.com/watch?v=clean-video-id-123",
            title: "A perfectly benign video title",
            channelId: "clean-channel-id",
            channelName: "Clean Channel",
            videoType: "tutorial",
            worthWatchingFull: "Yes",
            worthWatchingReason: "genuinely useful",
            signalScore: 95,
            durationText: "12:34",
            coreThesis: "The clean core takeaway.",
            chapterBreakdown: [
              {
                timestamp: "01:23",
                sectionTitle: "Clean section",
                keyPoints: ["Clean key point"],
              },
            ],
            typeSpecificDetails: [],
          },
        ],
      },
    },
    metrics: {},
    entitlements: { isPro: false },
    monetization: { freeTopicLimit: 5, proEnabled: true },
    starterTopics: {},
    hasApiKey: false,
    maskedKey: "",
  };
}

async function gotoPoisoned(page) {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__xss = null;
  });
  await page.route("**/api/state", (route) =>
    route.fulfill({ json: poisonedState() })
  );
  // Keep the test hermetic: never load real YouTube embeds.
  await page.route("**://*.youtube.com/**", (route) => route.abort());
  await page.route("**://*.youtube-nocookie.com/**", (route) => route.abort());
  await page.goto(BASE);
  await page.locator("#digestContainer article").first().waitFor();
  // Let onerror/onload handlers fire if anything actually parsed as HTML.
  await page.waitForTimeout(500);
}

async function xssFlag(page): Promise<unknown> {
  return page.evaluate(
    () => (window as unknown as Record<string, unknown>).__xss
  );
}

test.describe("dashboard XSS sinks stay escaped", () => {
  test("no payload executes in the main digest", async ({ page }) => {
    await gotoPoisoned(page);

    expect(await xssFlag(page), "window.__xss must stay null").toBeNull();

    const badEls = await page
      .locator(
        "#digestContainer img, #digestContainer svg, #digestContainer script, #digestContainer iframe"
      )
      .count();
    expect(badEls, "no injected elements in digest").toBe(0);
  });

  test("payloads render as literal text", async ({ page }) => {
    await gotoPoisoned(page);

    const container = page.locator("#digestContainer");
    for (const marker of [
      "XSS-TITLE-MARKER",
      "SYNTH-MARKER",
      "CHAPTER-MARKER",
      "KP-MARKER",
      "LABEL-MARKER",
      "ITEM-MARKER",
      "CHAN-MARKER",
    ]) {
      await expect(container).toContainText(marker);
    }
    // Raw markup must be visible as text, not parsed away.
    const html = await container.innerHTML();
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;svg");
    expect(html).toContain("&lt;/button&gt;");

    expect(await xssFlag(page)).toBeNull();
  });

  test("benign fields still render", async ({ page }) => {
    await gotoPoisoned(page);

    const container = page.locator("#digestContainer");
    await expect(container).toContainText("Cross-Video Topic Synthesis");
    await expect(container).toContainText("A perfectly benign video title");
    await expect(container).toContainText("Clean Channel");
    await expect(container).toContainText("The clean core takeaway.");
    await expect(container).toContainText("Clean section");
    await expect(container).toContainText("Verdict: Yes");

    expect(await xssFlag(page)).toBeNull();
  });

  test("no payload executes in the side panel", async ({ page }) => {
    await gotoPoisoned(page);

    // Open the docked player via the poisoned video's timestamp button.
    await page.locator("#digestContainer [data-ts]").first().click();
    const panel = page.locator("#videoSidePanel");
    await expect(panel).toBeVisible();
    await page.waitForTimeout(500);

    expect(await xssFlag(page), "window.__xss must stay null").toBeNull();

    const badEls = await page
      .locator("#videoSidePanel img, #videoSidePanel svg, #videoSidePanel script")
      .count();
    expect(badEls, "no injected elements in side panel").toBe(0);

    const notes = page.locator("#sidePanelNotes");
    await expect(notes).toContainText("THESIS-MARKER");
    await expect(notes).toContainText("KP-MARKER");
    await expect(notes).toContainText("CHAPTER-MARKER");
  });
});
