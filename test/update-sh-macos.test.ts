import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// deploy/update.sh runs under `set -e`. On macOS / core-only there is no systemd
// user manager, so a bare `systemctl --user restart` aborts the whole deploy after
// the build already succeeded (the original macOS crash). These assert the restart
// stays gated behind a systemctl-presence probe so it can never regress to that.
const src = readFileSync(new URL("../deploy/update.sh", import.meta.url), "utf8");

test("update.sh never invokes `systemctl --user restart` unguarded at column 0", () => {
  const unguarded = src.split("\n").filter((l) => /^systemctl --user restart/.test(l)); // column 0 = outside any if-block
  expect(unguarded).toEqual([]);
});

test("update.sh gates the restart on a systemctl-presence probe with a manual-start fallback", () => {
  expect(src).toContain("command -v systemctl");
  expect(src).toMatch(/no systemd user manager[\s\S]*not restarting/);
  expect(src).toContain("bun run start");
});
