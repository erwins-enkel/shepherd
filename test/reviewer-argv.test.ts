import { expect, test } from "bun:test";
import { readonlyReviewerArgv } from "../src/reviewer-argv";

test("--settings includes enableAllProjectMcpServers and disableAllHooks", () => {
  const { argv: a } = readonlyReviewerArgv(null, "some prompt");
  const settingsIdx = a.indexOf("--settings");
  expect(settingsIdx).toBeGreaterThan(-1);
  const raw = a[settingsIdx + 1];
  expect(raw).toBeDefined();
  const parsed = JSON.parse(raw!);
  expect(parsed.enableAllProjectMcpServers).toBe(true);
  expect(parsed.disableAllHooks).toBe(true);
});

test("no thinkingTokens → --settings carries no env / MAX_THINKING_TOKENS", () => {
  // The plan reviewer (and any caller that omits the budget) must NOT get a thinking
  // budget: MAX_THINKING_TOKENS would otherwise leak into every reviewer spawn.
  const { argv: a } = readonlyReviewerArgv(null, "some prompt");
  const parsed = JSON.parse(a[a.indexOf("--settings") + 1]!);
  expect(parsed.env).toBeUndefined();
});

test("thinkingTokens → --settings env.MAX_THINKING_TOKENS as a string", () => {
  // MAX_THINKING_TOKENS is the only knob that actually grants thinking budget to a
  // spawned session's initial positional prompt (the think/ultrathink magic words do
  // not fire there). Env values are strings.
  const { argv: a } = readonlyReviewerArgv(null, "some prompt", 8000);
  const parsed = JSON.parse(a[a.indexOf("--settings") + 1]!);
  expect(parsed.env).toEqual({ MAX_THINKING_TOKENS: "8000" });
  // budget must not disturb the existing reviewer invariants
  expect(parsed.disableAllHooks).toBe(true);
  expect(parsed.enableAllProjectMcpServers).toBe(true);
  expect(a).toContain("--safe-mode");
});

test("coupling invariant: enableAllProjectMcpServers implies --safe-mode", () => {
  const { argv: a } = readonlyReviewerArgv(null, "some prompt");
  const settingsIdx = a.indexOf("--settings");
  expect(settingsIdx).toBeGreaterThan(-1);
  const raw = a[settingsIdx + 1];
  expect(raw).toBeDefined();
  const parsed = JSON.parse(raw!);
  // Precondition: the setting must be enabled
  expect(parsed.enableAllProjectMcpServers).toBe(true);
  // enableAllProjectMcpServers must always travel with --safe-mode;
  // without it, untrusted project MCP servers auto-load in the reviewer spawn.
  expect(a).toContain("--safe-mode");
});
