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
// That contract is why `segments()` below is quoting- and heredoc-aware rather than a plain split:
// a hazard MENTIONED as data (in a commit message, a PR body, a heredoc) must never read as one
// INVOKED, and an ambiguous command line must produce no decision at all.

import { realpathSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
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
    `Blocked by Shepherd: \`${path}\` is on a memory-backed filesystem (tmpfs) with a HARD INODE ` +
    "CAP, independent of its byte size. A git worktree there exhausts the inode table, after which " +
    "every write fails with ENOSPC while `df -h` still shows plenty of free space (`df -i` is what " +
    "shows the real cause). Put the worktree on a disk-backed filesystem instead — your `$TMPDIR` " +
    "is one (Shepherd points it at a disk-backed scratch dir for exactly this reason), as is the " +
    "repo's own filesystem."
  );
}

/** Reason attached to a denied dependency install under a tmpfs root (retired notice, part 2). */
export function installTmpfsReason(path) {
  return (
    `Blocked by Shepherd: this would install dependencies under \`${path}\`, which is on a ` +
    "memory-backed filesystem (tmpfs) with a HARD INODE CAP. A package manager must keep its " +
    "content-addressable store on the SAME filesystem as the install target so it can hardlink, so " +
    "it forks a second store there — hundreds of thousands of tiny files that exhaust the tmpfs " +
    "INODE table. Every subsequent write then fails with ENOSPC while `df -h` still shows free " +
    "space (`df -i` shows the real cause). Run the install in the repo worktree, or under your " +
    "`$TMPDIR` (Shepherd points it at a disk-backed scratch dir for exactly this reason)."
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

/** `statfs` magic numbers for the memory-backed filesystems whose inode table this rule protects. */
const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;

/**
 * Is `path` REALLY on a memory-backed filesystem? Asked of the kernel, not guessed from the path.
 *
 * Deliberately NOT a path allow/deny list, and emphatically NOT `$TMPDIR`: Shepherd points every
 * spawned agent's `TMPDIR` at the DISK-backed `agentTmpDir()` (`~/.cache/shepherd/tmp`, see
 * src/tmp-sweep.ts, #1875) precisely SO THAT worktrees and dependency installs can land there
 * safely. Treating `$TMPDIR` as a deny-root inverted that: it hard-blocked the exact location
 * Shepherd redirects agents to, with a reason falsely claiming the path was tmpfs. Asking statfs
 * makes the denial true by construction — and keeps the reason text honest — on any host layout.
 *
 * A path that does not exist yet (`git worktree add <new dir>`) is answered from its nearest
 * existing ancestor, which is the filesystem it would be created on. Any error → `false`, matching
 * the module's fail-open contract.
 */
export function isTmpfsPath(path, statfs = statfsSync) {
  let p = resolve(path);
  for (;;) {
    try {
      const { type } = statfs(p);
      return type === TMPFS_MAGIC || type === RAMFS_MAGIC;
    } catch {
      const parent = dirname(p);
      if (parent === p) return false; // reached "/" without a readable answer
      p = parent;
    }
  }
}

/** Strip one layer of surrounding quotes from a shell word (the guard never evaluates a word;
 *  it only needs the literal path a quoted arg denotes). */
function unquote(word) {
  const m = /^(['"])(.*)\1$/.exec(word);
  return m ? m[2] : word;
}

/**
 * Split a command line into the segments that are genuinely COMMAND POSITIONS: the separator scan
 * runs only outside quotes and skips heredoc bodies entirely.
 *
 * Quoting awareness is load-bearing, not polish. A naive split would treat a hazard MENTIONED as
 * data as a hazard INVOKED — `git commit -m "a; git stash pop"`, or a `gh pr create --body` whose
 * text has a column-0 `git stash pop` line — and hard-block a legitimate call. That is the exact
 * inverse of this module's fail-open contract, so the parse errs the other way instead: an
 * ambiguous command (unterminated quote or unterminated heredoc) yields NO segments at all, and
 * therefore no decision.
 *
 * Everything inside `$( … )` / backticks is left in its segment and still read as a command
 * position, which is correct — that IS a command position.
 */
function segments(command) {
  const out = [];
  const lines = command.split(/\r?\n/);
  let cur = "";
  let quote = null; // "'" or '"' while inside a quoted string (may span lines)
  let heredoc = null; // terminator of the heredoc body currently being skipped
  let pending = null; // terminator queued by a `<<WORD` seen earlier on this line

  const flush = () => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = "";
  };

  for (const line of lines) {
    if (heredoc !== null) {
      // Inside a heredoc body: pure data, never a command position.
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote === "'") {
        if (c === "'") quote = null;
        cur += c;
        continue;
      }
      if (quote === '"') {
        if (c === "\\" && i + 1 < line.length) {
          cur += c + line[++i];
          continue;
        }
        if (c === '"') quote = null;
        cur += c;
        continue;
      }
      if (c === "\\" && i + 1 < line.length) {
        cur += c + line[++i]; // escaped char is data, never a separator
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        cur += c;
        continue;
      }
      // `<<WORD` / `<<-WORD` opens a heredoc whose body is data; `<<<` is a here-STRING (not one).
      if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
        const rest = line.slice(i + 2);
        const m = /^-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(rest);
        if (m) {
          pending = m[1] ?? m[2] ?? m[3];
          i += 1 + m[0].length;
          continue;
        }
      }
      if (c === ";" || c === "|" || c === "&") {
        flush();
        if (line[i + 1] === c) i++; // `&&` / `||`
        continue;
      }
      cur += c;
    }
    // A newline outside quotes ends the command; inside a quote it is part of the string.
    if (quote === null) flush();
    else cur += "\n";
    if (pending !== null) {
      heredoc = pending;
      pending = null;
    }
  }
  // Ambiguous parse ⇒ no opinion, rather than a decision taken on a misread command line.
  if (quote !== null || heredoc !== null) return [];
  flush();
  return out;
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
  // Anything the SHELL would expand is not ours to guess: `~`, `$VAR`, `$(…)`, backticks, globs.
  // Joining such a word produces a FABRICATED path — `cd $HOME/r` under `/tmp/x` would "resolve"
  // to `/tmp/x/$HOME/r` — which could then be denied, naming a directory that never existed.
  if (/^~|[$`*?]/.test(a)) return null;
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
 * `event` is the raw hook body. `deps.isTmpfs` is the ONLY environment this touches — injected so
 * the rules stay pure and testable, and so a test never depends on the host's mount table; it
 * defaults to {@link isTmpfsPath}, which asks the kernel.
 */
export function decideToolGuard(event, deps = {}) {
  if (!event || typeof event !== "object") return null;
  if (event.tool_name !== "Bash") return null;
  const input = event.tool_input;
  if (!input || typeof input !== "object") return null;
  const command = typeof input.command === "string" ? input.command : "";
  if (!command.trim()) return null;

  const denial = denyFor(command, event.cwd, deps.isTmpfs ?? isTmpfsPath);
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
function denyFor(command, eventCwd, isTmpfs) {
  let cwd = typeof eventCwd === "string" ? eventCwd : undefined;

  for (const segment of segments(command)) {
    const w = words(segment);
    if (w.length === 0) continue;
    const [cmd, ...args] = w;

    // `cd <path>` moves the effective directory for every LATER segment of the same command line.
    // An UNRESOLVABLE target (`~/repo`, `$VAR`, `$(…)`) drops the claim entirely rather than
    // keeping the previous cwd: the shell has moved somewhere this parse cannot name, so judging a
    // later install against the OLD directory would deny a legitimate `cd ~/repo && bun install`
    // whenever the starting cwd happened to be a tmpfs — and name the stale path as the reason.
    // `cd` with no operand is `cd $HOME`, equally unknowable here.
    if (cmd === "cd") {
      const target = args.find((a) => !a.startsWith("-"));
      cwd = target ? (resolvePath(target, cwd) ?? undefined) : undefined;
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
          if (path && isTmpfs(path)) {
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
      if (installs && typeof cwd === "string" && isAbsolute(cwd) && isTmpfs(cwd)) {
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
    out = hookOutput(decideToolGuard(JSON.parse(await readStdin())));
  } catch {
    out = null; // fail open on malformed input — never block on a parse error
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

/**
 * Is this module the process entry point (i.e. run as the hook command, not imported)?
 *
 * `realpathSync(argv[1])`, not a bare `resolve` — Node realpath-resolves the ENTRY module behind
 * `import.meta.url` (`--preserve-symlinks-main` defaults off) but leaves argv[1] merely resolved, so
 * ANY symlinked path component makes a bare compare false. Getting this wrong is silent and severe
 * here: `main()` would never run, the hook would emit nothing, and every `git stash` / tmpfs install
 * would be ALLOWED — while composeSystemPromptBlocks has already dropped both hazard notices from
 * the prompt on the strength of this guard existing. Verified: invoking this file through a
 * symlinked directory emitted nothing before this fix. Same idiom (and same reasoning) as
 * `isMainModule` in scripts/check-model-mirror.mjs; `fileURLToPath` rather than a `file://` concat
 * because `import.meta.url` is percent-encoded.
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    // argv[1] isn't a resolvable path (eval / bundler harness) → not the CLI entry.
    return false;
  }
}

if (isMainModule()) {
  await main();
}
