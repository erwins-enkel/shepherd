import { expect, test } from "bun:test";
import { scrubAgentShellEnv } from "../src/agent-shell-env";

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
