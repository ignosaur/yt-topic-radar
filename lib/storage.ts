import { get as idbGet, set as idbSet } from "idb-keyval";
import type { TopicDigest } from "./summarizer";

export interface PinnedChannel {
  channelId: string;
  channelName: string;
  topic: string;
}

export interface SyncState {
  topics: string[];
  pinnedChannels: PinnedChannel[];
  minDurationSec: number;
}

export interface BackupPayload {
  version: 1;
  exportedAt: string;
  sync: SyncState;
  digests: Record<string, TopicDigest>;
  seenVideoIds: string[];
}

export const STARTER_TOPICS: Record<string, string[]> = {
  "Tech & AI": ["AI Coding Agents", "Local LLMs", "System Design", "Rust & Go"],
  "Finance & Markets": ["Macroeconomics", "Value Investing", "Crypto Infrastructure"],
  "Science & Health": ["Longevity & Science", "Space & Physics"],
};

const DEFAULT_SYNC: SyncState = {
  topics: ["AI Coding Agents", "Local LLMs"],
  pinnedChannels: [],
  minDurationSec: 180,
};

const isBrowserExtension =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as any).chrome !== "undefined" &&
  Boolean((globalThis as any).chrome?.storage);

const isIndexedDBAvailable =
  typeof globalThis !== "undefined" && typeof indexedDB !== "undefined";

// Local file fallback when running via `bun run` in CLI
const CLI_STORE_PATH = ".local-radar-store.json";

async function readCliStore(): Promise<{
  sync: SyncState;
  apiKey: string;
  digests: Record<string, TopicDigest>;
  seenVideoIds: string[];
}> {
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(CLI_STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      sync: DEFAULT_SYNC,
      apiKey: process.env.GEMINI_API_KEY || "",
      digests: {},
      seenVideoIds: [],
    };
  }
}

async function writeCliStore(data: {
  sync: SyncState;
  apiKey: string;
  digests: Record<string, TopicDigest>;
  seenVideoIds: string[];
}): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(CLI_STORE_PATH, JSON.stringify(data, null, 2), "utf8");
}

export async function getSyncState(): Promise<SyncState> {
  if (isBrowserExtension) {
    const ch = (globalThis as any).chrome;
    const data = await ch.storage.sync.get("radarSync");
    return data?.radarSync ? { ...DEFAULT_SYNC, ...data.radarSync } : DEFAULT_SYNC;
  }
  if (isIndexedDBAvailable) {
    return (await idbGet<SyncState>("radarSync")) || DEFAULT_SYNC;
  }
  const store = await readCliStore();
  return store.sync;
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

/**
 * 1-Click Export Backup JSON (excludes API key by default for safety).
 */
export async function exportBackupJson(): Promise<string> {
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
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * 1-Click Import Backup JSON (merges topics, pinned channels, digests, and seen IDs without duplicates).
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

  const nextSync: SyncState = {
    topics: mergedTopics,
    pinnedChannels: [...channelMap.values()],
    minDurationSec: parsed.sync.minDurationSec || currentSync.minDurationSec,
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

  return {
    topicsCount: mergedTopics.length,
    digestsCount: Object.keys(mergedDigests).length,
  };
}
