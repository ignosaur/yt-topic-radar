#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const DIST_DIR = join(ROOT, "dist");

const EXPECTED_PERMISSIONS_CHROME = [
  "storage",
  "sidePanel",
  "tabs",
  "declarativeNetRequestWithHostAccess",
];

const EXPECTED_PERMISSIONS_FIREFOX = [
  "storage",
  "tabs",
  "declarativeNetRequestWithHostAccess",
];

const EXPECTED_HOSTS = [
  "https://www.youtube.com/*",
  "https://generativelanguage.googleapis.com/*",
  "https://eu.i.posthog.com/*",
];

const REQUIRED_ENTRIES = [
  "manifest.json",
  "background.js",
  "digest.js",
  "digest.html",
  "digest.css",
  "favicon.ico",
  "rules.json",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

type Check = { name: string; ok: boolean; detail: string };

const results: Check[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
}

function fatal(message: string): never {
  console.error(`FAIL locate: ${message}`);
  process.exit(1);
}

function readPackageVersion(): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(PKG_PATH, "utf8"));
  } catch (error) {
    fatal(`cannot read ${PKG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const version =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).version
      : undefined;
  if (typeof version !== "string" || version.length === 0) {
    fatal(`package.json has no string "version"`);
  }
  return version;
}

function findNewestZip(): string | undefined {
  let names: string[];
  try {
    names = readdirSync(DIST_DIR);
  } catch {
    return undefined;
  }
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const name of names) {
    if (!/^yt-topic-radar(?:-firefox)?-v.+\.zip$/.test(name)) continue;
    const path = join(DIST_DIR, name);
    try {
      const stat = statSync(path);
      if (stat.isFile()) candidates.push({ path, mtime: stat.mtimeMs });
    } catch {
      // Ignore unreadable candidates.
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path;
}

const packageVersion = readPackageVersion();

const rawArgs = process.argv.slice(2);
const explicitTarget = rawArgs.find((arg) => arg === "chrome" || arg === "firefox");
const zipArg = rawArgs.find((arg) => arg !== "chrome" && arg !== "firefox");
let zipPath: string;
if (zipArg) {
  zipPath = resolve(zipArg);
  if (!existsSync(zipPath)) fatal(`zip not found: ${zipPath}`);
  if (!statSync(zipPath).isFile()) fatal(`not a file: ${zipPath}`);
} else {
  const newest = findNewestZip();
  if (!newest) {
    fatal(`no dist/yt-topic-radar-v*.zip found; run \`bun run package:chrome\` or \`bun run package:firefox\` first`);
  }
  zipPath = newest;
}

type SpawnResult = { code: number; stdout: string; stderr: string };

function runUnzip(args: string[]): SpawnResult {
  try {
    const proc = Bun.spawnSync({
      cmd: ["unzip", ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
    const decoder = new TextDecoder();
    return {
      code: proc.exitCode ?? -1,
      stdout: proc.stdout ? decoder.decode(proc.stdout) : "",
      stderr: proc.stderr ? decoder.decode(proc.stderr) : "",
    };
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeEntry(name: string): string {
  return name.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
}

function readEntry(rawName: string): string | undefined {
  const result = runUnzip(["-p", zipPath, rawName]);
  return result.code === 0 ? result.stdout : undefined;
}

const listing = runUnzip(["-l", zipPath]);
if (listing.code !== 0) {
  fatal(`unzip -l failed for ${zipPath}: ${listing.stderr.trim() || "unknown error"}`);
}

const rawByNormalized = new Map<string, string>();
for (const line of listing.stdout.split(/\r?\n/)) {
  const match = line.match(/^\s*\d+\s+\S+\s+\S+\s{2,}(.+?)\s*$/);
  if (!match?.[1]) continue;
  const normalized = normalizeEntry(match[1]);
  if (!rawByNormalized.has(normalized)) rawByNormalized.set(normalized, match[1]);
}

const entryNames = [...rawByNormalized.keys()];
const entrySet = new Set(entryNames);

function entryContent(normalized: string): string | undefined {
  const rawName = rawByNormalized.get(normalized);
  return rawName === undefined ? undefined : readEntry(rawName);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sortedEqual(actual: string[], expected: string[]): boolean {
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

// 1. Zip filename version matches package.json version.
const zipName = basename(zipPath);
const nameTarget = zipName.includes("-firefox-") ? "firefox" : "chrome";
if (explicitTarget && explicitTarget !== nameTarget) {
  fatal(`expected a ${explicitTarget} zip, got ${zipName}`);
}
const target = explicitTarget ?? nameTarget;
console.log(`verifying ${zipPath} as ${target}`);
const EXPECTED_PERMISSIONS =
  target === "firefox" ? EXPECTED_PERMISSIONS_FIREFOX : EXPECTED_PERMISSIONS_CHROME;
const nameMatch = zipName.match(/^yt-topic-radar(?:-firefox)?-v(.+)\.zip$/);
if (!nameMatch?.[1]) {
  check("filename", false, `expected yt-topic-radar[-firefox]-v<version>.zip, got ${zipName}`);
} else {
  check(
    "filename",
    nameMatch[1] === packageVersion,
    `expected version ${packageVersion}, got "${nameMatch[1]}" (${zipName})`,
  );
}

// 2. Required entries present.
for (const entry of REQUIRED_ENTRIES) {
  check(`required entry ${entry}`, entrySet.has(entry), "missing from archive");
}

// 3. Forbidden entries absent.
const forbidden: Array<{ label: string; matches: (name: string) => boolean }> = [
  {
    label: ".env",
    matches: (name) => name.split("/").some((part) => part.startsWith(".env")),
  },
  { label: ".map", matches: (name) => name.endsWith(".map") },
  {
    label: "_metadata/",
    matches: (name) => name.split("/").some((part) => part === "_metadata"),
  },
  {
    label: "tts-scan-utils.js",
    matches: (name) => name.endsWith("tts-scan-utils.js"),
  },
  {
    label: "telemetry-utils.js",
    matches: (name) => name.endsWith("telemetry-utils.js"),
  },
  {
    label: ".DS_Store",
    matches: (name) => name.split("/").some((part) => part === ".DS_Store"),
  },
  {
    label: "node_modules/",
    matches: (name) => name.split("/").some((part) => part === "node_modules"),
  },
  { label: ".pem", matches: (name) => name.endsWith(".pem") },
  { label: ".log", matches: (name) => name.endsWith(".log") },
];

for (const rule of forbidden) {
  const hits = entryNames.filter(rule.matches);
  const shown = hits.slice(0, 5).join(", ");
  const more = hits.length > 5 ? ` (+${hits.length - 5} more)` : "";
  check(
    `forbidden ${rule.label}`,
    hits.length === 0,
    hits.length > 0 ? `found ${shown}${more}` : "",
  );
}

// 4. Parsed manifest assertions.
const manifestRaw = entryContent("manifest.json");
let manifest: Record<string, unknown> | undefined;

if (manifestRaw === undefined) {
  check("manifest parse", false, "manifest.json missing or unreadable");
} else {
  try {
    const parsed: unknown = JSON.parse(manifestRaw);
    manifest = asRecord(parsed);
    check("manifest parse", manifest !== undefined, "manifest.json is not a JSON object");
  } catch (error) {
    check(
      "manifest parse",
      false,
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (manifest) {
  check(
    "manifest version",
    manifest.version === packageVersion,
    `expected ${packageVersion}, got ${JSON.stringify(manifest.version)}`,
  );

  const permissions = manifest.permissions;
  check(
    "manifest permissions",
    isStringArray(permissions) && sortedEqual(permissions, EXPECTED_PERMISSIONS),
    `expected ${JSON.stringify([...EXPECTED_PERMISSIONS].sort())}, got ${JSON.stringify(permissions)}`,
  );

  const badPermissions = isStringArray(permissions)
    ? permissions.filter((permission) => /alarm|notification/i.test(permission))
    : [];
  check(
    "manifest permissions no alarm/notification",
    badPermissions.length === 0,
    badPermissions.length > 0 ? `found ${badPermissions.join(", ")}` : "",
  );

  const hosts = manifest.host_permissions;
  check(
    "manifest host_permissions",
    isStringArray(hosts) && sortedEqual(hosts, EXPECTED_HOSTS),
    `expected ${JSON.stringify([...EXPECTED_HOSTS].sort())}, got ${JSON.stringify(hosts)}`,
  );

  const badHosts = isStringArray(hosts)
    ? hosts.filter((host) => /localhost|127\.0\.0\.1/.test(host))
    : [];
  check(
    "manifest hosts no localhost",
    badHosts.length === 0,
    badHosts.length > 0 ? `found ${badHosts.join(", ")}` : "",
  );

  const background = asRecord(manifest.background);
  if (target === "firefox") {
    const scripts = background?.scripts;
    check(
      "manifest background.scripts",
      Array.isArray(scripts) && scripts.includes("background.js"),
      `got ${JSON.stringify(scripts)}`,
    );
    const gecko = asRecord(asRecord(manifest.browser_specific_settings)?.gecko);
    check(
      "manifest gecko id",
      typeof gecko?.id === "string" && gecko.id.length > 0,
      `got ${JSON.stringify(gecko?.id)}`,
    );
    const sidebar = asRecord(manifest.sidebar_action);
    check(
      "manifest sidebar_action panel",
      sidebar?.default_panel === "digest.html",
      `got ${JSON.stringify(sidebar?.default_panel)}`,
    );
    check(
      "manifest no side_panel",
      manifest.side_panel === undefined,
      `got ${JSON.stringify(manifest.side_panel)}`,
    );
  } else {
    const serviceWorker = background?.service_worker;
    check(
      "manifest background.service_worker",
      serviceWorker === "background.js",
      `got ${JSON.stringify(serviceWorker)}`,
    );
  }

  const dnr = asRecord(manifest.declarative_net_request);
  const ruleResources = dnr?.rule_resources;
  const referencesRules =
    Array.isArray(ruleResources) &&
    ruleResources.some((resource) => asRecord(resource)?.path === "rules.json");
  check(
    "manifest DNR references rules.json",
    referencesRules,
    `rule_resources = ${JSON.stringify(ruleResources)}`,
  );
}

// 5. background.js forbidden strings.
const backgroundJs = entryContent("background.js");
if (backgroundJs === undefined) {
  check("background.js forbidden strings", false, "background.js missing or unreadable");
} else {
  const forbiddenTokens = [
    "fetch(",
    "API_BASE",
    "localhost",
    "chrome.alarms",
    "chrome.notifications",
    "setBadgeText",
  ];
  const found = forbiddenTokens.filter((token) => backgroundJs.includes(token));
  check(
    "background.js forbidden strings",
    found.length === 0,
    found.length > 0 ? `found ${found.join(", ")}` : "",
  );
}

// 6. digest.js localhost/alarms assertions.
const digestJs = entryContent("digest.js");
if (digestJs === undefined) {
  check("digest.js forbidden strings", false, "digest.js missing or unreadable");
} else {
  const localhostCount = countOccurrences(digestJs, "localhost:3456");
  const hasAlarmCreate = digestJs.includes("chrome.alarms.create");
  const found: string[] = [];
  if (localhostCount > 0) found.push(`"localhost:3456" x${localhostCount}`);
  if (hasAlarmCreate) found.push('"chrome.alarms.create"');
  for (const token of ["proChanged", "rssUnread"]) {
    if (digestJs.includes(token)) found.push(`"${token}"`);
  }
  check(
    "digest.js forbidden strings",
    found.length === 0,
    found.length > 0 ? `found ${found.join(", ")}` : "",
  );
}

// 7. rules.json assertions.
const rulesRaw = entryContent("rules.json");
let rules: unknown;
let rulesParsed = false;

if (rulesRaw === undefined) {
  check("rules.json parse", false, "rules.json missing or unreadable");
} else {
  try {
    rules = JSON.parse(rulesRaw);
    rulesParsed = true;
    check("rules.json parse", true);
  } catch (error) {
    check(
      "rules.json parse",
      false,
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (rulesParsed) {
  const isRuleArray = Array.isArray(rules);
  check(
    "rules.json exactly one rule",
    isRuleArray && rules.length === 1,
    isRuleArray ? `found ${rules.length}` : "not a JSON array",
  );

  const rule = isRuleArray && rules.length > 0 ? asRecord(rules[0]) : undefined;
  const condition = asRecord(rule?.condition);
  const action = asRecord(rule?.action);

  const urlFilter = condition?.urlFilter;
  check(
    "rules.json condition.urlFilter",
    urlFilter === "||youtube.com/youtubei/",
    `got ${JSON.stringify(urlFilter)}`,
  );

  const resourceTypes = condition?.resourceTypes;
  check(
    "rules.json condition.resourceTypes includes xmlhttprequest",
    Array.isArray(resourceTypes) && resourceTypes.includes("xmlhttprequest"),
    `got ${JSON.stringify(resourceTypes)}`,
  );

  const actionType = action?.type;
  check(
    "rules.json action.type",
    actionType === "modifyHeaders",
    `got ${JSON.stringify(actionType)}`,
  );

  const requestHeaders = action?.requestHeaders;
  const originSet =
    Array.isArray(requestHeaders) &&
    requestHeaders.some((header) => {
      const record = asRecord(header);
      return (
        record?.header === "Origin" &&
        record.operation === "set" &&
        record.value === "https://www.youtube.com"
      );
    });
  check(
    "rules.json Origin header set",
    originSet,
    `requestHeaders = ${JSON.stringify(requestHeaders)}`,
  );
}

const failures = results.filter((result) => !result.ok);
for (const failure of failures) {
  console.log(`FAIL ${failure.name}: ${failure.detail || "check failed"}`);
}

if (failures.length > 0) {
  console.log(`FAILED ${failures.length} of ${results.length} checks`);
  process.exit(1);
}

console.log(`PASS ${results.length} checks`);
process.exit(0);
