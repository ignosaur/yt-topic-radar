import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
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
  revision?: number;
  topicGenerations?: Record<string, string>;
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
  mode: "freemium" as "free_byok" | "freemium",
  freeTopicLimit: 5,
  supportUrl: "https://rzp.io/rzp/ypHoq1R",
  proUpgradeUrl: "https://rzp.io/rzp/ypHoq1R",
};

export const STARTER_TOPICS: Record<string, string[]> = {
  "Tech & AI": ["AI Coding Agents", "Local LLMs", "System Design", "Rust & Go"],
  "Finance & Markets": ["Macroeconomics", "Value Investing", "Crypto Infrastructure"],
  "Science & Health": ["Longevity & Science", "Space & Physics"],
};

const DEFAULT_SYNC: SyncState = {
  revision: 0,
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
const CLI_STORE_PATH = process.env.RADAR_STORE_PATH || ".local-radar-store.json";

export interface Entitlements {
  isPro: boolean;
}

export class BackupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupValidationError";
  }
}

export class StoreLockedError extends Error {
  constructor(owner?: string) {
    super(`store_locked: store is in use by another process${owner ? ` (pid ${owner})` : ""}`);
    this.name = "StoreLockedError";
  }
}

export class CorruptStoreError extends Error {
  constructor(path: string) {
    super(`store_corrupt: ${path} contains invalid JSON and was left unchanged`);
    this.name = "CorruptStoreError";
  }
}

interface CliStoreData {
  sync: SyncState;
  apiKey: string;
  digests: Record<string, TopicDigest>;
  seenVideoIds: string[];
  metrics?: UsageMetrics;
  entitlements?: Entitlements;
}

let cliStoreCache: CliStoreData | null = null;
let cliWriteChain: Promise<void> = Promise.resolve();
let cliStoreLockHeld = false;
let cliStoreLockReleaseInstalled = false;
// Sync fs stashed at claim time: 'exit' handlers cannot await, so the release
// below must be synchronous. Type-only import — no runtime/bundle impact.
let cliLockSyncFs: Pick<typeof import("node:fs"), "readFileSync" | "unlinkSync"> | null = null;

function installCliStoreLockRelease(): void {
  if (cliStoreLockReleaseInstalled) return;
  if (typeof process === "undefined" || typeof process.once !== "function") return;
  cliStoreLockReleaseInstalled = true;
  // Best-effort: only removes our own lock (pid check); anything left behind
  // is still reclaimed via the dead-pid check on the next claim.
  process.once("exit", () => {
    cliStoreLockHeld = false;
    try {
      const fs = cliLockSyncFs;
      if (!fs) return;
      const lockPath = `${CLI_STORE_PATH}.lock`;
      if (fs.readFileSync(lockPath, "utf8").trim() !== String(process.pid)) return;
      fs.unlinkSync(lockPath);
    } catch { /* best-effort; reclaim covers leftovers */ }
  });
}

// One process owns a CLI store at a time: an exclusive `${CLI_STORE_PATH}.lock`
// file (owner pid inside) fails fast in a second writer instead of letting its
// stale snapshot clobber the first process. A lock whose pid is dead is
// reclaimed; browser builds never reach here (early return, no node:fs load).
async function ensureCliStoreLock(): Promise<void> {
  if (cliStoreLockHeld) return;
  if (typeof process === "undefined" || typeof process.pid !== "number") return;
  const fs = await import("node:fs/promises");
  const lockPath = `${CLI_STORE_PATH}.lock`;
  const mine = String(process.pid);
  const claim = () => fs.writeFile(lockPath, mine, { flag: "wx", mode: 0o600 });
  try {
    await claim();
    cliStoreLockHeld = true;
    try {
      const syncFs = await import("node:fs");
      cliLockSyncFs = syncFs;
    } catch { /* sync release unavailable; reclaim still covers crashes */ }
    installCliStoreLockRelease();
    return;
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err;
  }
  const owner = await fs.readFile(lockPath, "utf8").catch(() => "");
  const pid = Number(owner.trim());
  let alive = true;
  if (!Number.isFinite(pid) || pid <= 0) alive = false;
  else {
    try {
      process.kill(pid, 0);
    } catch (sig: any) {
      alive = sig?.code !== "ESRCH"; // EPERM etc. means a live pid we cannot signal
    }
  }
  if (!alive) {
    // Stale lock from a dead process: reclaim so one crash never wedges writers.
    await fs.unlink(lockPath).catch(() => {});
    try {
      await claim();
      cliStoreLockHeld = true;
      try {
        const syncFs = await import("node:fs");
        cliLockSyncFs = syncFs;
      } catch { /* sync release unavailable; reclaim still covers crashes */ }
      installCliStoreLockRelease();
      return;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  throw new StoreLockedError(owner.trim() || undefined);
}

async function readCliStore(): Promise<CliStoreData> {
  if (cliStoreCache) return cliStoreCache;
  const fs = await import("node:fs/promises");
  let raw: string;
  try {
    raw = await fs.readFile(CLI_STORE_PATH, "utf8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    cliStoreCache = {
      sync: DEFAULT_SYNC,
      apiKey: process.env.GEMINI_API_KEY || "",
      digests: {},
      seenVideoIds: [],
      metrics: { ...DEFAULT_METRICS },
    };
    return cliStoreCache;
  }
  try {
    cliStoreCache = JSON.parse(raw);
  } catch {
    cliStoreCache = null; // never cache corrupt data; the file stays untouched below
    throw new CorruptStoreError(CLI_STORE_PATH);
  }
  // Tighten a pre-existing store (e.g. 0664 from before item 4); best-effort.
  await fs.chmod(CLI_STORE_PATH, 0o600).catch(() => {});
  return cliStoreCache!;
}

async function writeCliStore(data: CliStoreData): Promise<void> {
  cliStoreCache = data;
  const snapshot = JSON.stringify(data, null, 2);
  // A rejected save must not poison later saves (same house pattern as withTopicWrite).
  cliWriteChain = cliWriteChain.catch(() => {}).then(async () => {
    await ensureCliStoreLock();
    const fs = await import("node:fs/promises");
    // Temp file + rename: a crash mid-write never leaves a half-written store.
    const tmpPath = `${CLI_STORE_PATH}.tmp`;
    await fs.writeFile(tmpPath, snapshot, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(tmpPath, 0o600).catch(() => {});
    await fs.rename(tmpPath, CLI_STORE_PATH);
    await fs.chmod(CLI_STORE_PATH, 0o600).catch(() => {});
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

// Serialize read/check/write across requests and extension pages.
let topicWriteChain: Promise<unknown> = Promise.resolve();
function withTopicWrite<T>(write: () => Promise<T>): Promise<T> {
  const locks = (globalThis as any).navigator?.locks;
  if (isIndexedDBAvailable && locks) return locks.request("radar-topic-write", write);
  const next = topicWriteChain.then(write);
  topicWriteChain = next.catch(() => {}); // A rejected save must not poison later saves.
  return next;
}

export class StaleSyncError extends Error {
  constructor() { super("stale_state"); }
}

// Called under withTopicWrite so rollback cannot overwrite another topic write.
async function saveBrowserTopicState(
  next: SyncState,
  digests: Record<string, TopicDigest>,
  previousDigests: Record<string, TopicDigest>
): Promise<void> {
  await idbSet("radarDigests", digests);
  try {
    if (isBrowserExtension) await (globalThis as any).chrome.storage.sync.set({ radarSync: next });
    else await idbSet("radarSync", next);
  } catch (saveError) {
    // Both writes are under the topic lock; preserve content on a failed sync commit.
    try {
      await idbSet("radarDigests", previousDigests);
    } catch (restoreError) {
      throw new AggregateError([saveError, restoreError], "Failed to save topics and restore digests");
    }
    throw saveError;
  }
}

export async function saveSyncState(state: SyncState, expectedRevision?: number): Promise<SyncState> {
  return withTopicWrite(async () => {
    const current = await getSyncState();
    if (expectedRevision !== undefined && expectedRevision !== (current.revision || 0)) {
      throw new StaleSyncError();
    }
    const removed = new Set(current.topics.filter(topic => !state.topics.includes(topic)));
    const topicMeta = { ...(state.topicMeta || {}) };
    for (const topic of removed) delete topicMeta[topic];
    const next: SyncState = {
      ...state,
      revision: (current.revision || 0) + 1,
      topicGenerations: Object.fromEntries(state.topics.map(topic => [topic,
        current.topics.includes(topic) ? current.topicGenerations?.[topic] || "legacy" : crypto.randomUUID(),
      ])),
      topicMeta,
      pinnedChannels: state.pinnedChannels.filter(channel => !removed.has(channel.topic)),
    };
    const previousDigests = await getDigests();
    const digests = { ...previousDigests };
    for (const topic of removed) delete digests[topic];
    if (isIndexedDBAvailable) {
      await saveBrowserTopicState(next, digests, previousDigests);
    } else {
      const store = await readCliStore();
      store.sync = next;
      store.digests = digests;
      await writeCliStore(store);
    }
    return next;
  });
}

export async function getTopicGeneration(topic: string): Promise<string | null> {
  const sync = await getSyncState();
  return sync.topics.includes(topic) ? sync.topicGenerations?.[topic] || "legacy" : null;
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

export async function clearApiKey(): Promise<void> {
  if (isBrowserExtension) {
    const ch = (globalThis as any).chrome;
    await ch.storage.local.remove("geminiApiKey");
    return;
  }
  if (isIndexedDBAvailable) {
    await idbDel("geminiApiKey");
    return;
  }
  // shortcut: a GEMINI_API_KEY env fallback (operator-configured) still wins in getApiKey.
  const store = await readCliStore();
  store.apiKey = "";
  await writeCliStore(store);
}

/** Mask for UI display; short keys would be fully revealed by prefix/suffix slicing. */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  if (apiKey.length <= 10) return "••••";
  return `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`;
}

export async function getEntitlements(): Promise<Entitlements> {
  const store = await readCliStore();
  return { isPro: Boolean(store.entitlements?.isPro) };
}

export async function setEntitlements(entitlements: Entitlements): Promise<Entitlements> {
  const store = await readCliStore();
  store.entitlements = { isPro: Boolean(entitlements.isPro) };
  await writeCliStore(store);
  return store.entitlements;
}

export async function getDigests(): Promise<Record<string, TopicDigest>> {
  if (isIndexedDBAvailable) {
    return (await idbGet<Record<string, TopicDigest>>("radarDigests")) || {};
  }
  const store = await readCliStore();
  return store.digests;
}

export async function saveTopicDigest(digest: TopicDigest, generation?: string | null): Promise<boolean> {
  return withTopicWrite(async () => {
    if (generation !== undefined && (generation === null || generation !== await getTopicGeneration(digest.topic))) {
      return false;
    }
    const digests = { ...await getDigests(), [digest.topic]: digest };
    if (isIndexedDBAvailable) await idbSet("radarDigests", digests);
    else {
      const store = await readCliStore();
      store.digests = digests;
      await writeCliStore(store);
    }
    return true;
  });
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
    slopVideosFiltered: 0,
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
  return withTopicWrite(async () => {
    const current = await getMetrics();
    const next = { ...current };
    for (const k of METRIC_KEYS) {
      next[k] = (current[k] || 0) + (delta[k] || 0);
    }
    await saveMetrics(next);
    return next;
  });
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

const BACKUP_MAX_BYTES = 10 * 1024 * 1024;
const MAX_TOPIC_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new BackupValidationError(message);
}

// Single shared sync-shape check: backup import, server /api/sync and the
// standalone /api/sync route all call this so validation cannot drift.
export function validateSyncValue(sync: unknown): asserts sync is SyncState {
  if (!isRecord(sync)) invalid("sync must be an object");
  if (!Array.isArray(sync.topics)) invalid("sync.topics must be an array");
  for (const topic of sync.topics) {
    if (typeof topic !== "string" || topic.length === 0 || topic.length > MAX_TOPIC_LENGTH) {
      invalid("sync.topics must be non-empty strings (max 200 chars)");
    }
  }
  if (sync.pinnedChannels !== undefined) {
    if (!Array.isArray(sync.pinnedChannels)) invalid("pinnedChannels must be an array");
    for (const ch of sync.pinnedChannels as unknown[]) {
      if (!isRecord(ch) || typeof ch.channelId !== "string" || typeof ch.channelName !== "string" || typeof ch.topic !== "string") {
        invalid("pinnedChannels[] must have string channelId/channelName/topic");
      }
    }
  }
  if (sync.topicMeta !== undefined) {
    if (!isRecord(sync.topicMeta)) invalid("topicMeta must be an object");
    for (const meta of Object.values(sync.topicMeta)) {
      if (!isRecord(meta) || (meta.starred !== undefined && typeof meta.starred !== "boolean")) {
        invalid("topicMeta values must be objects with optional boolean starred");
      }
    }
  }
  if (sync.minDurationSec !== undefined && (typeof sync.minDurationSec !== "number" || !Number.isFinite(sync.minDurationSec) || sync.minDurationSec < 0)) {
    invalid("minDurationSec must be a finite number >= 0");
  }
  if (sync.telemetryOptIn !== undefined && typeof sync.telemetryOptIn !== "boolean") {
    invalid("telemetryOptIn must be a boolean");
  }
}

function validateDigestRecord(digests: unknown): void {
  if (!isRecord(digests)) invalid("digests must be an object");
  for (const digest of Object.values(digests)) {
    if (!isRecord(digest) || typeof digest.topic !== "string" || typeof digest.generatedAt !== "string" || !Array.isArray(digest.videos)) {
      invalid("digests[] must have string topic/generatedAt and a videos[] array");
    }
    for (const video of digest.videos as unknown[]) {
      if (!isRecord(video) || typeof video.videoId !== "string" || typeof video.title !== "string" || typeof video.channelName !== "string" || typeof video.url !== "string") {
        invalid("digests[].videos[] must have string videoId/title/channelName/url");
      }
      if (video.chapterBreakdown !== undefined) {
        if (!Array.isArray(video.chapterBreakdown)) invalid("chapterBreakdown must be an array");
        for (const ch of video.chapterBreakdown as unknown[]) {
          if (!isRecord(ch) || typeof ch.timestamp !== "string" || typeof ch.sectionTitle !== "string" || !Array.isArray(ch.keyPoints) || !(ch.keyPoints as unknown[]).every((k) => typeof k === "string")) {
            invalid("chapterBreakdown[] must have string timestamp/sectionTitle and string[] keyPoints");
          }
        }
      }
      if (video.typeSpecificDetails !== undefined) {
        if (!Array.isArray(video.typeSpecificDetails)) invalid("typeSpecificDetails must be an array");
        for (const d of video.typeSpecificDetails as unknown[]) {
          if (!isRecord(d) || typeof d.label !== "string" || !Array.isArray(d.items) || !(d.items as unknown[]).every((i) => typeof i === "string")) {
            invalid("typeSpecificDetails[] must have string label and string[] items");
          }
        }
      }
    }
  }
}

// UTF-8 byte length without a node: import (bundle-safe): Buffer when
// present, else a TextEncoder pass, else string length as last resort.
function backupByteLength(rawJson: string): number {
  const buf = (globalThis as any).Buffer;
  if (buf?.byteLength) {
    try {
      return buf.byteLength(rawJson, "utf8");
    } catch { /* fall through */ }
  }
  try {
    return new TextEncoder().encode(rawJson).length;
  } catch {
    return rawJson.length;
  }
}

// Parses and fully validates a backup BEFORE any write happens, so a rejected
// backup leaves the store (and revision) untouched.
export function parseAndValidateBackup(rawJson: string): BackupPayload {
  if (typeof rawJson !== "string") invalid("backup must be a JSON string");
  if (backupByteLength(rawJson) > BACKUP_MAX_BYTES) invalid("backup_too_large: backup exceeds 10 MiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    invalid("backup is not valid JSON");
  }
  if (!isRecord(parsed)) invalid("Invalid backup file format: missing 'sync' state.");
  const root: Record<string, unknown> = parsed;
  if (!isRecord(root.sync)) invalid("Invalid backup file format: missing 'sync' state.");
  validateSyncValue(root.sync);
  if (root.digests !== undefined) validateDigestRecord(root.digests);
  if (root.seenVideoIds !== undefined) {
    if (!Array.isArray(root.seenVideoIds) || !(root.seenVideoIds as unknown[]).every((id) => typeof id === "string")) {
      invalid("seenVideoIds must be a string array");
    }
  }
  if (root.metrics !== undefined) {
    if (!isRecord(root.metrics) || !Object.values(root.metrics).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
      invalid("metrics must be finite numbers >= 0");
    }
  }
  return root as unknown as BackupPayload;
}

/**
 * 1-Click Import Backup JSON (merges topics, topicMeta, pinned channels, digests, metrics, and seen IDs without duplicates).
 */
export async function importBackupJson(
  rawJson: string,
  opts: { enforceTopicLimit?: boolean } = {}
): Promise<{
  topicsCount: number;
  digestsCount: number;
}> {
  // Fully validated up front: nothing below has written yet, so a throw
  // leaves the store byte-identical with no revision bump.
  const parsed = parseAndValidateBackup(rawJson);

  const currentSync = await getSyncState();
  const allTopics = [
    ...new Set([...currentSync.topics, ...(parsed.sync.topics || [])]),
  ];
  const isPro =
    opts.enforceTopicLimit === false ? true : (await getEntitlements()).isPro;
  const topicLimit = isPro
    ? allTopics.length
    : Math.max(currentSync.topics.length, MONETIZATION_CONFIG.freeTopicLimit);
  const mergedTopics = allTopics.slice(0, topicLimit);
  const keptTopics = new Set(mergedTopics);

  const channelMap = new Map<string, PinnedChannel>();
  for (const ch of [
    ...currentSync.pinnedChannels,
    ...(parsed.sync.pinnedChannels || []),
  ]) {
    if (ch?.channelId && keptTopics.has(ch.topic)) channelMap.set(`${ch.topic}:${ch.channelId}`, ch);
  }

  const mergedTopicMeta: Record<string, TopicMeta> = {};
  for (const [topic, meta] of Object.entries({
    ...(currentSync.topicMeta || {}),
    ...(parsed.sync.topicMeta || {}),
  })) {
    if (keptTopics.has(topic)) mergedTopicMeta[topic] = meta;
  }

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
