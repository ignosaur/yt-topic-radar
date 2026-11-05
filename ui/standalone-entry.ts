import "./fetch-bind";

import { runStandaloneScan } from "../lib/engine";
import {
  MONETIZATION_CONFIG,
  STARTER_TOPICS,
  clearApiKey,
  maskApiKey,
  getApiKey,
  getDigests,
  getMetrics,
  getSyncState,
  saveApiKey,
  saveSyncState,
  StaleSyncError,
  validateSyncValue,
  StoreLockedError,
  updateMetrics,
  type SyncState,
} from "../lib/storage";

declare const __RADAR_PRO_ENABLED__: boolean;

const PRO_ENABLED = __RADAR_PRO_ENABLED__;

async function json(data: unknown, status = 200): Promise<Response> {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readBodyText(init?: RequestInit): Promise<string> {
  const body = init?.body as unknown;
  if (typeof body === "string") return body;
  if (body == null) return "";
  return new Response(body as BodyInit).text();
}

/** Parse a JSON route body; rejects unparseable input and non-plain-
 * objects (null, arrays, scalars) before any storage write or scan start. */
async function readJsonObject(init?: RequestInit): Promise<{ ok: true; body: any } | { ok: false }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBodyText(init)) || "{}");
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false };
  }
  return { ok: true, body: parsed };
}

async function buildState() {
  const [sync, digests, apiKey, metrics] = await Promise.all([
    getSyncState(),
    getDigests(),
    getApiKey(),
    getMetrics(),
  ]);
  return {
    sync,
    digests,
    metrics,
    entitlements: { isPro: false },
    monetization: { ...MONETIZATION_CONFIG, proEnabled: PRO_ENABLED },
    starterTopics: STARTER_TOPICS,
    hasApiKey: Boolean(apiKey),
    maskedKey: maskApiKey(apiKey),
  };
}

async function handleApi(input: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method || "GET").toUpperCase();
  const path = input.split("?")[0];

  if (path === "/api/state" && method === "GET") {
    return json(await buildState());
  }

  if (path === "/api/sync" && method === "POST") {
    const parsed = await readJsonObject(init);
    if (!parsed.ok) return json({ error: "invalid_json" }, 400);
    const body = parsed.body as Record<string, unknown>;
    const current = await getSyncState();
    const next: SyncState = {
      topics: Array.isArray(body.topics) ? (body.topics as string[]) : current.topics,
      pinnedChannels: Array.isArray(body.pinnedChannels)
        ? (body.pinnedChannels as SyncState["pinnedChannels"])
        : current.pinnedChannels,
      minDurationSec:
        typeof body.minDurationSec === "number"
          ? body.minDurationSec
          : current.minDurationSec,
      topicMeta:
        body.topicMeta && typeof body.topicMeta === "object"
          ? (body.topicMeta as SyncState["topicMeta"])
          : current.topicMeta || {},
      telemetryOptIn:
        typeof body.telemetryOptIn === "boolean"
          ? body.telemetryOptIn
          : current.telemetryOptIn ?? false,
    };
    // Pro flag off: no topic cap. Shape-checked with the shared validator.
    try {
      validateSyncValue(next);
    } catch (err) {
      return json({ error: String((err as any)?.message || err) }, 400);
    }
    try {
      const sync = await saveSyncState(next, typeof body.revision === "number" ? body.revision : undefined);
      return json({ ok: true, sync });
    } catch (err) {
      if (err instanceof StaleSyncError) return json({ error: "stale_state" }, 409);
      if (err instanceof StoreLockedError) return json({ error: String(err.message) }, 409);
      throw err;
    }
  }

  if (path === "/api/key" && method === "POST") {
    const parsed = await readJsonObject(init);
    if (!parsed.ok) return json({ error: "invalid_json" }, 400);
    const body = parsed.body as { apiKey?: string };
    if (typeof body.apiKey !== "string" || !body.apiKey.trim() || body.apiKey.trim().length > 512) return json({ error: "API key required" }, 400);
    await saveApiKey(body.apiKey);
    return json({ ok: true });
  }

  if (path === "/api/key/clear" && method === "POST") {
    const parsed = await readJsonObject(init);
    if (!parsed.ok) return json({ error: "invalid_json" }, 400);
    await clearApiKey();
    return json({ ok: true });
  }

  if (path === "/api/metrics" && method === "POST") {
    const parsed = await readJsonObject(init);
    if (!parsed.ok) return json({ error: "invalid_json" }, 400);
    const body = parsed.body as { event?: string };
    let metrics = await getMetrics();
    if (body.event === "timestampClick") {
      metrics = await updateMetrics({ timestampClicks: 1 });
    } else if (body.event === "ttsPlay") {
      metrics = await updateMetrics({ ttsPlays: 1 });
    }
    return json({ ok: true, metrics });
  }

  if (path === "/api/scan" && method === "POST") {
    const parsed = await readJsonObject(init);
    if (!parsed.ok) return json({ error: "invalid_json" }, 400);
    const body = parsed.body as {
      topic?: string;
      maxVideos?: number;
    };
    const topic = (body.topic || "").trim();
    if (!topic) return json({ error: "Topic is required" }, 400);
    const apiKey = await getApiKey();
    if (!apiKey) {
      return json({ error: "Please set your Gemini API Key in Settings first." }, 400);
    }
    const result = await runStandaloneScan(
      topic,
      Number(body.maxVideos || 3),
      apiKey
    );
    return json(result.body, result.status);
  }

  if (path === "/api/entitlements" && method === "POST") {
    // Pro flag off: no-op so the shared UI never errors.
    return json({ ok: true, entitlements: { isPro: false } });
  }

  if (path === "/api/transcript" && method === "GET") {
    // Pro plan feature (see proFeatures in storage.ts). Standalone v1 has no
    // Pro entitlements (buildState hardcodes isPro:false), so it stays locked
    // here too — mirrors the server route's 403 instead of giving it away.
    return json({ error: "upgrade_required" }, 403);
  }

  // Backup export/import is a Pro plan feature (see proFeatures in
  // storage.ts). Standalone v1 has no Pro entitlements, so it stays locked
  // here too — mirrors the server routes' 403 instead of giving it away.
  if (path === "/api/backup/export" && method === "GET") {
    return json({ error: "upgrade_required" }, 403);
  }

  if (path === "/api/backup/import" && method === "POST") {
    return json({ error: "upgrade_required" }, 403);
  }

  return new Response("Not Found", { status: 404 });
}

(window as unknown as { __RADAR_STANDALONE__?: typeof handleApi }).__RADAR_STANDALONE__ =
  handleApi;

await import("./digest.js");
