#!/usr/bin/env node
// Zip the built `dist/` into an uploadable Chrome Web Store artifact.
//
// Run via `bun run package`, which builds first (see package.json). The zip has
// manifest.json at its ROOT (CWS requirement) — we zip the CONTENTS of dist/, not
// the dist/ directory itself. The version comes from package.json (kept in lockstep
// with manifest.config.ts), so the artifact name tracks the shipped version.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(extRoot, "dist");

if (!existsSync(join(dist, "manifest.json"))) {
  console.error(
    "✗ dist/manifest.json not found — run `bun run build` first (or `bun run package`).",
  );
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(extRoot, "package.json"), "utf8"));
const zipName = `shepherd-capture-${version}.zip`;
const zipPath = join(extRoot, zipName);

// A stale same-name zip would otherwise be UPDATED (files merged) rather than replaced.
rmSync(zipPath, { force: true });

// `-r` recurse, `-X` drop extra file attributes for a deterministic archive. `.` from
// cwd=dist packs dist's contents at the zip root.
const res = spawnSync("zip", ["-r", "-X", zipPath, "."], { cwd: dist, stdio: "inherit" });
if (res.error) {
  console.error(`✗ failed to run \`zip\`: ${res.error.message}`);
  process.exit(1);
}
if (res.status !== 0) process.exit(res.status ?? 1);

console.log(`✓ packaged ${zipName} (upload this to the Chrome Web Store dashboard)`);
