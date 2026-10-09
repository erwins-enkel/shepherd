#!/usr/bin/env bun
/**
 * Dev/test Bun floor (#2916): `engines.bun` in the root package.json.
 *
 * Bun 1.3.x lets a spawned child see EOF on a still-open pipe after an earlier child was
 * killed, so the shared-browser/agent-ingress tests go red and `root-tests` can hang to its
 * timeout locally while CI (`bun-version: latest`) is green. This floor makes that a clear
 * "upgrade Bun" instead of a phantom red suite. It is NOT the runtime floor for running
 * Shepherd — that is MIN_BUN_VERSION in src/runtime-guard.ts.
 *
 * Used by scripts/pre-push.ts (blocks), .claude/hooks/ensure-deps.sh (warns) and CI's
 * `static` job. CLI: exit 1 when too old; `--warn` always exits 0.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function devBunFloor(pkg: { engines?: { bun?: string } }): string {
  const floor = pkg.engines?.bun;
  if (!floor) throw new Error("package.json has no engines.bun");
  return floor;
}

/** Prerelease/build suffixes do not change the floor (same rule as deploy/install.sh). */
export function bunMeetsFloor(version: string, range: string): boolean {
  return Bun.semver.satisfies(version.replace(/[-+].*$/, ""), range);
}

export function checkBunVersion(version: string, range: string): { ok: boolean; message: string } {
  if (bunMeetsFloor(version, range)) return { ok: true, message: "" };
  return {
    ok: false,
    message:
      `Bun ${version} is below the dev floor ${range} (package.json engines.bun): ` +
      `tests can fail or hang spuriously (#2916). Run: bun upgrade`,
  };
}

/** Check the running Bun against the repo's floor. */
export function checkCurrentBun(repoRoot: string): { ok: boolean; message: string } {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  return checkBunVersion(Bun.version, devBunFloor(pkg));
}

if (import.meta.main) {
  const { ok, message } = checkCurrentBun(join(import.meta.dir, ".."));
  if (!ok) {
    console.error(`✗ ${message}`);
    if (!process.argv.includes("--warn")) process.exit(1);
  }
}
