#!/usr/bin/env node
// Zip the built `dist/` into an uploadable Chrome Web Store artifact.
//
// Run via `bun run package`, which builds first (see package.json). The zip has
// manifest.json at its ROOT (CWS requirement) — we zip the CONTENTS of dist/, not
// the dist/ directory itself. The version comes from package.json (kept in lockstep
// with manifest.config.ts), so the artifact name tracks the shipped version.
//
// The manifest's `key` field is STRIPPED from the zip: CWS rejects an upload whose
// manifest carries `key` ("key field is not allowed in manifest"). `key` exists in
// manifest.config.ts only to pin the *unpacked* dev-load extension ID
// (bflahkibnmcbijbhelmpjbohpfhlbaig); the published item gets its ID assigned by the
// store on first upload (reconciled per STORE_LISTING.md "Task 5"). We strip it from a
// staged copy so `dist/manifest.json` on disk keeps `key` for local unpacked loads.
//
// PREREQUISITE: the system `zip` binary must be on PATH (preinstalled on macOS and
// the CI ubuntu runner; `apt-get install zip` / `brew install zip` otherwise). A
// missing binary surfaces as an ENOENT with an install hint below rather than a
// silent failure.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(extRoot, "dist");
const manifestPath = join(dist, "manifest.json");

if (!existsSync(manifestPath)) {
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

// Stage a `key`-free manifest.json outside dist so the on-disk dist copy is untouched.
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const strippedKey = "key" in manifest;
delete manifest.key;
const stageDir = mkdtempSync(join(tmpdir(), "shepherd-capture-pkg-"));
writeFileSync(join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// `-r` recurse, `-X` drop extra file attributes for a deterministic archive. `.` from
// cwd=dist packs dist's contents at the zip root; `-x` omits the original manifest so
// the staged `key`-free one can take its place at the root in the second pass.
const runZip = (args, cwd) => {
  const res = spawnSync("zip", args, { cwd, stdio: "inherit" });
  if (res.error) {
    const hint =
      res.error.code === "ENOENT"
        ? " — the `zip` binary is not on PATH; install it (`apt-get install zip` / `brew install zip`)"
        : "";
    console.error(`✗ failed to run \`zip\`: ${res.error.message}${hint}`);
    rmSync(stageDir, { recursive: true, force: true });
    process.exit(1);
  }
  if (res.status !== 0) {
    rmSync(stageDir, { recursive: true, force: true });
    process.exit(res.status ?? 1);
  }
};

runZip(["-r", "-X", zipPath, ".", "-x", "manifest.json", "./manifest.json"], dist);
runZip(["-X", zipPath, "manifest.json"], stageDir);

rmSync(stageDir, { recursive: true, force: true });

console.log(
  `✓ packaged ${zipName}${strippedKey ? " (stripped manifest `key`)" : ""} — upload this to the Chrome Web Store dashboard`,
);
