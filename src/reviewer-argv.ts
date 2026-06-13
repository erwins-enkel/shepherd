import { randomUUID } from "node:crypto";

/** Build the argv for a read-only adversarial reviewer agent (PR critic + plan reviewer share it).
 *  Deliberately NOT --dangerously-skip-permissions: the agent inspects UNTRUSTED input (a PR diff
 *  or agent-written plan text), so a prompt-injection hidden there must not be able to run commands
 *  or escape its disposable worktree. `dontAsk` auto-denies anything off the allowlist (an
 *  unattended PTY would otherwise hang on a permission prompt); the allowlist is read-only
 *  inspection + read-only git + writing files in its own disposable worktree. The sandbox is also
 *  MCP-isolated: --safe-mode disables MCP *loading* (file + plugin sources) plus other
 *  customizations, and `enableAllProjectMcpServers` (in --settings) pre-approves the repo's project
 *  .mcp.json so Claude's interactive "N new MCP servers found" approval gate never renders to hang
 *  the unattended pane — that gate is SEPARATE from loading, and dontAsk does not suppress it. */
export function readonlyReviewerArgv(
  model: string | null,
  prompt: string,
  // Optional extended thinking budget. When set, emitted as env.MAX_THINKING_TOKENS in the
  // --settings JSON — the ONLY knob that grants a spawned session's initial positional prompt a
  // thinking budget (the think/ultrathink magic words do NOT fire from it), and a no-op on a
  // non-thinking model. The PR critics pass CRITIC_THINKING_TOKENS; the plan reviewer omits it.
  thinkingTokens?: number,
): { argv: string[]; sessionId: string } {
  // The reviewer's claude session id, forced so the transcript lands at a path we can
  // predict (jsonlPathFor(worktree, sessionId)) — that's how the critic's live tool-use
  // gets surfaced in the UI badge tooltip. Returned to the caller alongside the argv.
  const sessionId = randomUUID();
  // --settings JSON, assembled as an object so the optional thinking budget folds in cleanly.
  // disableAllHooks + enableAllProjectMcpServers are load-bearing (see the flag rationale below);
  // env.MAX_THINKING_TOKENS is added ONLY when a budget is requested (string — env values are).
  const settings: Record<string, unknown> = {
    disableAllHooks: true,
    enableAllProjectMcpServers: true,
  };
  if (thinkingTokens) settings.env = { MAX_THINKING_TOKENS: String(thinkingTokens) };
  const argv = [
    "claude",
    "--session-id",
    sessionId,
    // Run the reviewer in a CLEAN context. It's a fresh `claude` startup, so it
    // would otherwise inherit the user's global hooks + plugins — notably the
    // superpowers SessionStart hook, which injects a forceful "you MUST invoke
    // a skill" preamble. Skill isn't on the allowlist, so dontAsk denies it and
    // the agent thrashes instead of reviewing. disableAllHooks strips every
    // inherited hook (also gsd/herdr/ensure-deps — none of which the reviewer
    // needs); --disable-slash-commands removes skills entirely.
    // NOT --bare: it refuses OAuth/keychain auth (strictly ANTHROPIC_API_KEY),
    // and shepherd runs on subscription OAuth with no API key — --bare would
    // break the reviewer's auth. --settings keeps OAuth while disabling hooks.
    // enableAllProjectMcpServers pre-approves the repo's project .mcp.json so the
    // interactive "new MCP servers found" gate never renders (see the MCP block
    // below for why it's necessary AND why it is COUPLED to --safe-mode).
    "--settings",
    JSON.stringify(settings),
    "--disable-slash-commands",
    // MCP isolation — TWO distinct gates, handled separately.
    // (1) LOADING: a fresh `claude` startup loads MCP servers from three sources —
    // file (.mcp.json / global ~/.claude.json), plugin-bundled, and claude.ai
    // account connectors. --safe-mode disables MCP *loading* from the file + plugin
    // sources (and other customizations — skills/hooks/CLAUDE.md) while keeping
    // Auth/tools/permissions normal — the OAuth-safe alternative to --bare. (It is
    // NOT relied on for claude.ai connector coverage; connectors don't raise the
    // gate below.) Must sit BEFORE --allowedTools: it's a boolean flag and
    // --allowedTools is variadic, swallowing every following token until the next flag.
    // (2) APPROVAL: an unrecognized project .mcp.json triggers Claude's interactive
    // "N new MCP servers found in this project — Select any to enable" gate. This is
    // SEPARATE from loading; --safe-mode does NOT suppress it, dontAsk does NOT
    // suppress it, and it's only auto-skipped in non-interactive (-p) mode (the
    // reviewer is an interactive herdr-pane agent, so NOT skipped). Each review's
    // fresh disposable-worktree path makes the servers look "newly discovered" every
    // time, so the unattended PTY hangs invisibly to the Shepherd UI. Fix:
    // enableAllProjectMcpServers (in --settings above) pre-approves them → nothing is
    // "new" → the gate never renders.
    // COUPLING — DO NOT drop --safe-mode while enableAllProjectMcpServers is true:
    // "enable all" would then auto-LOAD every project MCP server (e.g. a repo's http
    // Notion/Svelte/Sentry) into this UNTRUSTED-input sandbox. Safety rests on two
    // independent axes: --safe-mode (servers don't load — verified) and dontAsk (any
    // MCP tool call is denied off the allowlist). test/reviewer-argv.test.ts asserts
    // both flags travel together.
    // VERSION: the gate-clearing is verified on Claude CLI 2.1.175 and depends on
    // Claude's project-MCP-approval semantics, which no unit test can assert. Re-run
    // the manual repro (temp repo with a committed .mcp.json → reviewer launches with
    // no gate and runs to completion) on every Claude CLI upgrade.
    "--safe-mode",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git show *)",
    "Bash(git status)",
    // Bare `Write` — NOT Write(<path>). Path-scoped Write rules are silently
    // denied under --permission-mode dontAsk (every scoped form fails to match),
    // so a scoped rule would block the verdict write and the reviewer could never
    // finish → timeout. Bare Write is an acceptable widening: the worktree is
    // detached + disposable (removed right after the review) and the agent still
    // can't exec, commit, push, or reach anything outside it (no general Bash,
    // no Edit, no network).
    "Write",
  ];
  if (model) argv.push("--model", model);
  // --permission-mode LAST: `--allowedTools <tools...>` is variadic and eats
  // every following token until the next flag. The task prompt is a trailing
  // positional, so a single-value flag MUST sit between the allowlist and the
  // prompt — otherwise `claude` folds the prompt into the allowlist, launches
  // with no task, and hangs until timeout (every review). Don't reorder.
  argv.push("--permission-mode", "dontAsk");
  argv.push(prompt);
  return { argv, sessionId };
}
