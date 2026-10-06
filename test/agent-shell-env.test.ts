import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENT_SHELL_MARKERS, scrubAgentShellEnv } from "../src/agent-shell-env";

test("drops agent tool-shell markers and the NO_COLOR they came with", () => {
  const env: Record<string, string | undefined> = {
    PATH: "/usr/bin",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CLAUDE_CODE_OAUTH_TOKEN: "kept",
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CODEX_CI: "1",
    NO_COLOR: "1",
  };
  scrubAgentShellEnv(env);
  expect(env).toEqual({
    PATH: "/usr/bin",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CLAUDE_CODE_OAUTH_TOKEN: "kept",
  });
});

test("keeps an operator's own NO_COLOR outside an agent shell", () => {
  const env: Record<string, string | undefined> = { NO_COLOR: "1" };
  scrubAgentShellEnv(env);
  expect(env).toEqual({ NO_COLOR: "1" });
});

// Native launches must remove every marker the server removes, before they can
// reach a restarted backend or its runner children. Swift behavioral tests cover
// the resulting environments, including env-file overrides and NO_COLOR.
test("native child environment strips the complete shared agent marker list", () => {
  const source = readFileSync(
    new URL(
      "../native/Sources/ShepherdKit/LocalServer/LocalServerEnvironment.swift",
      import.meta.url,
    ),
    "utf8",
  );
  const block = source.match(/let markers: Set<String> = \[([\s\S]*?)\];?/);
  expect(block).not.toBeNull();
  const names = [...block![1]!.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]);
  expect(names.sort()).toEqual([...AGENT_SHELL_MARKERS].sort());
});
