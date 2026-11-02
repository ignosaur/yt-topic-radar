import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Subprocess per backend: storage picks extension/IndexedDB/CLI-file at import time.
for (const mode of ["cli", "extension", "indexeddb"]) {
  test(`api key save/replace/forget/mask: ${mode} storage`, async () => {
    const proc = Bun.spawn(["bun", "tests/helpers/api-key-worker.ts", mode], {
      cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, RADAR_STORE_PATH: join(mkdtempSync(join(tmpdir(), "radar-key-")), "store.json") },
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, `${out}\n${err}`).toBe(0);
    expect(out.trim().split("\n").at(-1)).toBe("ok");
  }, 10000);
}

test("Forget UI: hidden without key, button wired to confirm + /api/key/clear", async () => {
  const html = await Bun.file(`${import.meta.dir}/../ui/digest.html`).text();
  const ext = await Bun.file(`${import.meta.dir}/../extension/digest.html`).text();
  expect(ext).toBe(html);
  for (const id of ["btnSaveKey", "btnForgetKey", "apiKeyInput"]) expect(html).toContain(`id="${id}"`);
  expect(html).toMatch(/id="btnForgetKey" class="hidden /);
  const js = await Bun.file(`${import.meta.dir}/../ui/digest.js`).text();
  expect(js).toContain('classList.toggle("hidden", !state.hasApiKey)');
  expect(js).toContain('"/api/key/clear"');
  expect(js).toContain("confirm(");
});
