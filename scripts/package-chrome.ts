import { readdirSync, statSync, utimesSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
// Same script packages both targets: `bun scripts/package-chrome.ts chrome|firefox`.
// (Filename is historic and cited by older docs/kickoff files; store/ references only the bun script names.)
const targetArg = process.argv[2];
if (targetArg !== undefined && targetArg !== "chrome" && targetArg !== "firefox") {
  console.error(`\n✖ package: unknown target ${JSON.stringify(targetArg)} (expected chrome|firefox)`);
  process.exit(1);
}
const TARGET = targetArg === "firefox" ? "firefox" : "chrome";
const TAG = TARGET === "firefox" ? "package:firefox" : "package:chrome";
const EXTENSION_DIR = join(ROOT, TARGET === "firefox" ? "extension-firefox" : "extension");
const DIST_DIR = join(ROOT, "dist");
const VERSION_PATTERN = /^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.-]+)?$/;

function fail(message: string): never {
  console.error(`\n✖ ${TAG}: ${message}`);
  process.exit(1);
}

async function run(cmd: string[], cwd = ROOT) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function mustRun(cmd: string[], cwd = ROOT) {
  const result = await run(cmd, cwd);
  if (result.code !== 0) {
    fail(`\`${cmd.join(" ")}\` failed (exit ${result.code})\n${result.stderr.trim()}`);
  }
  return result;
}

async function readJson(relativePath: string): Promise<any> {
  try {
    return await Bun.file(resolve(ROOT, relativePath)).json();
  } catch (error) {
    fail(`cannot read ${relativePath}: ${(error as Error).message}`);
  }
}

async function main() {
  const pkg = await readJson("package.json");
  const prodManifest = await readJson("scripts/manifest.prod.json");
  const devManifest = await readJson("scripts/manifest.dev.json");
  const firefoxManifest = await readJson("scripts/manifest.firefox.json");
  const targetManifestSource =
    TARGET === "firefox" ? "scripts/manifest.firefox.json" : "scripts/manifest.prod.json";
  const targetManifest = TARGET === "firefox" ? firefoxManifest : prodManifest;
  const builtManifestPath = join(EXTENSION_DIR, "manifest.json");
  const builtManifest = await readJson(builtManifestPath);

  const version = pkg.version;
  const sources: Array<[string, unknown]> = [
    ["package.json", pkg.version],
    ["scripts/manifest.prod.json", prodManifest.version],
    ["scripts/manifest.dev.json", devManifest.version],
    ["scripts/manifest.firefox.json", firefoxManifest.version],
    [builtManifestPath, builtManifest.version],
  ];

  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    fail(`package.json has an invalid version: ${JSON.stringify(version)}`);
  }

  const mismatches = sources.filter(([, value]) => value !== version);
  if (mismatches.length > 0) {
    fail(
      `version mismatch — package.json and all manifests must match.\n${sources
        .map(([file, value]) => `  ${file}: ${String(value)}`)
        .join("\n")}\n  (run \`bun run ${TARGET === "firefox" ? "build:ext:firefox" : "build:ext"}\` to refresh the built manifest)`,
    );
  }

  if (JSON.stringify(targetManifest).includes("http://localhost:3456")) {
    fail(`${targetManifestSource} still references http://localhost:3456/*`);
  }

  const permissions: string[] = Array.isArray(targetManifest.permissions)
    ? targetManifest.permissions
    : [];
  const bannedPermissions = permissions.filter(
    (permission) => permission === "alarms" || permission === "notifications",
  );
  if (bannedPermissions.length > 0) {
    fail(`${targetManifestSource} must not request ${bannedPermissions.join(", ")}`);
  }

  const zipName =
    TARGET === "firefox" ? `yt-topic-radar-firefox-v${version}.zip` : `yt-topic-radar-v${version}.zip`;
  const zipPath = join(DIST_DIR, zipName);
  await mkdir(DIST_DIR, { recursive: true });
  await rm(zipPath, { force: true });
  await rm(join(EXTENSION_DIR, "_metadata"), { recursive: true, force: true });

  // Fixed mtimes make zip entries reproducible across checkouts.
  // In-process: GNU/BSD touch flags differ (`-d "@0"` is Linux-only), so no shell-out.
  const epoch = new Date(0);
  const stack = [EXTENSION_DIR];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else utimesSync(full, epoch, epoch);
    }
  }

  // Sorted paths keep the central-directory order stable; -X drops extra file attributes.
  await mustRun(
    ["/bin/sh", "-c", `find . -type f ! -path './_metadata/*' | sort | zip -X -@ '../dist/${zipName}'`],
    EXTENSION_DIR,
  );

  const listing = await mustRun(["unzip", "-l", zipPath]);
  const forbidden = [".env", ".map", "_metadata", ".DS_Store", "node_modules"];
  const found = forbidden.filter((entry) => listing.stdout.includes(entry));
  if (found.length > 0) {
    await rm(zipPath, { force: true });
    fail(`refusing to package — zip contains forbidden entries: ${found.join(", ")}`);
  }

  const entries = await mustRun(["unzip", "-Z1", zipPath]);
  const entryCount = entries.stdout.split("\n").filter((line) => line.trim() !== "").length;
  // In-process hash: macOS has no `sha256sum` (it ships `shasum` instead).
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(zipPath).arrayBuffer());
  const sha256 = hasher.digest("hex");

  console.log(`\n✔ packaged ${zipName}`);
  console.log(`  path:    ${zipPath}`);
  console.log(`  entries: ${entryCount}`);
  console.log(`  sha256:  ${sha256}`);

  const verifier = join(ROOT, "scripts/verify-package.ts");
  console.log(`\n→ bun scripts/verify-package.ts ${zipPath} ${TARGET}`);
  const proc = Bun.spawn(["bun", verifier, zipPath, TARGET], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) fail(`scripts/verify-package.ts failed (exit ${code})`);

  console.log(`\n✔ ${TAG} complete`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
