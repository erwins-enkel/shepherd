import { randomUUID } from "node:crypto";

/** Build the argv for a read-only adversarial reviewer agent (PR critic + plan reviewer share it).
 *  Deliberately NOT --dangerously-skip-permissions: the agent inspects UNTRUSTED input (a PR diff
 *  or agent-written plan text), so a prompt-injection hidden there must not be able to run commands
 *  or escape its disposable worktree. `dontAsk` auto-denies anything off the allowlist (an
 *  unattended PTY would otherwise hang on a permission prompt); the allowlist is read-only
 *  inspection + read-only git + writing files in its own disposable worktree. */
export function readonlyReviewerArgv(model: string | null, prompt: string): string[] {
  const argv = [
    "claude",
    "--session-id",
    randomUUID(),
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
    "--settings",
    '{"disableAllHooks":true}',
    "--disable-slash-commands",
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
  return argv;
}
