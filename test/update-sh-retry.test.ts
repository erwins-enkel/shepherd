import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// deploy/update.sh's `bun install` steps can hit a transient node-pty tarball-extract
// flake (#1602) that passes on a re-run. They must stay wrapped in the bounded `retry`
// helper so one flake can't fail the deploy — nor red the onboarding serviceLifecycle
// release gate, which drives update.sh through provision's installService path.
const src = readFileSync(new URL("../deploy/update.sh", import.meta.url), "utf8");

test("update.sh defines a bounded retry helper for the transient install flake (#1602)", () => {
  expect(src).toMatch(/^retry\(\)\s*\{/m);
  expect(src).toContain("#1602");
});

test("update.sh wraps both bun install steps in retry — no bare `bun install` remains", () => {
  expect(src).toContain("retry 2 bun install");
  expect(src).toContain("(cd ui && retry 2 bun install)");
  // No un-retried root `bun install` at line start (fix-perms is `bun scripts`, build is `bun run`).
  const bareInstall = src.split("\n").filter((l) => /^\s*bun install\b/.test(l));
  expect(bareInstall).toEqual([]);
});
