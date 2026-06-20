import { randomUUID } from "node:crypto";
import { apiKeySettingsFragment } from "./spawn-auth";

/** Build the argv for the PR-gated doc agent (issue #882, epic #875 Phase 3).
 *
 *  Structurally a sibling of {@link import("./reviewer-argv").readonlyReviewerArgv}: it reuses the
 *  exact hard-won spawn posture (subscription OAuth via --settings, NOT --bare; --safe-mode +
 *  enableAllProjectMcpServers to keep MCP both unloaded AND un-gated; disableAllHooks so an
 *  operator's SessionStart skill-injection can't thrash the unattended pane; --disable-slash-commands;
 *  --permission-mode dontAsk auto-denying anything off the allowlist). It is deliberately NOT
 *  --dangerously-skip-permissions: the agent reasons over recent source changes (untrusted history)
 *  and must not be able to run arbitrary commands or escape its disposable worktree.
 *
 *  The ONLY divergence from the read-only reviewer allowlist is bare `Edit` (the reviewer has bare
 *  `Write` only): the doc agent EDITS existing prose pages. It runs NO git mutation, NO `gh`, NO
 *  network, NO general Bash — the read-only `git diff/log/show/status` is for grounding only. All
 *  publishing (stage / commit / push / open-PR) is done by the trusted Shepherd server in
 *  DocAgentService.finalize(), never by the agent — so "never auto-commits to a published branch" is
 *  enforced by construction, not by prompt discipline. test/doc-agent-argv.test.ts asserts the
 *  absence of every publish/exec token. */
export function docAgentArgv(
  model: string | null,
  prompt: string,
  // Optional extended thinking budget, emitted as env.MAX_THINKING_TOKENS in --settings (the only
  // knob that grants a spawned session's initial positional prompt a thinking budget; a no-op on a
  // non-thinking model). Omitted by default.
  thinkingTokens?: number,
): { argv: string[]; sessionId: string } {
  const sessionId = randomUUID();
  const settings: Record<string, unknown> = {
    disableAllHooks: true,
    enableAllProjectMcpServers: true,
  };
  if (thinkingTokens) settings.env = { MAX_THINKING_TOKENS: String(thinkingTokens) };
  // api-key mode folds in `apiKeyHelper` after the existing keys (stable key order; subscription
  // spreads {} → byte-identical JSON). See spawn-auth + the membrane wiring in doc-agent.ts.
  Object.assign(settings, apiKeySettingsFragment());
  const argv = [
    "claude",
    "--session-id",
    sessionId,
    "--settings",
    JSON.stringify(settings),
    "--disable-slash-commands",
    // --safe-mode disables MCP *loading* (file + plugin sources) and other customizations; it is
    // COUPLED to enableAllProjectMcpServers in --settings (which clears the interactive "N new MCP
    // servers found" approval gate that neither --safe-mode nor dontAsk suppress on an interactive
    // pane). Must sit BEFORE --allowedTools (a boolean flag; the variadic --allowedTools would
    // otherwise swallow it). See reviewer-argv.ts for the full rationale + version caveat.
    "--safe-mode",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    // Read-only git — grounding only (diff recent changes vs current docs). NO add/commit/push.
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git show *)",
    "Bash(git status)",
    // Bare Write + Edit — NOT path-scoped (scoped forms are silently denied under dontAsk). The
    // worktree is disposable and the agent has no exec/commit/push/network, so bare file tools are
    // an acceptable widening. Edit is the sole tool added over the read-only reviewer set.
    "Write",
    "Edit",
  ];
  if (model) argv.push("--model", model);
  // --permission-mode LAST: --allowedTools is variadic and eats every following token until the
  // next flag, so a single-value flag MUST sit between the allowlist and the trailing prompt
  // positional — otherwise the prompt folds into the allowlist and the agent launches with no task.
  argv.push("--permission-mode", "dontAsk");
  argv.push(prompt);
  return { argv, sessionId };
}
