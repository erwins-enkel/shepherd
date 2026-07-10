import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

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

// provision.ts installs shepherd.service only on a fresh box, so an existing host would never
// pick up later unit changes — most consequentially the `After=herdr.service` boot-ordering that
// keeps the diagnostics probe from racing herdr's startup. update.sh must self-heal it, mirroring
// its herdr.service / timer syncs. Presence assertions (the existing text-grep pattern):
test("update.sh self-heals shepherd.service into the user unit dir with WorkingDirectory templated", () => {
  // writes the rendered unit to the user unit dir
  expect(src).toMatch(/"\$UNIT_DIR\/shepherd\.service"/);
  // templates WorkingDirectory to the checkout via the same rewrite templateUnit uses
  expect(src).toMatch(/s\|\^WorkingDirectory=\.\*\|WorkingDirectory=\$\{REPO\}\|/);
  // reloads so the restart below picks up the new unit
  expect(src).toContain("systemctl --user daemon-reload");
});

// Behavioral, not just grep: run the SAME WorkingDirectory rewrite update.sh uses against the
// real deploy/shepherd.service and assert the rendered unit is well-formed — a malformed sed that
// dropped the ordering or mangled WorkingDirectory would pass a text-grep but fail here.
// Coverage limit: this replicates the sed expression rather than extracting it from update.sh; the
// grep assertion above (that the script uses this exact ^WorkingDirectory= rewrite) is the bridge.
test("the shepherd.service WorkingDirectory rewrite renders a well-formed, correctly-ordered unit", () => {
  const unitPath = new URL("../deploy/shepherd.service", import.meta.url).pathname;
  const repo = "/tmp/some/checkout";
  const rendered = spawnSync(
    "sed",
    [`s|^WorkingDirectory=.*|WorkingDirectory=${repo}|`, unitPath],
    {
      encoding: "utf8",
    },
  );
  expect(rendered.status).toBe(0);
  const out = rendered.stdout;
  // WorkingDirectory rewritten to the given checkout, exactly once
  expect(out.match(/^WorkingDirectory=.*$/gm)).toEqual([`WorkingDirectory=${repo}`]);
  // boot ordering + Wants intact — this is the whole point of syncing the unit
  expect(out).toMatch(/^After=network-online\.target herdr\.service$/m);
  expect(out).toMatch(/^Wants=herdr\.service$/m);
});
