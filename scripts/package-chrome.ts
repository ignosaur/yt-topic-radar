import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const EXTENSION_DIR = join(ROOT, "extension");
const DIST_DIR = join(ROOT, "dist");
const VERSION_PATTERN = /^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.-]+)?$/;

function fail(message: string): never {
  console.error(`\n✖ package:chrome: ${message}`);
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
    return await Bun.file(join(ROOT, relativePath)).json();
  } catch (error) {
    fail(`cannot read ${relativePath}: ${(error as Error).message}`);
  }
}

async function main() {
  const pkg = await readJson("package.json");
  const prodManifest = await readJson("scripts/manifest.prod.json");
  const devManifest = await readJson("scripts/manifest.dev.json");
  const builtManifest = await readJson("extension/manifest.json");

  const version = pkg.version;
  const sources: Array<[string, unknown]> = [
    ["package.json", pkg.version],
    ["scripts/manifest.prod.json", prodManifest.version],
    ["scripts/manifest.dev.json", devManifest.version],
    ["extension/manifest.json", builtManifest.version],
  ];

  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    fail(`package.json has an invalid version: ${JSON.stringify(version)}`);
  }

  const mismatches = sources.filter(([, value]) => value !== version);
  if (mismatches.length > 0) {
    fail(
      `version mismatch — package.json and all manifests must match.\n${sources
        .map(([file, value]) => `  ${file}: ${String(value)}`)
        .join("\n")}\n  (run \`bun run build:ext\` to refresh extension/manifest.json)`,
    );
  }

  if (JSON.stringify(prodManifest).includes("http://localhost:3456")) {
    fail("scripts/manifest.prod.json still references http://localhost:3456/*");
  }

  const permissions: string[] = Array.isArray(prodManifest.permissions)
    ? prodManifest.permissions
    : [];
  const bannedPermissions = permissions.filter(
    (permission) => permission === "alarms" || permission === "notifications",
  );
  if (bannedPermissions.length > 0) {
    fail(`scripts/manifest.prod.json must not request ${bannedPermissions.join(", ")}`);
  }

  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });
  await rm(join(EXTENSION_DIR, "_metadata"), { recursive: true, force: true });

  // Fixed mtimes make zip entries reproducible across checkouts.
  await mustRun(["find", "extension", "-type", "f", "-exec", "touch", "-d", "@0", "{}", "+"]);

  const zipName = `yt-topic-radar-v${version}.zip`;
  const zipPath = join(DIST_DIR, zipName);
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
  const checksum = await mustRun(["sha256sum", zipPath]);
  const sha256 = checksum.stdout.trim().split(/\s+/)[0];

  console.log(`\n✔ packaged ${zipName}`);
  console.log(`  path:    ${zipPath}`);
  console.log(`  entries: ${entryCount}`);
  console.log(`  sha256:  ${sha256}`);

  const verifier = join(ROOT, "scripts/verify-package.ts");
  console.log("\n→ bun scripts/verify-package.ts");
  const proc = Bun.spawn(["bun", verifier], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) fail(`scripts/verify-package.ts failed (exit ${code})`);

  console.log("\n✔ package:chrome complete");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
