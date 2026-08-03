#!/usr/bin/env node
// Shepherd's PreToolUse tool guard (issue #2002).
//
// Two hazards used to ride EVERY spawn as ~2.2 KB of standing prompt text — the shared-`refs/stash`
// data-loss footgun (#1632) and the tmpfs inode exhaustion that bricks a session (#1862). Both are
// warnings about actions most sessions never take, so they are delivered here instead: as a
// `PreToolUse` denial at the call site, with the explanation attached to the refusal.
//
// Plain `.mjs` on purpose (same pattern as scripts/json-union-merge.mjs + .d.mts): Claude Code runs
// it as a `command` hook, and the interpreter is the node binary the sandbox membrane ALREADY binds
// (`config.nodeBin`). A TS entrypoint would need a second interpreter bound into every membrane.
//
// Every rule FAILS OPEN: anything unparseable, unknown, or merely suspicious returns no decision, so
// the guard can never wedge a session. It only ever blocks the two shapes it positively recognizes.

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Reason attached to a denied `git stash` — the content of the retired worktree-stash notice. */
export const STASH_REASON =
  "Blocked by Shepherd: `refs/stash` is a SINGLE stack shared across every worktree of this repo, " +
  "so a bare `git stash` / `pop` / `drop` in one session can grab or discard another concurrent " +
  "session's entry. To inspect or diff base state without touching the working tree, use " +
  "`git show <ref>:<path>`, `git diff <ref>`, or a throwaway `git worktree add`. To shelve local " +
  "changes, use `git stash create` — it prints a commit SHA WITHOUT writing the shared stack " +
  "(tracked changes only; untracked files are not saved) — record that SHA and restore it later " +
  "with `git stash apply <sha>`. Never `git stash store`: it writes the same shared stack.";

/** Reason attached to a denied worktree-add under a tmpfs root (retired tmpfs notice, part 1). */
export function worktreeTmpfsReason(path) {
  return (
    `Blocked by Shepherd: \`${path}\` is on a small tmpfs with a HARD INODE CAP, independent of ` +
    "its byte size. A git worktree there exhausts the inode table, after which every write fails " +
    "with ENOSPC while `df -h` still shows plenty of free space (`df -i` is what shows the real " +
    "cause). Put the worktree on the SAME filesystem as the repo instead — never under the " +
    "scratchpad, $TMPDIR, or /tmp."
  );
}

/** Reason attached to a denied dependency install under a tmpfs root (retired notice, part 2). */
export function installTmpfsReason(path) {
  return (
    `Blocked by Shepherd: this would install dependencies under \`${path}\`, which is on a small ` +
    "tmpfs with a HARD INODE CAP. A package manager must keep its content-addressable store on the " +
    "SAME filesystem as the install target so it can hardlink, so it forks a second store there — " +
    "hundreds of thousands of tiny files that exhaust the tmpfs INODE table. Every subsequent write " +
    "then fails with ENOSPC while `df -h` still shows free space (`df -i` shows the real cause). " +
    "Run the install inside the repo worktree instead."
  );
}

/**
 * Injected (not denied) when the agent is about to open a pull request. This is the deterministic
 * backstop for the `shepherd-pull-requests` skill: a skill only loads if the model reaches for it,
 * whereas this fires on the exact call that matters, so the two invariants that used to sit in the
 * standing prompt still bind even when the skill is never opened.
 */
export const PR_CREATE_CONTEXT =
  "Shepherd: this session tracks exactly ONE pull request — open this one and no second one, even " +
  "if the task describes multiple parts. Work too large for one PR? Promote the issue to an epic " +
  "(children + `#<n>` markers in the parent body, no PR from you), or ship this slice and " +
  "`gh issue create` a follow-up. Before opening it, declare any MANUAL OPERATOR STEPS the change " +
  "implies (feature flag, env var, backfill, restart, DNS, seeded record) in the PR body — either " +
  "a ```shepherd:manual-steps``` fenced block of `- [ ]` lines or column-0 `Manual-Step:` trailer " +
  "lines, prefixed `POST-MERGE:` when they must happen after merge. Most PRs need NONE: declare " +
  "nothing rather than inventing one, and use `gh pr edit --body` if you only notice one later. " +
  "The `shepherd-pull-requests` skill has the full rules.";

/**
 * Injected when a Bash call is backgrounded. A detached job reparents to PID 1 and outlives the
 * session — the hazard the standing posture block used to carry for every session, delivered here
 * only to the calls that can actually create it.
 */
export const BACKGROUND_CONTEXT =
  "Shepherd: this call backgrounds a process, which reparents to PID 1 and outlives your session " +
  "(silently burning CPU for days). Kill what you spawn from the SAME shell once the step that " +
  "needs it is done, or wrap it in a throwaway script whose `trap` reaps its jobs on exit.";

/** Package managers whose install/add/ci subcommands materialize a dependency tree. */
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
/** Subcommands of those that write a node_modules tree (`yarn` with no subcommand also installs). */
const INSTALL_SUBCOMMANDS = new Set(["install", "add", "ci", "i"]);
/** `git stash` subcommands that READ the shared stack without mutating it. */
const SAFE_STASH_SUBCOMMANDS = new Set(["list", "show", "create"]);

/** Tmpfs roots a worktree or install must never land under. `env.TMPDIR` is Shepherd's own
 *  per-session scratchpad pin (#560); the rest are the standard host tmpfs mounts. */
export function tmpfsRoots(env = {}) {
  const roots = ["/tmp", "/var/tmp", "/dev/shm"];
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    const v = env[key];
    if (typeof v === "string" && v.startsWith("/")) roots.push(v);
  }
  return [...new Set(roots.map((r) => r.replace(/\/+$/, "") || "/"))];
}

/** True when `path` IS one of `roots` or sits underneath one. */
function underAny(path, roots) {
  const p = path.replace(/\/+$/, "") || "/";
  return roots.some((root) => p === root || p.startsWith(`${root}/`));
}

/** Strip one layer of surrounding quotes from a shell word (the guard never evaluates a word;
 *  it only needs the literal path a quoted arg denotes). */
function unquote(word) {
  const m = /^(['"])(.*)\1$/.exec(word);
  return m ? m[2] : word;
}

/** Split a command line into pipeline/list segments. Deliberately naive — a quoted `&&` splits a
 *  segment early, which can only ever make a rule see LESS, never more (fail open). */
function segments(command) {
  return command
    .split(/\r?\n|&&|\|\||[;&|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tokenize a segment and drop the parts that never carry meaning for these rules: leading `sudo`,
 *  `command`, and `FOO=bar` env assignments. Returns [] for an empty segment. */
function words(segment) {
  const raw = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (
    i < raw.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[i]) || raw[i] === "sudo" || raw[i] === "command")
  )
    i++;
  return raw.slice(i);
}

/** git's global options that consume the FOLLOWING word (`git -C <path> stash` must still read as
 *  a stash invocation, not as an operand list starting with the path). */
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

/** Positional operands of a `git` invocation: global flags (and their values) removed. */
function gitOperands(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (GIT_GLOBAL_VALUE_FLAGS.has(a)) {
      i++; // skip its value
      continue;
    }
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

/** Resolve `arg` against `cwd`, tolerating `~` and a missing/relative cwd (fail open → null). */
function resolvePath(arg, cwd) {
  const a = unquote(arg);
  if (a.startsWith("~")) return null; // shell-expanded, not ours to guess
  if (isAbsolute(a)) return resolve(a);
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  return resolve(cwd, a);
}

/** The `git stash` invocations that touch the SHARED stack. `create`/`list`/`show` never do, and
 *  `apply <sha>` is the sanctioned recovery path — but a bare `apply` (or `apply stash@{n}`) reads
 *  the shared stack by index and is therefore denied like the rest. */
function stashTouchesSharedStack(args) {
  const rest = args.filter((a) => !a.startsWith("-"));
  const sub = rest[0];
  if (sub && SAFE_STASH_SUBCOMMANDS.has(sub)) return false;
  if (sub === "apply") {
    const target = rest[1];
    return target === undefined || target.startsWith("stash@{");
  }
  return true; // bare `git stash`, push, save, pop, drop, clear, store, branch
}

/**
 * Decide what to do about one `PreToolUse` event. Returns `null` for "no opinion" (the normal
 * permission flow applies), or the `hookSpecificOutput` payload minus its `hookEventName`.
 *
 * `event` is the raw hook body; `env` supplies the tmpfs roots (defaults to none beyond the
 * standard host mounts). Pure — no filesystem, no process state.
 */
export function decideToolGuard(event, env = {}) {
  if (!event || typeof event !== "object") return null;
  if (event.tool_name !== "Bash") return null;
  const input = event.tool_input;
  if (!input || typeof input !== "object") return null;
  const command = typeof input.command === "string" ? input.command : "";
  if (!command.trim()) return null;

  const denial = denyFor(command, event.cwd, tmpfsRoots(env));
  if (denial) return denial;
  if (opensPullRequest(command)) return { additionalContext: PR_CREATE_CONTEXT };
  if (isBackgrounded(input, command)) return { additionalContext: BACKGROUND_CONTEXT };
  return null;
}

/** True when any segment of `command` opens a pull request. */
function opensPullRequest(command) {
  return segments(command).some((segment) => {
    const w = words(segment);
    if (w[0] !== "gh") return false;
    const operands = w.slice(1).filter((a) => !a.startsWith("-"));
    return operands[0] === "pr" && operands[1] === "create";
  });
}

/** True when the call detaches a process: the explicit tool flag, or a trailing `&` (but not the
 *  `&&` operator, which `segments` has already split on). */
function isBackgrounded(input, command) {
  return input.run_in_background === true || /(^|[^&])&\s*$/.test(command.trim());
}

/** The denial rules — the two hazards this guard exists to stop. `null` = nothing recognized. */
function denyFor(command, eventCwd, roots) {
  let cwd = typeof eventCwd === "string" ? eventCwd : undefined;

  for (const segment of segments(command)) {
    const w = words(segment);
    if (w.length === 0) continue;
    const [cmd, ...args] = w;

    // `cd <path>` moves the effective directory for every LATER segment of the same command line.
    if (cmd === "cd") {
      const target = args.find((a) => !a.startsWith("-"));
      const next = target ? resolvePath(target, cwd) : undefined;
      cwd = next ?? cwd;
      continue;
    }

    if (cmd === "git") {
      const sub = gitOperands(args);
      if (sub[0] === "stash" && stashTouchesSharedStack(sub.slice(1))) {
        return { permissionDecision: "deny", permissionDecisionReason: STASH_REASON };
      }
      if (sub[0] === "worktree" && sub[1] === "add") {
        // EVERY operand after `add`, not just the first: a flag's VALUE survives the flag filter
        // (`git worktree add -b feat /tmp/x` leaves `feat` in front of the real path), so checking
        // only sub[2] would miss the hazard. A branch name never resolves under a tmpfs root
        // unless the cwd already is one — which is itself the condition being denied.
        for (const operand of sub.slice(2)) {
          const path = resolvePath(operand, cwd);
          if (path && underAny(path, roots)) {
            return {
              permissionDecision: "deny",
              permissionDecisionReason: worktreeTmpfsReason(path),
            };
          }
        }
      }
      continue;
    }

    if (PACKAGE_MANAGERS.has(cmd)) {
      const sub = args.filter((a) => !a.startsWith("-"));
      const installs = sub.length === 0 ? cmd === "yarn" : INSTALL_SUBCOMMANDS.has(sub[0]);
      if (installs && typeof cwd === "string" && underAny(cwd, roots)) {
        return { permissionDecision: "deny", permissionDecisionReason: installTmpfsReason(cwd) };
      }
    }
  }
  return null;
}

/** Wrap a decision in the `hookSpecificOutput` envelope Claude Code reads, or `null` for silence. */
export function hookOutput(decision) {
  if (!decision) return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } };
}

/** Read all of stdin as text (the hook body arrives there). */
function readStdin() {
  return new Promise((done) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => done(buf));
    process.stdin.on("error", () => done(""));
  });
}

/** CLI entry: body on stdin, decision on stdout, always exit 0 (a non-zero exit would surface as a
 *  hook error to the agent; silence is the correct "no opinion" signal). */
async function main() {
  let out = null;
  try {
    out = hookOutput(decideToolGuard(JSON.parse(await readStdin()), process.env));
  } catch {
    out = null; // fail open on malformed input — never block on a parse error
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
