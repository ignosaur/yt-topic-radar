// Exercises save/get/mask/forget against one storage backend per process
// (backend is chosen at module load). Prints "ok" on success.
import { strict as assert } from "node:assert";

const mode = process.argv[2];
delete process.env.GEMINI_API_KEY;
const area = new Map<string, unknown>();
if (mode === "extension") {
  (globalThis as any).chrome = { storage: { local: {
    get: async (k: string) => ({ [k]: area.get(k) }),
    set: async (o: Record<string, unknown>) => { for (const [k, v] of Object.entries(o)) area.set(k, v); },
    remove: async (k: string) => { area.delete(k); },
  } } };
} else if (mode === "indexeddb") {
  (globalThis as any).indexedDB = {};
  const { mock } = await import("bun:test");
  mock.module("idb-keyval", () => ({
    get: async (k: string) => area.get(k),
    set: async (k: string, v: unknown) => { area.set(k, v); },
    del: async (k: string) => { area.delete(k); },
  }));
}
const { getApiKey, saveApiKey, clearApiKey, maskApiKey } = await import("../../lib/storage");

assert.equal(await getApiKey(), "");
await saveApiKey("  AIzaSyLongEnoughKey1234  ");
assert.equal(await getApiKey(), "AIzaSyLongEnoughKey1234");
await saveApiKey("AIzaSyReplacement5678");
assert.equal(await getApiKey(), "AIzaSyReplacement5678");
await clearApiKey();
assert.equal(await getApiKey(), "");
await clearApiKey(); // forgetting twice is harmless
assert.equal(await getApiKey(), "");
await saveApiKey("again-after-forget-1");
assert.equal(await getApiKey(), "again-after-forget-1");

assert.equal(maskApiKey(""), "");
assert.equal(maskApiKey("short"), "••••");
assert.equal(maskApiKey("AIzaSyLongEnoughKey1234"), "AIzaSy...1234");
console.log("ok");
