/**
 * Env vars an agent CLI sets for the shell commands it runs: Claude Code's and Codex's
 * "you are inside my tool call" markers. They describe the PARENT agent, not Shepherd.
 */
const AGENT_SHELL_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "AI_AGENT",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
] as const;

/**
 * Drop an agent tool shell's markers from `env` (in place).
 *
 * When Shepherd is started from inside an agent's tool call (a dev run, an agent restarting the
 * server), it inherits those markers — and hands them, through a herdr server it starts, to every
 * session pane. `CLAUDE_CODE_CHILD_SESSION` then turns off Claude Code's transcript saving, and
 * the `NO_COLOR=1` Codex sets for its own plain-text tool output renders every session without
 * colour. `NO_COLOR` goes only when a marker shows it came from such a shell: an operator who sets
 * it on purpose keeps it.
 */
export function scrubAgentShellEnv(env: Record<string, string | undefined>): void {
  const inherited = AGENT_SHELL_MARKERS.some((name) => env[name] !== undefined);
  for (const name of AGENT_SHELL_MARKERS) delete env[name];
  if (inherited) delete env.NO_COLOR;
}
