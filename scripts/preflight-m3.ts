import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST_DIR = join(ROOT, "dist");
const STORE_DIR = join(ROOT, "store");

const REQUIRED_STORE_FILES = [
  "store/privacy-policy.html",
  "store/listing.md",
  "store/permissions.md",
  "store/data-disclosure.md",
  "store/submission-checklist.md",
];

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ico",
  ".zip",
  ".pdf",
  ".mp4",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);

type ZipInfo = { path: string; name: string };
type PlaceholderHit = { text: string; file: string; line: number };
type ChecklistItem = { line: number; text: string };

function displayPath(path: string): string {
  const rel = relative(ROOT, path);
  return (rel === "" ? "." : rel).split(sep).join("/");
}

function walk(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function isBinary(file: string, content: string): boolean {
  return BINARY_EXTENSIONS.has(extname(file).toLowerCase()) || content.includes("\u0000");
}

function findNewestZip(): ZipInfo | undefined {
  let names: string[];
  try {
    names = readdirSync(DIST_DIR);
  } catch {
    return undefined;
  }
  const candidates: Array<{ path: string; name: string; mtime: number }> = [];
  for (const name of names) {
    if (!/^yt-topic-radar-v.+\.zip$/.test(name)) continue;
    const path = join(DIST_DIR, name);
    try {
      const stat = statSync(path);
      if (stat.isFile()) candidates.push({ path, name, mtime: stat.mtimeMs });
    } catch {
      // Ignore unreadable candidates; verify-package treats the same way.
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  const newest = candidates[0];
  return newest ? { path: newest.path, name: newest.name } : undefined;
}

async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function tailLines(text: string, max: number): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-max);
}

async function readZipManifest(zipPath: string): Promise<{ version?: string; error?: string }> {
  const result = await run(["unzip", "-p", zipPath, "manifest.json"]);
  if (result.code !== 0) {
    return { error: result.stderr.trim() || `unzip exited ${result.code}` };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { version?: unknown };
    if (typeof parsed.version !== "string") return { error: "manifest.json has no string version" };
    return { version: parsed.version };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function collectPlaceholders(): { hits: PlaceholderHit[]; occurrences: number } {
  const matches: PlaceholderHit[] = [];
  for (const file of walk(STORE_DIR)) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (isBinary(file, content)) continue;
    const lines = content.split(/\r?\n/);
    lines.forEach((lineText, index) => {
      const found = lineText.match(/\[OWNER:[^\]]*\]/g);
      if (!found) return;
      for (const text of found) {
        matches.push({ text, file: displayPath(file), line: index + 1 });
      }
    });
  }

  // One owner value fixes every occurrence, so placeholders are deduped by exact text.
  const byText = new Map<string, PlaceholderHit>();
  for (const hit of matches) {
    if (!byText.has(hit.text)) byText.set(hit.text, hit);
  }
  const hits = [...byText.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.text.localeCompare(b.text),
  );
  return { hits, occurrences: matches.length };
}

function countScreenshots(): number {
  const dir = join(STORE_DIR, "screenshots");
  try {
    if (!statSync(dir).isDirectory()) return -1;
  } catch {
    return -1;
  }
  return walk(dir).filter((file) => IMAGE_EXTENSIONS.has(extname(file).toLowerCase())).length;
}

function collectChecklist(): { missing: boolean; items: ChecklistItem[] } {
  const file = join(STORE_DIR, "submission-checklist.md");
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return { missing: true, items: [] };
  }
  const items: ChecklistItem[] = [];
  let section = "";
  // Checklist steps must start at column 0 so prose that mentions the marker is ignored.
  // Only pre-submission sections gate `GO`: submission/post-approval steps cannot be true beforehand,
  // and the gate cannot verify its own GO state.
  content.split(/\r?\n/).forEach((lineText, index) => {
    const heading = lineText.match(/^##\s+(.*)$/);
    if (heading) {
      section = heading[1]?.trim() ?? "";
      return;
    }
    if (/post-approval|submit for review/i.test(section)) return;
    const match = lineText.match(/^- \[ \]\s*(.*)$/);
    if (!match) return;
    const text = (match[1] ?? "").trim() || "(no description)";
    if (/preflight:m3/.test(text)) return;
    items.push({ line: index + 1, text });
  });
  return { missing: false, items };
}

async function main(): Promise<void> {
  let blockers = 0;
  const details: string[] = [];

  const zip = findNewestZip();
  let zipLine: string;
  let verifyFailed = false;

  if (!zip) {
    blockers += 1;
    zipLine = "[zip] missing (dist/yt-topic-radar-v*.zip)";
    details.push("  - zip: no dist/yt-topic-radar-v*.zip found");
  } else {
    const verify = await run(["bun", "scripts/verify-package.ts", zip.path]);
    if (verify.code !== 0) {
      verifyFailed = true;
      blockers += 1;
      zipLine = `[zip] FAIL ${zip.name} (verify: FAIL exit ${verify.code})`;
      const output = tailLines(`${verify.stdout}\n${verify.stderr}`, 15);
      if (output.length === 0) details.push("  - verify: no output");
      for (const line of output) details.push(`  - verify: ${line}`);
    } else {
      zipLine = `[zip] OK ${zip.name} (verify: PASS)`;
    }
  }

  let packageVersion: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string") packageVersion = parsed.version;
  } catch {
    // Reported as a blocker below.
  }

  let prodVersion: string | undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(join(ROOT, "scripts", "manifest.prod.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof parsed.version === "string") prodVersion = parsed.version;
  } catch {
    // Reported as a blocker below.
  }

  let versionsLine: string;
  let versionProblem = false;
  if (packageVersion === undefined || prodVersion === undefined) {
    versionProblem = true;
    blockers += 1;
    versionsLine = "[versions] FAIL package.json or scripts/manifest.prod.json unreadable";
    details.push("  - versions: package.json or scripts/manifest.prod.json has no readable string version");
  } else if (packageVersion !== prodVersion) {
    versionProblem = true;
    blockers += 1;
    versionsLine = `[versions] FAIL package.json=${packageVersion} manifest.prod.json=${prodVersion}`;
    details.push(
      `  - versions: package.json=${packageVersion} vs scripts/manifest.prod.json=${prodVersion}`,
    );
  } else if (!zip) {
    versionsLine = "[versions] SKIP (no zip)";
  } else {
    const manifest = await readZipManifest(zip.path);
    if (manifest.error) {
      versionProblem = true;
      blockers += 1;
      versionsLine = "[versions] FAIL cannot read zip manifest";
      details.push(`  - versions: ${manifest.error}`);
    } else if (manifest.version !== packageVersion) {
      versionProblem = true;
      blockers += 1;
      versionsLine = `[versions] FAIL package.json=${packageVersion} zip=${manifest.version}`;
      details.push(
        `  - versions: package.json=${packageVersion} vs zip manifest.json=${manifest.version}`,
      );
    } else {
      versionsLine = `[versions] OK ${packageVersion}`;
    }
  }

  const missingFiles = REQUIRED_STORE_FILES.filter((rel) => {
    try {
      return !statSync(join(ROOT, rel)).isFile();
    } catch {
      return true;
    }
  }).sort();
  for (const rel of missingFiles) {
    blockers += 1;
    details.push(`  - file: missing ${rel}`);
  }
  const filesLine = missingFiles.length === 0 ? "[files] OK" : `[files] FAIL ${missingFiles.length} missing`;

  const placeholders = collectPlaceholders();
  for (const hit of placeholders.hits) {
    blockers += 1;
    details.push(`  - placeholder: ${hit.file}:${hit.line} ${hit.text}`);
  }
  const firstPlaceholder = placeholders.hits[0];
  const placeholdersLine =
    placeholders.occurrences === 0 || !firstPlaceholder
      ? "[placeholders] OK none found"
      : `[placeholders] ${placeholders.occurrences} found, ${placeholders.hits.length} unique, e.g. ${firstPlaceholder.file}:${firstPlaceholder.line} ${firstPlaceholder.text}`;

  const screenshots = countScreenshots();
  let screenshotsLine: string;
  if (screenshots < 0) {
    blockers += 1;
    screenshotsLine = "[screenshots] missing (store/screenshots/)";
    details.push("  - screenshots: store/screenshots/ not found");
  } else if (screenshots === 0) {
    blockers += 1;
    screenshotsLine = "[screenshots] 0 images (store/screenshots/)";
    details.push("  - screenshots: 0 images found");
  } else {
    screenshotsLine = `[screenshots] OK ${screenshots} image${screenshots === 1 ? "" : "s"} (store/screenshots/)`;
  }

  const checklist = collectChecklist();
  let checklistLine: string;
  if (checklist.missing) {
    checklistLine = "[checklist] missing (store/submission-checklist.md)";
  } else if (checklist.items.length === 0) {
    checklistLine = "[checklist] OK all steps checked";
  } else {
    blockers += checklist.items.length;
    checklistLine = `[checklist] ${checklist.items.length} unchecked steps`;
    for (const item of checklist.items.slice(0, 25)) {
      details.push(`  - checklist: store/submission-checklist.md:${item.line} ${item.text}`);
    }
    if (checklist.items.length > 25) {
      details.push(`  - checklist: …and ${checklist.items.length - 25} more`);
    }
  }

  let next: string;
  if (!zip) {
    next = "Run `bun run package:chrome` to create dist/yt-topic-radar-v*.zip.";
  } else if (verifyFailed) {
    next = "Fix packaging so `bun run verify:package` passes, then repackage.";
  } else if (versionProblem) {
    next = "Align the version in package.json and the packaged manifest.json.";
  } else if (missingFiles.length > 0) {
    next = `Create the missing required artifact: ${missingFiles[0] ?? ""}.`;
  } else if (firstPlaceholder) {
    next = `Fill the owner placeholder at ${firstPlaceholder.file}:${firstPlaceholder.line} (${firstPlaceholder.text}).`;
  } else if (screenshots <= 0) {
    next = "Add at least one screenshot to store/screenshots/ (png/jpg/jpeg/webp).";
  } else if (checklist.items.length > 0) {
    next = `Complete the first unchecked submission step: ${checklist.items[0]?.text ?? ""}`;
  } else {
    next = "Owner: submit the unlisted listing in the Chrome Web Store and record the listing ID.";
  }

  console.log(`M3 PREFLIGHT: ${blockers === 0 ? "GO" : "NO-GO"} (blockers=${blockers})`);
  for (const line of [zipLine, versionsLine, filesLine, placeholdersLine, screenshotsLine, checklistLine]) {
    console.log(line);
  }
  for (const detail of details) console.log(detail);
  console.log(`NEXT: ${next}`);

  process.exit(blockers === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`M3 PREFLIGHT: NO-GO (internal error)`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
