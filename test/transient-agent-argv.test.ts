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

test.each(["xhigh", "max", "ultra"])("Codex effort routes %s unchanged to the CLI", (effort) => {
  const { argv } = buildTransientAgentArgv("reviewer", {
    provider: "codex",
    model: "gpt-5.5",
    prompt: "P",
    effort,
  });
  // `-c` is repeatable and the isolation block already spends one (the project-doc re-assert), so
  // the effort override is the LAST one — indexOf would find the wrong pair.
  const cIdx = argv.lastIndexOf("-c");
  expect(cIdx).toBeGreaterThan(-1);
  expect(argv[cIdx + 1]).toBe(`model_reasoning_effort=${effort}`);
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

// The fullscreen-renderer upsell is a BLOCKING dialog an operator-less pane can never answer, and
// its suppression counter only advances when it IS answered — so every transient kind must carry
// the `tui` settings kill-switch, in BOTH auth modes (api-key mode spawns against a separate
// CLAUDE_CONFIG_DIR whose .claude.json has no counter at all, i.e. the worst case).
test("every kind: --settings pins tui:'default' (upsell kill-switch), in both auth modes", () => {
  for (const mode of ["subscription", "api-key"] as const) {
    withAuth(mode, "/helper.sh", () => {
      for (const kind of ALL_KINDS) {
        const { argv } = buildTransientAgentArgv(kind, { model: null, prompt: "p" });
        expect(settingsOf(argv).tui).toBe("default");
      }
    });
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
      tui: "default",
    });
    expect(
      settingsOf(buildTransientAgentArgv("reviewer", { model: null, prompt: "p" }).argv),
    ).toEqual({
      disableAllHooks: true,
      tui: "default",
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

// The full leading block every Codex role argv carries: the sandbox pair, the `--thread-source`
// classification (#2136), then the config-isolation flags (#2134) — the Codex peer of Claude's
// disableAllHooks + --disable-slash-commands + --safe-mode. Spelled out here BY HAND, exactly like
// READONLY_GIT above: importing it from src would derive the expectation from the implementation
// and turn this byte-identity gate into a tautology.
const CODEX_PREFIX = [
  "codex",
  "exec",
  "--sandbox",
  "workspace-write",
  "--thread-source",
  "shepherd_role",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  "-c",
  'project_doc_fallback_filenames=["CLAUDE.md"]',
];

// The `-o` last-message file lets Codex write its final message to a file even when the agent answers
// in chat instead of writing the result file (see codex-last-message.ts). It is OPT-IN — emitted only
// when the caller sets `captureLastMessage` (i.e. the role READS the fallback). When set, the name
// matches the kind's trust posture: `reviewer` (untrusted checkout) → a PER-SPAWN unguessable name;
// every other kind (disposable tmpdir) → the fixed name.

test("codex: every role carries the explicit shepherd thread source", () => {
  for (const kind of ALL_KINDS) {
    const { argv } = buildTransientAgentArgv(kind, {
      provider: "codex",
      model: "gpt-5.5",
      prompt: "DO_IT",
    });
    const sourceIdx = argv.indexOf("--thread-source");
    expect(sourceIdx).toBeGreaterThan(-1);
    expect(argv[sourceIdx + 1]).toBe("shepherd_role");
    expect(argv.lastIndexOf("--thread-source")).toBe(sourceIdx);
  }
});

test("codex: NO `-o` unless captureLastMessage is set (opt-in; default off for every kind)", () => {
  for (const kind of ALL_KINDS) {
    const { argv } = buildTransientAgentArgv(kind, {
      provider: "codex",
      model: "gpt-5.5",
      prompt: "DO_IT",
    });
    // Roles that never read the fallback (namer, verify-key, doc-agent) get this shape → no `-o`, so
    // no Codex `-o`/version-floor dependency and no fixed target a committed symlink could redirect.
    expect(argv).not.toContain("-o");
    expect(argv.some((a) => a.startsWith(".shepherd-last-message"))).toBe(false);
    expect(argv).toEqual([...CODEX_PREFIX, "-m", "gpt-5.5", "DO_IT"]);
  }
});

test("codex + captureLastMessage → reviewer PER-SPAWN `-o`, other kinds the fixed `-o`", () => {
  for (const kind of ALL_KINDS) {
    const withModel = buildTransientAgentArgv(kind, {
      provider: "codex",
      model: "gpt-5.5",
      prompt: "DO_IT",
      captureLastMessage: true,
    });
    const name =
      kind === "reviewer"
        ? `.shepherd-last-message-${withModel.sessionId}.txt`
        : ".shepherd-last-message.txt";
    if (kind === "reviewer") {
      expect(name).not.toBe(".shepherd-last-message.txt"); // genuinely per-spawn
    }
    expect(withModel.argv).toEqual([...CODEX_PREFIX, "-m", "gpt-5.5", "-o", name, "DO_IT"]);
    // No Claude flags leak in.
    for (const flag of [
      "--settings",
      "--allowedTools",
      "--safe-mode",
      "--disable-slash-commands",
    ]) {
      expect(withModel.argv).not.toContain(flag);
    }
    // No model → no -m flag, but the -o pair + trailing prompt remain.
    const noModel = buildTransientAgentArgv(kind, {
      provider: "codex",
      model: null,
      prompt: "DO_IT",
      captureLastMessage: true,
    });
    const nName =
      kind === "reviewer"
        ? `.shepherd-last-message-${noModel.sessionId}.txt`
        : ".shepherd-last-message.txt";
    expect(noModel.argv).toEqual([...CODEX_PREFIX, "-o", nName, "DO_IT"]);
  }
});

// ── Config isolation (issue #2134) ───────────────────────────────────────────────────────────────
// The Codex peer of the Claude "always --disable-slash-commands + disableAllHooks" test. Uniform
// across every kind: unlike Claude's per-kind mcpIsolated split, Codex has no --allowedTools to make
// a loaded MCP server inert, so dropping the user config is the only lever and every kind gets it.

test("codex: every kind carries the full leading block — sandbox, thread source, isolation", () => {
  for (const kind of ALL_KINDS) {
    for (const model of [null, "gpt-5.5"]) {
      for (const capture of [false, true]) {
        const { argv } = buildTransientAgentArgv(kind, {
          provider: "codex",
          model,
          prompt: "DO_IT",
          captureLastMessage: capture,
        });
        expect(argv.slice(0, CODEX_PREFIX.length)).toEqual(CODEX_PREFIX);
      }
    }
  }
});

// --ignore-user-config drops $CODEX_HOME/config.toml, so the tmpdir kinds would otherwise die at
// spawn on "Not inside a trusted directory" — the trust entries live in the file we stopped loading.
// This flag is a REQUIREMENT of the isolation, not a nicety; losing it silently breaks recap, namer,
// verify-key, autopilot, distiller, optimizer, merge-suggest and task-shape.
test("codex: --skip-git-repo-check accompanies --ignore-user-config for every kind", () => {
  for (const kind of ALL_KINDS) {
    const { argv } = buildTransientAgentArgv(kind, { provider: "codex", model: null, prompt: "p" });
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toContain("--ignore-rules");
    expect(argv).toContain("--skip-git-repo-check");
  }
});

// --ephemeral would suppress the rollout files role activity + token totals are read from
// (codex-activity.ts, #1816); --dangerously-bypass-hook-trust GRANTS hooks without trust, the
// opposite of isolation. Neither may ever appear — the Codex peer of the Claude
// "never --dangerously-skip-permissions" negative.
test("codex: never --ephemeral, never a dangerously-bypass flag, for any kind", () => {
  for (const kind of ALL_KINDS) {
    for (const capture of [false, true]) {
      const { argv } = buildTransientAgentArgv(kind, {
        provider: "codex",
        model: "gpt-5.5",
        prompt: "p",
        effort: "high",
        captureLastMessage: capture,
      });
      for (const flag of [
        "--ephemeral",
        "--dangerously-bypass-hook-trust",
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        "--output-schema",
      ]) {
        expect(argv).not.toContain(flag);
      }
    }
  }
});

// A Claude role reads the repo's CLAUDE.md; re-asserting the fallback keeps the Codex role at parity
// instead of trading one asymmetry for another. `-c` is repeatable, so this must not collide with the
// effort override — and the re-assert must come FIRST so the optional tail keeps its relative order.
test("codex: both -c uses coexist, project-doc re-assert before the effort override", () => {
  const { argv } = buildTransientAgentArgv("reviewer", {
    provider: "codex",
    model: "gpt-5.5",
    prompt: "p",
    effort: "high",
  });
  const cIdx = argv.reduce<number[]>((acc, a, i) => (a === "-c" ? [...acc, i] : acc), []);
  expect(cIdx).toHaveLength(2);
  expect(argv[cIdx[0]! + 1]).toBe('project_doc_fallback_filenames=["CLAUDE.md"]');
  expect(argv[cIdx[1]! + 1]).toBe("model_reasoning_effort=high");
  expect(cIdx[0]!).toBeLessThan(argv.indexOf("-m"));
  // The prompt stays the trailing positional — the one hard ordering rule on the Codex side.
  expect(argv.at(-1)).toBe("p");
});

// The uniformity itself is the invariant: a future per-kind carve-out has to break this test on
// purpose, the way the Claude mcpIsolated coupling test guards its own split.
test("codex: the isolation block is byte-identical across all four kinds", () => {
  const prefixes = ALL_KINDS.map((kind) =>
    buildTransientAgentArgv(kind, { provider: "codex", model: null, prompt: "p" }).argv.slice(
      0,
      CODEX_PREFIX.length,
    ),
  );
  for (const prefix of prefixes) expect(prefix).toEqual(prefixes[0]!);
});

test("claude provider (default + explicit) still builds the claude argv", () => {
  expect(buildTransientAgentArgv("reviewer", { model: null, prompt: "p" }).argv[0]).toBe("claude");
  expect(
    buildTransientAgentArgv("reviewer", { provider: "claude", model: null, prompt: "p" }).argv[0],
  ).toBe("claude");
});

// ── addDirs (--add-dir, issue #2158) ──────────────────────────────────────────
// The ONLY thing that grants a temp-cwd helper file access to a repo; the allowlist does not.

test("addDirs emits --add-dir before --settings, never after the trailing prompt", () => {
  for (const kind of ALL_KINDS) {
    const { argv, sessionId } = buildTransientAgentArgv(kind, {
      model: "opus",
      prompt: "DO_IT",
      addDirs: ["/repo/one", "/repo/two"],
    });
    expect(argv.slice(0, 7)).toEqual([
      "claude",
      "--session-id",
      sessionId,
      "--add-dir",
      "/repo/one",
      "/repo/two",
      "--settings",
    ]);
    // The flag is variadic: anything after it up to the next flag is read as a directory, so the
    // prompt positional must stay last and far away from it.
    expect(argv.indexOf("--add-dir")).toBeLessThan(argv.indexOf("--settings"));
    expect(argv.at(-1)).toBe("DO_IT");
  }
});

test("no addDirs (or an empty one) leaves every kind's argv byte-identical", () => {
  for (const kind of ALL_KINDS) {
    const sessionId = "fixed-session-id";
    const base = buildTransientAgentArgv(kind, { model: "opus", prompt: "DO_IT", sessionId });
    const empty = buildTransientAgentArgv(kind, {
      model: "opus",
      prompt: "DO_IT",
      sessionId,
      addDirs: [],
    });
    expect(empty.argv).toEqual(base.argv);
    expect(base.argv).not.toContain("--add-dir");
  }
});

test("codex ignores addDirs (workspace-write restricts writes and network, not reads)", () => {
  const { argv } = buildTransientAgentArgv("writer-ro", {
    provider: "codex",
    model: "gpt-5.5",
    prompt: "DO_IT",
    addDirs: ["/repo/one"],
  });
  expect(argv).not.toContain("--add-dir");
  expect(argv).not.toContain("/repo/one");
});
