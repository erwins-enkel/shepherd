import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// #3128: update.sh must keep already-provisioned hosts in sync with the agents slice + herdr drop-in,
// WITHOUT bouncing herdr (that ends every live session) — a daemon-reload applies both.
const src = readFileSync(new URL("../deploy/update.sh", import.meta.url), "utf8");
const start = src.indexOf("AGENT_UNITS_CHANGED=0");
const end = src.indexOf('note "syncing herdr daemon unit"');
const block = src.slice(start, end);

test("syncs the slice and the drop-in, each only when it differs", () => {
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  for (const f of ["shepherd_agents.slice", "herdr.service.d/99-shepherd.conf"]) {
    expect(block).toContain(`cmp -s "$REPO/deploy/${f}" "$UNIT_DIR/${f}"`);
    expect(block).toContain(`cp "$REPO/deploy/${f}" "$UNIT_DIR/${f}"`);
  }
  expect(block).toContain("systemctl --user daemon-reload");
});

test("never restarts herdr for the agent units", () => {
  expect(block).not.toMatch(/(try-)?restart herdr/);
});

test("warns when the effective herdr TasksMax undercuts the repo floor", () => {
  expect(src).toContain("systemctl --user show herdr -p TasksMax --value");
  expect(src).toMatch(/HAVE_TASKS < WANT_TASKS/);
});
