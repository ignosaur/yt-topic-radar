/**
 * Phase 3 — Responsive Layout Regression Tests (§2b from HANDOFF-PHASE3.md)
 *
 * Verifies the two critical viewport breakpoints of the digest UI:
 *   • 1280×800 — desktop: sidebar static, mobile toggle hidden
 *   •  360×800 — mobile:  sidebar off-canvas, ☰ Topics button visible, drawer opens/closes
 *
 * Run:
 *   PORT=3459 bun run server.ts &
 *   bunx playwright test tests/e2e/responsive-layout.pw.ts
 *
 * The server URL is read from the BASE_URL env variable (default: http://localhost:3459).
 * Use a port other than 3456 so CI does not collide with the dev server.
 */

import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3459";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the bounding-box of an element, or null if it's invisible. */
async function bbox(page: Page, selector: string) {
  const el = page.locator(selector);
  return el.boundingBox();
}

// ---------------------------------------------------------------------------
// Desktop — 1280×800
// ---------------------------------------------------------------------------

test.describe("1280×800 desktop layout", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("sidebar is visible and static (not a drawer)", async ({ page }) => {
    await page.goto(BASE);
    const box = await bbox(page, "#topicsSidebar");
    expect(box, "sidebar should be visible at 1280px").toBeTruthy();
    expect(box!.x).toBeCloseTo(0, -1); // anchored to left edge
    expect(box!.width).toBeGreaterThanOrEqual(280);
  });

  test("mobile ☰ Topics toggle button is hidden at 1280px", async ({
    page,
  }) => {
    await page.goto(BASE);
    // The button uses the .sm-only-btn class which hides it above 640px via CSS.
    const btn = page.locator("#btnToggleSidebar");
    await expect(btn).toBeHidden();
  });

  test("no page console errors at 1280px", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto(BASE);
    await page.waitForTimeout(500);
    expect(errors, `Console errors: ${errors.join(", ")}`).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mobile — 360×800
// ---------------------------------------------------------------------------

test.describe("360×800 mobile layout", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("sidebar starts off-canvas at 360px", async ({ page }) => {
    await page.goto(BASE);
    // At 360px the sidebar should be translated/hidden off-screen.
    // The CSS moves it left with translateX(-100%) when not .sidebar-open.
    const hasOpen = await page
      .locator("#topicsSidebar")
      .evaluate((el) => el.classList.contains("sidebar-open"));
    expect(hasOpen).toBe(false);
  });

  test("☰ Topics button opens the drawer", async ({ page }) => {
    await page.goto(BASE);
    const toggleBtn = page.locator("#btnToggleSidebar");
    await expect(toggleBtn).toBeVisible();

    await toggleBtn.click();

    const box = await bbox(page, "#topicsSidebar");
    expect(box, "sidebar should be visible after opening drawer").toBeTruthy();
    // Drawer should span most of the viewport width (≥ 90% of 360px)
    expect(box!.width).toBeGreaterThan(300);
  });

  test("backdrop closes the drawer", async ({ page }) => {
    await page.goto(BASE);
    await page.locator("#btnToggleSidebar").click();

    // Confirm drawer is open
    const openClass = await page
      .locator("#topicsSidebar")
      .evaluate((el) => el.classList.contains("sidebar-open"));
    expect(openClass).toBe(true);

    // Click backdrop to close
    await page.locator("#sidebarBackdrop").click({ force: true });

    const closedClass = await page
      .locator("#topicsSidebar")
      .evaluate((el) => el.classList.contains("sidebar-open"));
    expect(closedClass).toBe(false);
  });

  test("no page console errors at 360px", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto(BASE);
    await page.waitForTimeout(500);
    expect(errors, `Console errors: ${errors.join(", ")}`).toHaveLength(0);
  });
});
