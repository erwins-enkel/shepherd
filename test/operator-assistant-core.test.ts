import { expect, test } from "bun:test";
import {
  buildOperatorAssistantArgv,
  isOperatorAssistant,
  operatorAssistantBrief,
  operatorAssistantPermissions,
  type OperatorAssistantArgvOpts,
} from "../src/operator-assistant-core";
import { operatorLanguageBlock } from "../src/operator-language";

const BASE: OperatorAssistantArgvOpts = {
  installRoot: "/opt/shepherd",
  resume: false,
  claudeSessionId: "11111111-2222-3333-4444-555555555555",
  settings: '{"s":1}',
  mcpConfig: '{"m":1}',
  brief: "BRIEF",
  model: null,
  effort: null,
};

test("isOperatorAssistant is true only for a flagged row and is null-safe", () => {
  expect(isOperatorAssistant({ operatorAssistant: true })).toBe(true);
  expect(isOperatorAssistant({ operatorAssistant: false })).toBe(false);
  expect(isOperatorAssistant({})).toBe(false);
  expect(isOperatorAssistant(null)).toBe(false);
  expect(isOperatorAssistant(undefined)).toBe(false);
});

test("argv: exact flag order for a fresh conversation, no model/effort flags when unset", () => {
  expect(buildOperatorAssistantArgv(BASE)).toEqual([
    "claude",
    "--add-dir",
    "/opt/shepherd",
    "--session-id",
    BASE.claudeSessionId,
    "--setting-sources",
    "project,local",
    "--settings",
    '{"s":1}',
    "--strict-mcp-config",
    "--mcp-config",
    '{"m":1}',
    "--permission-mode",
    "default",
    "--append-system-prompt",
    "BRIEF",
  ]);
});

test("argv: --add-dir is variadic, so the token after its value is always a flag", () => {
  for (const resume of [false, true]) {
    const argv = buildOperatorAssistantArgv({ ...BASE, resume });
    const i = argv.indexOf("--add-dir");
    expect(i).toBe(1);
    expect(argv[i + 2]!.startsWith("--")).toBe(true);
  }
});

test("argv: resume swaps --session-id for --resume <claudeSessionId> in the same slot", () => {
  const argv = buildOperatorAssistantArgv({ ...BASE, resume: true, claudeSessionId: "abc" });
  expect(argv.slice(3, 5)).toEqual(["--resume", "abc"]);
  expect(argv).not.toContain("--session-id");
});

test("argv: model and effort ride last, only when set; an unknown effort emits nothing", () => {
  expect(buildOperatorAssistantArgv({ ...BASE, model: "opus", effort: "high" }).slice(-4)).toEqual([
    "--model",
    "opus",
    "--effort",
    "high",
  ]);
  expect(buildOperatorAssistantArgv({ ...BASE, effort: "bogus" })).not.toContain("--effort");
});

test("argv: no skip-permissions, no agent skills, no prompt positional", () => {
  const argv = buildOperatorAssistantArgv({ ...BASE, model: "opus", effort: "high" });
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(argv).not.toContain("--plugin-dir");
  // Every value follows a flag: the argv is flag/value pairs plus the lone --strict-mcp-config.
  const positional = argv.filter(
    (tok, i) => i > 0 && !tok.startsWith("--") && !argv[i - 1]!.startsWith("--"),
  );
  expect(positional).toEqual([]);
});

test("permissions: exact shape — MCP the only allow, Bash asks, edits and credentials denied", () => {
  expect(operatorAssistantPermissions()).toEqual({
    defaultMode: "default",
    allow: ["mcp__shepherd"],
    ask: ["Bash"],
    deny: [
      "Edit",
      "Write",
      "NotebookEdit",
      "Read(~/.shepherd/env)",
      "Read(~/.config/shepherd/config.toml)",
      "Read(~/.claude/.credentials.json)",
      "Read(~/.codex/auth.json)",
      "Read(~/.config/gh/hosts.yml)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.config/gcloud/**)",
      "Read(~/.azure/**)",
      "Read(~/.netrc)",
      "Read(~/.git-credentials)",
      "Read(~/.docker/config.json)",
      "Read(~/.kube/config)",
    ],
  });
});

const brief = (language: "en" | "de" = "en") =>
  operatorAssistantBrief({
    installRoot: "/opt/shepherd",
    assistantDir: "/home/op/.shepherd/assistant",
    language,
  });

test("brief names every diagnostic tool", () => {
  for (const tool of ["herd_status", "repo_automation", "system_health", "logs_tail"])
    expect(brief()).toContain(tool);
});

test("brief points at the install root and the docs/source to read there", () => {
  const b = brief();
  expect(b).toContain("/opt/shepherd");
  expect(b).toContain("/home/op/.shepherd/assistant");
  for (const path of ["README.md", "PRD.md", "docs/", "docs-site/src/content/docs/", "src/"])
    expect(b).toContain(path);
});

test("brief covers the five #1446 symptoms", () => {
  const b = brief();
  expect(b).toContain('planPhase "planning"'); // herds stop at the plan gate
  expect(b).toContain("autoDrainEnabled off"); // epic label-drain paused
  expect(b).toContain("code: 127"); // agent died: PATH gap
  expect(b).toContain("ENOENT"); // herdr server not running
  expect(b).toContain("PSI"); // host saturation
  expect(b).toContain("Repo automation settings → Auto-Drain"); // the real UI path
});

test("brief carries the guardrails", () => {
  const b = brief();
  expect(b).toContain("Read-only");
  expect(b).toContain("⟦UNTRUSTED:");
  expect(b).toContain("designation");
});

test("brief contains no environment values", () => {
  const prev = process.env.SHEPHERD_PASSWORD;
  process.env.SHEPHERD_PASSWORD = "planted-secret-7f3a";
  try {
    const b = brief();
    expect(b).not.toContain("planted-secret-7f3a");
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("SHEPHERD_") && value && value.length >= 8) expect(b).not.toContain(value);
    }
  } finally {
    if (prev === undefined) delete process.env.SHEPHERD_PASSWORD;
    else process.env.SHEPHERD_PASSWORD = prev;
  }
});

test("brief appends the operator-language block only for a non-English operator", () => {
  expect(brief("en")).not.toContain("<operator-language>");
  expect(brief("de").endsWith(operatorLanguageBlock("de")!)).toBe(true);
});
