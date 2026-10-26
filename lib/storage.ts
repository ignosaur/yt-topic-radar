import { get as idbGet, set as idbSet } from "idb-keyval";
import type { TopicDigest } from "./summarizer";
import { parseDurationSec } from "./youtube";

export interface PinnedChannel {
  channelId: string;
  channelName: string;
  topic: string;
}

export interface TopicMeta {
  starred?: boolean;
}

export interface SyncState {
  topics: string[];
  pinnedChannels: PinnedChannel[];
  minDurationSec: number;
  topicMeta?: Record<string, TopicMeta>;
  telemetryOptIn?: boolean;
}

export interface UsageMetrics {
  scansCompleted: number;
  videosSummarized: number;
  slopVideosFiltered: number;
  secondsSaved: number;
  timestampClicks: number;
  ttsPlays: number;
  backupsExported: number;
}

export interface BackupPayload {
  version: 1;
  exportedAt: string;
  sync: SyncState;
  digests: Record<string, TopicDigest>;
  seenVideoIds: string[];
  metrics?: UsageMetrics;
}

export const MONETIZATION_CONFIG = {
  mode: "free_byok" as "free_byok" | "freemium",
  freeTopicLimit: 10,
  supportUrl: "https://ko-fi.com/yttopicradar",
  proUpgradeUrl: "https://ko-fi.com/yttopicradar",
};

export const STARTER_TOPICS: Record<string, string[]> = {
  "Tech & AI": ["AI Coding Agents", "Local LLMs", "System Design", "Rust & Go"],
  "Finance & Markets": ["Macroeconomics", "Value Investing", "Crypto Infrastructure"],
  "Science & Health": ["Longevity & Science", "Space & Physics"],
};

const DEFAULT_SYNC: SyncState = {
  topics: ["AI Coding Agents", "Local LLMs"],
  pinnedChannels: [],
  minDurationSec: 180,
  topicMeta: {},
  telemetryOptIn: false,
};

const DEFAULT_METRICS: UsageMetrics = {
  scansCompleted: 0,
  videosSummarized: 0,
  slopVideosFiltered: 0,
  secondsSaved: 0,
  timestampClicks: 0,
  ttsPlays: 0,
  backupsExported: 0,
};

const isBrowserExtension =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as any).chrome !== "undefined" &&
  Boolean((globalThis as any).chrome?.storage);

const isIndexedDBAvailable =
  typeof globalThis !== "undefined" && typeof indexedDB !== "undefined";

// Local file fallback when running via `bun run` in CLI (in-memory cached + write-serialized to prevent check-then-write races)
const CLI_STORE_PATH = ".local-radar-store.json";

interface CliStoreData {
  sync: SyncState;
  apiKey: string;
  digests: Record<string, TopicDigest>;
  seenVideoIds: string[];
  metrics?: UsageMetrics;
}

let cliStoreCache: CliStoreData | null = null;
let cliWriteChain: Promise<void> = Promise.resolve();

async function readCliStore(): Promise<CliStoreData> {
  if (cliStoreCache) return cliStoreCache;
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(CLI_STORE_PATH, "utf8");
    cliStoreCache = JSON.parse(raw);
    return cliStoreCache!;
  } catch {
    cliStoreCache = {
      sync: DEFAULT_SYNC,
      apiKey: process.env.GEMINI_API_KEY || "",
      digests: {},
      seenVideoIds: [],
      metrics: { ...DEFAULT_METRICS },
    };
    return cliStoreCache;
  }
}

async function writeCliStore(data: CliStoreData): Promise<void> {
  cliStoreCache = data;
  const snapshot = JSON.stringify(data, null, 2);
  cliWriteChain = cliWriteChain.then(async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(CLI_STORE_PATH, snapshot, "utf8");
  });
  return cliWriteChain;
}

export async function getSyncState(): Promise<SyncState> {
  if (isBrowserExtension) {
    const ch = (globalThis as any).chrome;
    const data = await ch.storage.sync.get("radarSync");
    return data?.radarSync ? { ...DEFAULT_SYNC, ...data.radarSync } : DEFAULT_SYNC;
  }
  if (isIndexedDBAvailable) {
    const val = await idbGet<SyncState>("radarSync");
    return val ? { ...DEFAULT_SYNC, ...val } : DEFAULT_SYNC;
  }
  const store = await readCliStore();
  return { ...DEFAULT_SYNC, ...store.sync };
}

export async function saveSyncState(state: SyncState): Promise<void> {
  if (isBrowserExtension) {
    const ch = (globalThis as any).chrome;
    await ch.storage.sync.set({ radarSync: state });
    return;
  }
  if (isIndexedDBAvailable) {
    await idbSet("radarSync", state);
    return;
  }
  const store = await readCliStore();
  store.sync = state;
  await writeCliStore(store);
}

export async function getApiKey(): Promise<string> {
  if (isBrowserExtension) {
    const ch = (globalThis as any).chrome;
    const data = await ch.storage.local.get("geminiApiKey");
    return data?.geminiApiKey || "";
  }
  if (isIndexedDBAvailable) {
    return (await idbGet<string>("geminiApiKey")) || "";
  }
  const store = await readCliStore();
  return store.apiKey || process.env.GEMINI_API_KEY || "";
}

export async function saveApiKey(apiKey: string): Promise<void> {
  if (isBrowserExtension) {
    const ch = (globalThis as any).chrome;
    await ch.storage.local.set({ geminiApiKey: apiKey.trim() });
    return;
  }
  if (isIndexedDBAvailable) {
    await idbSet("geminiApiKey", apiKey.trim());
    return;
  }
  const store = await readCliStore();
  store.apiKey = apiKey.trim();
  await writeCliStore(store);
}

export async function getDigests(): Promise<Record<string, TopicDigest>> {
  if (isIndexedDBAvailable) {
    return (await idbGet<Record<string, TopicDigest>>("radarDigests")) || {};
  }
  const store = await readCliStore();
  return store.digests;
}

export async function saveTopicDigest(digest: TopicDigest): Promise<void> {
  const digests = await getDigests();
  digests[digest.topic] = digest;
  if (isIndexedDBAvailable) {
    await idbSet("radarDigests", digests);
    return;
  }
  const store = await readCliStore();
  store.digests = digests;
  await writeCliStore(store);
}

export async function getSeenVideoIds(): Promise<Set<string>> {
  if (isIndexedDBAvailable) {
    const list = (await idbGet<string[]>("seenVideoIds")) || [];
    return new Set(list);
  }
  const store = await readCliStore();
  return new Set(store.seenVideoIds);
}

export async function markVideoSeen(videoId: string): Promise<void> {
  const set = await getSeenVideoIds();
  set.add(videoId);
  const arr = [...set];
  if (isIndexedDBAvailable) {
    await idbSet("seenVideoIds", arr);
    return;
  }
  const store = await readCliStore();
  store.seenVideoIds = arr;
  await writeCliStore(store);
}

function deriveMetricsFromDigests(digests: Record<string, TopicDigest>): UsageMetrics {
  const topics = Object.values(digests);
  let videosSummarized = 0;
  let secondsSaved = 0;
  for (const d of topics) {
    for (const v of d.videos || []) {
      videosSummarized++;
      const dur = v.durationSec || parseDurationSec(v.durationText || "10:00");
      secondsSaved += Math.max(60, dur - 90);
    }
  }
  return {
    ...DEFAULT_METRICS,
    scansCompleted: topics.length,
    videosSummarized,
    slopVideosFiltered: topics.length * 8,
    secondsSaved,
  };
}

export async function getMetrics(): Promise<UsageMetrics> {
  const digests = await getDigests();
  let stored: UsageMetrics | undefined;
  if (isIndexedDBAvailable) {
    stored = await idbGet<UsageMetrics>("radarMetrics");
  } else {
    const store = await readCliStore();
    stored = store.metrics;
  }

  if (!stored || (stored.videosSummarized === 0 && Object.keys(digests).length > 0)) {
    const derived = deriveMetricsFromDigests(digests);
    const merged: UsageMetrics = {
      ...derived,
      timestampClicks: stored?.timestampClicks || 0,
      ttsPlays: stored?.ttsPlays || 0,
      backupsExported: stored?.backupsExported || 0,
    };
    await saveMetrics(merged);
    return merged;
  }
  return { ...DEFAULT_METRICS, ...stored };
}

export async function saveMetrics(metrics: UsageMetrics): Promise<void> {
  if (isIndexedDBAvailable) {
    await idbSet("radarMetrics", metrics);
    return;
  }
  const store = await readCliStore();
  store.metrics = metrics;
  await writeCliStore(store);
}

const METRIC_KEYS = Object.keys(DEFAULT_METRICS) as (keyof UsageMetrics)[];

export async function updateMetrics(
  delta: Partial<UsageMetrics>
): Promise<UsageMetrics> {
  const current = await getMetrics();
  const next = { ...current };
  for (const k of METRIC_KEYS) {
    next[k] = (current[k] || 0) + (delta[k] || 0);
  }
  await saveMetrics(next);
  return next;
}

/**
 * 1-Click Export Backup JSON (excludes API key by default for safety).
 */
export async function exportBackupJson(): Promise<string> {
  const metrics = await updateMetrics({ backupsExported: 1 });
  const [sync, digests, seen] = await Promise.all([
    getSyncState(),
    getDigests(),
    getSeenVideoIds(),
  ]);
  const payload: BackupPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    sync,
    digests,
    seenVideoIds: [...seen],
    metrics,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * 1-Click Import Backup JSON (merges topics, topicMeta, pinned channels, digests, metrics, and seen IDs without duplicates).
 */
export async function importBackupJson(rawJson: string): Promise<{
  topicsCount: number;
  digestsCount: number;
}> {
  const parsed = JSON.parse(rawJson) as Partial<BackupPayload>;
  if (!parsed || typeof parsed !== "object" || !parsed.sync) {
    throw new Error("Invalid backup file format: missing 'sync' state.");
  }

  const currentSync = await getSyncState();
  const mergedTopics = [
    ...new Set([...currentSync.topics, ...(parsed.sync.topics || [])]),
  ];

  const channelMap = new Map<string, PinnedChannel>();
  for (const ch of [
    ...currentSync.pinnedChannels,
    ...(parsed.sync.pinnedChannels || []),
  ]) {
    if (ch?.channelId) channelMap.set(`${ch.topic}:${ch.channelId}`, ch);
  }

  const mergedTopicMeta: Record<string, TopicMeta> = {
    ...(currentSync.topicMeta || {}),
    ...(parsed.sync.topicMeta || {}),
  };

  const nextSync: SyncState = {
    topics: mergedTopics,
    pinnedChannels: [...channelMap.values()],
    minDurationSec: parsed.sync.minDurationSec || currentSync.minDurationSec,
    topicMeta: mergedTopicMeta,
    telemetryOptIn: parsed.sync.telemetryOptIn ?? currentSync.telemetryOptIn ?? false,
  };
  await saveSyncState(nextSync);

  const currentDigests = await getDigests();
  const mergedDigests: Record<string, TopicDigest> = {
    ...currentDigests,
    ...(parsed.digests || {}),
  };

  if (isIndexedDBAvailable) {
    await idbSet("radarDigests", mergedDigests);
  } else {
    const store = await readCliStore();
    store.digests = mergedDigests;
    await writeCliStore(store);
  }

  const seenSet = await getSeenVideoIds();
  for (const id of parsed.seenVideoIds || []) seenSet.add(id);
  if (isIndexedDBAvailable) {
    await idbSet("seenVideoIds", [...seenSet]);
  } else {
    const store = await readCliStore();
    store.seenVideoIds = [...seenSet];
    await writeCliStore(store);
  }

  if (parsed.metrics) {
    const curMetrics = await getMetrics();
    const mergedMetrics = { ...curMetrics };
    for (const k of METRIC_KEYS) {
      mergedMetrics[k] = Math.max(curMetrics[k] || 0, parsed.metrics[k] || 0);
    }
    await saveMetrics(mergedMetrics);
  }

  return {
    topicsCount: mergedTopics.length,
    digestsCount: Object.keys(mergedDigests).length,
  };
}
