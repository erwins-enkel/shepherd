import { expect, test } from "bun:test";
import { docAgentArgv } from "../src/doc-agent-argv";
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

test("posture: dontAsk present and is the LAST flag before the trailing prompt", () => {
  const { argv } = docAgentArgv(null, "the task prompt");
  const modeIdx = argv.indexOf("--permission-mode");
  expect(modeIdx).toBeGreaterThan(-1);
  expect(argv[modeIdx + 1]).toBe("dontAsk");
  // dontAsk must sit AFTER the variadic --allowedTools and immediately before the prompt positional.
  expect(modeIdx).toBeGreaterThan(argv.indexOf("--allowedTools"));
  expect(argv[argv.length - 1]).toBe("the task prompt");
});

test("posture: NEVER --dangerously-skip-permissions (untrusted source history)", () => {
  const { argv } = docAgentArgv(null, "p");
  expect(argv).not.toContain("--dangerously-skip-permissions");
});

test("posture: --safe-mode coupled with enableAllProjectMcpServers; hooks disabled", () => {
  const { argv } = docAgentArgv(null, "p");
  expect(argv).toContain("--safe-mode");
  expect(argv).toContain("--disable-slash-commands");
  const s = settingsOf(argv);
  expect(s.enableAllProjectMcpServers).toBe(true);
  expect(s.disableAllHooks).toBe(true);
});

test("allowlist: read-only set + bare Write + bare Edit (Edit is the only widening)", () => {
  const { argv } = docAgentArgv(null, "p");
  for (const t of [
    "Read",
    "Grep",
    "Glob",
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git show *)",
    "Bash(git status)",
    "Write",
    "Edit",
  ]) {
    expect(argv).toContain(t);
  }
});

test("allowlist: NO git mutation, NO gh, NO general Bash, NO network (publishing is server-side)", () => {
  const { argv } = docAgentArgv(null, "p");
  // The structural guarantee for "never auto-commits to a published branch": the agent literally
  // cannot stage/commit/push/open-a-PR — only DocAgentService.finalize() (the trusted server) does.
  const forbidden = [
    "Bash(git add *)",
    "Bash(git add:*)",
    "Bash(git commit *)",
    "Bash(git commit:*)",
    "Bash(git push *)",
    "Bash(git push:*)",
    "Bash(gh *)",
    "Bash(gh:*)",
    "Bash", // bare general Bash
    "Bash(*)",
    "WebFetch",
    "WebSearch",
  ];
  for (const t of forbidden) expect(argv).not.toContain(t);
});

test("model: omitted → no --model flag; provided → appended once before dontAsk", () => {
  const noModel = docAgentArgv(null, "p").argv;
  expect(noModel).not.toContain("--model");

  const withModel = docAgentArgv("opus", "p").argv;
  const mi = withModel.indexOf("--model");
  expect(mi).toBeGreaterThan(-1);
  expect(withModel[mi + 1]).toBe("opus");
  // --model must precede --permission-mode so the variadic allowlist isn't fed the model value.
  expect(mi).toBeLessThan(withModel.indexOf("--permission-mode"));
});

test("subscription mode → no apiKeyHelper in settings (byte-stable)", () => {
  withAuth("subscription", null, () => {
    const s = settingsOf(docAgentArgv(null, "p").argv);
    expect(s.apiKeyHelper).toBeUndefined();
  });
});

test("api-key mode (configured) → apiKeyHelper folded into settings", () => {
  withAuth("api-key", "/usr/local/bin/key-helper", () => {
    const s = settingsOf(docAgentArgv(null, "p").argv);
    expect(s.apiKeyHelper).toBe("/usr/local/bin/key-helper");
  });
});

test("each call mints a fresh session id", () => {
  const a = docAgentArgv(null, "p").sessionId;
  const b = docAgentArgv(null, "p").sessionId;
  expect(a).not.toBe(b);
});
