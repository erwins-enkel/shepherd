import { expect, test } from "bun:test";
import { readonlyReviewerArgv } from "../src/reviewer-argv";

test("--settings includes enableAllProjectMcpServers and disableAllHooks", () => {
  const { argv: a } = readonlyReviewerArgv(null, "some prompt");
  const settingsIdx = a.indexOf("--settings");
  expect(settingsIdx).toBeGreaterThan(-1);
  const parsed = JSON.parse(a[settingsIdx + 1]);
  expect(parsed.enableAllProjectMcpServers).toBe(true);
  expect(parsed.disableAllHooks).toBe(true);
});

test("coupling invariant: enableAllProjectMcpServers implies --safe-mode", () => {
  const { argv: a } = readonlyReviewerArgv(null, "some prompt");
  const settingsIdx = a.indexOf("--settings");
  expect(settingsIdx).toBeGreaterThan(-1);
  const parsed = JSON.parse(a[settingsIdx + 1]);
  // Precondition: the setting must be enabled
  expect(parsed.enableAllProjectMcpServers).toBe(true);
  // enableAllProjectMcpServers must always travel with --safe-mode;
  // without it, untrusted project MCP servers auto-load in the reviewer spawn.
  expect(a).toContain("--safe-mode");
});
