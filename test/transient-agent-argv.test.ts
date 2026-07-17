import { expect, test } from "bun:test";
import { buildTransientAgentArgv, type TransientAgentKind } from "../src/transient-agent-argv";
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

// Extract the variadic --allowedTools values: every token after the flag up to the next --flag.
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

const ALL_KINDS: TransientAgentKind[] = ["reviewer", "doc", "writer-ro", "writer-only"];

// ── reasoning effort (issue #1417): opt-in per call site ─────────────────────────────────────────

test("effort omitted → no --effort, argv byte-unchanged", () => {
  const withEffort = buildTransientAgentArgv("reviewer", { model: "opus", prompt: "P" }).argv;
  expect(withEffort).not.toContain("--effort");
});

test("Claude effort emits --effort between --model and --permission-mode", () => {
  const { argv } = buildTransientAgentArgv("reviewer", {
    model: "opus",
    prompt: "P",
    effort: "high",
  });
  const effIdx = argv.indexOf("--effort");
  expect(argv[effIdx + 1]).toBe("high");
  expect(effIdx).toBeGreaterThan(argv.indexOf("--model"));
  expect(effIdx).toBeLessThan(argv.indexOf("--permission-mode"));
});

test("Codex effort routes to -c model_reasoning_effort with xhigh → high clamp", () => {
  const { argv } = buildTransientAgentArgv("reviewer", {
    provider: "codex",
    model: "gpt-5.5",
    prompt: "P",
    effort: "xhigh",
  });
  const cIdx = argv.indexOf("-c");
  expect(cIdx).toBeGreaterThan(-1);
  expect(argv[cIdx + 1]).toBe("model_reasoning_effort=high");
  expect(argv).not.toContain("--effort"); // Codex uses the -c surface, not --effort
});

// ── Mechanical invariant: flag order (the variadic --allowedTools trap) ─────────────────────────

test("every kind: --permission-mode dontAsk sits between the allowlist and the trailing prompt", () => {
  for (const kind of ALL_KINDS) {
    for (const model of [null, "claude-opus-4-8"]) {
      const { argv } = buildTransientAgentArgv(kind, { model, prompt: "THE_PROMPT" });
      const permIdx = argv.indexOf("--permission-mode");
      expect(permIdx).toBeGreaterThan(argv.indexOf("--allowedTools"));
      expect(argv[permIdx + 1]).toBe("dontAsk");
      // prompt is the trailing positional, last
      expect(argv[argv.length - 1]).toBe("THE_PROMPT");
      expect(permIdx + 2).toBe(argv.length - 1);
    }
  }
});

test("every kind: never --dangerously-skip-permissions; always --disable-slash-commands + disableAllHooks", () => {
  for (const kind of ALL_KINDS) {
    const { argv } = buildTransientAgentArgv(kind, { model: null, prompt: "p" });
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--bare");
    expect(argv).toContain("--disable-slash-commands");
    expect(settingsOf(argv).disableAllHooks).toBe(true);
  }
});

test("model: omitted → no --model; provided → appended once, before --permission-mode", () => {
  for (const kind of ALL_KINDS) {
    expect(buildTransientAgentArgv(kind, { model: null, prompt: "p" }).argv).not.toContain(
      "--model",
    );
    const argv = buildTransientAgentArgv(kind, { model: "opus", prompt: "p" }).argv;
    const mi = argv.indexOf("--model");
    expect(mi).toBeGreaterThan(-1);
    expect(argv[mi + 1]).toBe("opus");
    expect(mi).toBeLessThan(argv.indexOf("--permission-mode"));
  }
});

test("each call mints a fresh session id, echoed into --session-id", () => {
  const a = buildTransientAgentArgv("reviewer", { model: null, prompt: "p" });
  const b = buildTransientAgentArgv("reviewer", { model: null, prompt: "p" });
  expect(a.sessionId).not.toBe(b.sessionId);
  expect(a.argv[a.argv.indexOf("--session-id") + 1]).toBe(a.sessionId);
});

// ── NUL sanitization: spawn() rejects a NUL in any argv arg (issue #1235) ────────────────────────

test("every kind: a NUL in the prompt is escaped to `\\0`, leaving NO raw NUL anywhere in argv", () => {
  for (const kind of ALL_KINDS) {
    for (const model of [null, "claude-opus-4-8"]) {
      // A composite-key idiom is the canonical way a stray NUL lands in agent-written text.
      const { argv } = buildTransientAgentArgv(kind, {
        model,
        prompt: "keys by `${slug}\0${forkOwner}` when slug is non-null",
      });
      // No argv arg may contain a raw NUL — child_process.spawn would throw on it.
      for (const arg of argv) expect(arg.includes("\0")).toBe(false);
      // The trailing positional carries the visible 2-char escape where the NUL was.
      expect(argv[argv.length - 1]).toBe("keys by `${slug}\\0${forkOwner}` when slug is non-null");
    }
  }
});

test("multiple NULs are each escaped", () => {
  const { argv } = buildTransientAgentArgv("reviewer", { model: null, prompt: "a\0b\0c" });
  expect(argv[argv.length - 1]).toBe("a\\0b\\0c");
  for (const arg of argv) expect(arg.includes("\0")).toBe(false);
});

test("Codex prompts escape NULs with the same argv contract as Claude", () => {
  const { argv } = buildTransientAgentArgv("writer-only", {
    provider: "codex",
    model: "gpt-5.3-codex",
    prompt: "a\0b",
  });
  expect(argv.slice(0, 4)).toEqual(["codex", "exec", "--sandbox", "workspace-write"]);
  expect(argv[argv.length - 1]).toBe("a\\0b");
  for (const arg of argv) expect(arg.includes("\0")).toBe(false);
});

test("NUL-free prompts pass through byte-for-byte unchanged (no spurious escaping)", () => {
  const prompt = "review the plan; key is `${slug}\\0${fork}` (already a literal escape)";
  const { argv } = buildTransientAgentArgv("reviewer", { model: null, prompt });
  expect(argv[argv.length - 1]).toBe(prompt);
});

// ── MCP-isolation coupling: ONE field drives BOTH flags, for every kind ─────────────────────────

test("coupling: --safe-mode ⇔ enableAllProjectMcpServers, for every kind", () => {
  for (const kind of ALL_KINDS) {
    const { argv } = buildTransientAgentArgv(kind, { model: null, prompt: "p" });
    const hasSafeMode = argv.includes("--safe-mode");
    const hasEnableAll = settingsOf(argv).enableAllProjectMcpServers === true;
    // Never one without the other — that's the whole point of modeling it as a single field.
    expect(hasSafeMode).toBe(hasEnableAll);
  }
});

test("coupling: mcpIsolated kinds (reviewer, doc) carry both; writer kinds carry neither", () => {
  for (const kind of ["reviewer", "doc"] as const) {
    const { argv } = buildTransientAgentArgv(kind, { model: null, prompt: "p" });
    expect(argv).toContain("--safe-mode");
    expect(settingsOf(argv).enableAllProjectMcpServers).toBe(true);
  }
  for (const kind of ["writer-ro", "writer-only"] as const) {
    const { argv } = buildTransientAgentArgv(kind, { model: null, prompt: "p" });
    expect(argv).not.toContain("--safe-mode");
    expect(settingsOf(argv).enableAllProjectMcpServers).toBeUndefined();
  }
});

// --safe-mode is a boolean flag and MUST precede the variadic --allowedTools (else it's swallowed).
test("coupling: --safe-mode precedes --allowedTools", () => {
  for (const kind of ["reviewer", "doc"] as const) {
    const { argv } = buildTransientAgentArgv(kind, { model: null, prompt: "p" });
    expect(argv.indexOf("--safe-mode")).toBeLessThan(argv.indexOf("--allowedTools"));
  }
});

// ── settings carry NO env block (thinking-budget env channel retired, issue #1419) ────────────────

test("reviewer --settings never carries an env block (thinking-budget channel retired, #1419)", () => {
  const s = settingsOf(buildTransientAgentArgv("reviewer", { model: null, prompt: "p" }).argv);
  expect(s.env).toBeUndefined();
  // the retirement must not disturb the other reviewer invariants
  expect(s.disableAllHooks).toBe(true);
  expect(s.enableAllProjectMcpServers).toBe(true);
});

// ── Per-kind allowlists ─────────────────────────────────────────────────────────────────────────

const READONLY_GIT = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git status)",
];

test("reviewer allowlist is a CLOSED read-only set (R4): widening it fails the test", () => {
  // Both argv shapes — --model shifts positions and must not leak into the set.
  for (const model of [null, "claude-opus-4-8"]) {
    const { argv } = buildTransientAgentArgv("reviewer", {
      model,
      prompt: "p",
    });
    const tools = extractAllowedTools(argv);
    expect([...tools].sort()).toEqual([...READONLY_GIT, "Write"].sort());
    // explicit negatives for readable failures if widened
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("Bash(*)");
    expect(tools.some((t) => /WebFetch|WebSearch|mcp__/.test(t))).toBe(false);
  }
});

test("doc allowlist = reviewer set + bare Edit (the ONLY widening); no publish/exec tokens", () => {
  const tools = extractAllowedTools(
    buildTransientAgentArgv("doc", { model: null, prompt: "p" }).argv,
  );
  expect([...tools].sort()).toEqual([...READONLY_GIT, "Write", "Edit"].sort());
  for (const t of [
    "Bash(git add *)",
    "Bash(git commit *)",
    "Bash(git push *)",
    "Bash(gh *)",
    "Bash",
    "Bash(*)",
    "WebFetch",
    "WebSearch",
  ]) {
    expect(tools).not.toContain(t);
  }
});

test("writer-ro allowlist = Read, Grep, Glob, Write (read-only inspection + bare Write)", () => {
  const tools = extractAllowedTools(
    buildTransientAgentArgv("writer-ro", { model: null, prompt: "p" }).argv,
  );
  expect([...tools].sort()).toEqual(["Read", "Grep", "Glob", "Write"].sort());
});

test("writer-only allowlist = bare Write only", () => {
  const tools = extractAllowedTools(
    buildTransientAgentArgv("writer-only", { model: null, prompt: "p" }).argv,
  );
  expect(tools).toEqual(["Write"]);
});

// ── api-key auth-mode wiring (the spawn-auth seam stays; --settings folds in apiKeyHelper) ───────

test("subscription mode: --settings carries NO apiKeyHelper, byte-stable per kind", () => {
  withAuth("subscription", "/should/be/ignored.sh", () => {
    expect(
      settingsOf(buildTransientAgentArgv("writer-only", { model: null, prompt: "p" }).argv),
    ).toEqual({
      disableAllHooks: true,
    });
    expect(
      settingsOf(buildTransientAgentArgv("reviewer", { model: null, prompt: "p" }).argv),
    ).toEqual({
      disableAllHooks: true,
      enableAllProjectMcpServers: true,
    });
  });
});

test("api-key mode (configured): apiKeyHelper folded in after existing keys", () => {
  withAuth("api-key", "/helper.sh", () => {
    for (const kind of ALL_KINDS) {
      const s = settingsOf(buildTransientAgentArgv(kind, { model: null, prompt: "p" }).argv);
      expect(s.apiKeyHelper).toBe("/helper.sh");
      expect(s.disableAllHooks).toBe(true);
    }
  });
});

test("api-key mode (unconfigured): no apiKeyHelper key emitted", () => {
  withAuth("api-key", null, () => {
    expect(
      settingsOf(buildTransientAgentArgv("reviewer", { model: null, prompt: "p" }).argv)
        .apiKeyHelper,
    ).toBeUndefined();
  });
});

// ── Byte-identity spot-check: verify-key's historical argv (writer-only + model "haiku") ─────────

test("writer-only + model 'haiku' reproduces verify-key's historical argv shape", () => {
  withAuth("subscription", null, () => {
    const { argv } = buildTransientAgentArgv("writer-only", { model: "haiku", prompt: "SENTINEL" });
    // --allowedTools Write --model haiku --permission-mode dontAsk SENTINEL
    const at = argv.indexOf("--allowedTools");
    expect(argv.slice(at)).toEqual([
      "--allowedTools",
      "Write",
      "--model",
      "haiku",
      "--permission-mode",
      "dontAsk",
      "SENTINEL",
    ]);
  });
});

// ── Codex CLI branch ────────────────────────────────────────────────────────────────────────────
// provider "codex" routes every kind to a headless, workspace-write-sandboxed `codex exec`. The
// file-based result contract is identical, so the caller's verdict reading is unchanged; only the
// argv differs. None of the Claude-only flags (--settings/--safe-mode/--allowedTools) leak.

test("codex provider: every kind → `codex exec --sandbox workspace-write [-m <model>] -o <file> <prompt>`", () => {
  for (const kind of ALL_KINDS) {
    const withModel = buildTransientAgentArgv(kind, {
      provider: "codex",
      model: "gpt-5.5",
      prompt: "DO_IT",
    }).argv;
    // `-o <last-message file>` sits between the config flags and the trailing prompt so Codex writes
    // its final message to a file even when the agent answers in chat instead of writing the result
    // file (see codex-last-message.ts).
    expect(withModel).toEqual([
      "codex",
      "exec",
      "--sandbox",
      "workspace-write",
      "-m",
      "gpt-5.5",
      "-o",
      ".shepherd-last-message.txt",
      "DO_IT",
    ]);
    // No Claude flags leak in.
    for (const flag of [
      "--settings",
      "--allowedTools",
      "--safe-mode",
      "--disable-slash-commands",
    ]) {
      expect(withModel).not.toContain(flag);
    }
    // No model → no -m flag, but the -o pair + trailing prompt remain.
    const noModel = buildTransientAgentArgv(kind, {
      provider: "codex",
      model: null,
      prompt: "DO_IT",
    }).argv;
    expect(noModel).toEqual([
      "codex",
      "exec",
      "--sandbox",
      "workspace-write",
      "-o",
      ".shepherd-last-message.txt",
      "DO_IT",
    ]);
  }
});

test("claude provider (default + explicit) still builds the claude argv", () => {
  expect(buildTransientAgentArgv("reviewer", { model: null, prompt: "p" }).argv[0]).toBe("claude");
  expect(
    buildTransientAgentArgv("reviewer", { provider: "claude", model: null, prompt: "p" }).argv[0],
  ).toBe("claude");
});
