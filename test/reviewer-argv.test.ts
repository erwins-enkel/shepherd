import { expect, test } from "bun:test";
import { readonlyReviewerArgv } from "../src/reviewer-argv";
import { config } from "../src/config";

// Temporarily set config auth fields, always restoring them.
function withAuth(mode: typeof config.authMode, helper: string | null, fn: () => void): void {
  const prevMode = config.authMode;
  const prevPath = config.authApiKeyHelperPath;
  try {
    config.authMode = mode;
    config.authApiKeyHelperPath = helper;
    fn();
  } finally {
    config.authMode = prevMode;
    config.authApiKeyHelperPath = prevPath;
  }
}

function settingsOf(argv: string[]): Record<string, unknown> {
  return JSON.parse(argv[argv.indexOf("--settings") + 1]!);
}

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

// Extract the variadic `--allowedTools` values: every token after the flag up to
// the next flag (`--model` / `--permission-mode`). Stops at the first `--…` so a
// trailing flag or positional prompt is never miscounted as a tool.
function extractAllowedTools(argv: string[]): string[] {
  const idx = argv.indexOf("--allowedTools");
  expect(idx).toBeGreaterThan(-1);
  const tools: string[] = [];
  for (let i = idx + 1; i < argv.length; i++) {
    if (argv[i]!.startsWith("--")) break;
    tools.push(argv[i]!);
  }
  return tools;
}

const EXPECTED_ALLOWLIST = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git status)",
  "Write",
];

// R4 (audit hardening): the unattended PR-critic / plan-gate reviewer inspects UNTRUSTED
// input (PR diffs, agent-written plan text). Its tool allowlist must stay a CLOSED read-only
// set — these tests fail the instant a future edit silently widens it to write/exec/outbound
// tools (Edit, bare Bash, WebFetch, MCP), which a prompt-injection could then abuse.
test("reviewer allowedTools is a closed read-only set", () => {
  // Test both argv shapes: --model (when set) shifts positions and must not leak into the set.
  for (const model of [null, "claude-opus-4-8"]) {
    const { argv } = readonlyReviewerArgv(model, "some prompt", model ? 8000 : undefined);
    const tools = extractAllowedTools(argv);
    // Closed set — order-insensitive. Adding ANY tool makes this fail.
    expect([...tools].sort()).toEqual([...EXPECTED_ALLOWLIST].sort());
  }
});

test("reviewer never bypasses permissions and pins dontAsk", () => {
  for (const model of [null, "claude-opus-4-8"]) {
    const { argv } = readonlyReviewerArgv(model, "some prompt");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    const permIdx = argv.indexOf("--permission-mode");
    expect(permIdx).toBeGreaterThan(-1);
    expect(argv[permIdx + 1]).toBe("dontAsk");
  }
});

// ── api-key auth-mode wiring ────────────────────────────────────────────────

test("subscription mode: --settings carries NO apiKeyHelper (byte-for-byte)", () => {
  withAuth("subscription", "/should/be/ignored.sh", () => {
    const { argv } = readonlyReviewerArgv(null, "p");
    const s = settingsOf(argv);
    expect(s.apiKeyHelper).toBeUndefined();
    // unchanged from the pre-api-key shape
    expect(s).toEqual({ disableAllHooks: true, enableAllProjectMcpServers: true });
  });
});

test("api-key mode (configured): --settings folds in apiKeyHelper after existing keys", () => {
  withAuth("api-key", "/helper.sh", () => {
    const { argv } = readonlyReviewerArgv(null, "p");
    const s = settingsOf(argv);
    expect(s.apiKeyHelper).toBe("/helper.sh");
    // existing reviewer invariants untouched
    expect(s.disableAllHooks).toBe(true);
    expect(s.enableAllProjectMcpServers).toBe(true);
  });
});

test("api-key mode (unconfigured): no apiKeyHelper key emitted", () => {
  withAuth("api-key", null, () => {
    const s = settingsOf(readonlyReviewerArgv(null, "p").argv);
    expect(s.apiKeyHelper).toBeUndefined();
  });
});

test("reviewer allowlist excludes write/exec/outbound tools", () => {
  const tools = extractAllowedTools(readonlyReviewerArgv(null, "some prompt").argv);
  // Explicit negative guards for readable failure messages if the set is widened.
  expect(tools).not.toContain("Edit");
  expect(tools).not.toContain("Bash"); // no general shell
  expect(tools).not.toContain("Bash(*)"); // no wildcard shell
  expect(tools.some((t) => /WebFetch|WebSearch|mcp__/.test(t))).toBe(false);
});
