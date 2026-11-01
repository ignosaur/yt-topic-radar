import { defineConfig } from "@playwright/test";

// Item 6: Playwright specs live in tests/e2e as *.pw.ts so bare `bun test`
// never discovers them. Run explicitly, e.g.:
//   PORT=3459 bun run server.ts &
//   bunx playwright test tests/e2e/dashboard-xss.pw.ts
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.pw.ts",
});
