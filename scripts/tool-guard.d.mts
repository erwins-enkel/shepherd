// Types for the node-run PreToolUse tool guard (scripts/tool-guard.mjs). The guard stays plain
// .mjs so Claude Code can invoke it with the node binary the sandbox membrane already binds; this
// declaration only exists so the TypeScript test (test/tool-guard.test.ts) and the settings-overlay
// caller can import it.

/** A `PreToolUse` hook body, as much of it as the guard reads. */
export interface ToolGuardEvent {
  tool_name?: string;
  tool_input?: { command?: string; run_in_background?: boolean; [k: string]: unknown };
  cwd?: string;
  [k: string]: unknown;
}

/** A denial carries the explanation the retired standing notice used to state. */
export interface ToolGuardDenial {
  permissionDecision: "deny";
  permissionDecisionReason: string;
}

/** Guidance delivered at the call without changing its permission outcome — the deterministic
 *  backstop for the notices that moved into skills. */
export interface ToolGuardContext {
  additionalContext: string;
}

/** A heavy check routed through the host-wide slot (#3181): the whole tool input with only
 *  `command` replaced by the runner invocation. No permission decision — the normal flow applies. */
export interface ToolGuardRewrite {
  updatedInput: { command: string; [k: string]: unknown };
  /** The backgrounding note, when the rewritten call was backgrounded. */
  additionalContext?: string;
}

export type ToolGuardDecision = ToolGuardDenial | ToolGuardContext | ToolGuardRewrite;

export const STASH_REASON: string;
export const INLINE_SHELL_REASON: string;
export const RATE_LIMIT_REASON: string;
export const CI_WATCH_REASON: string;
export const CI_POLL_CONTEXT: string;
export const DEPLOY_WATCH_CONTEXT: string;
export const PR_CREATE_CONTEXT: string;
export const PUSH_CONTEXT: string;
export const BACKGROUND_CONTEXT: string;
export function worktreeTmpfsReason(path: string): string;
export function installTmpfsReason(path: string): string;

/** Is `path` really on a memory-backed filesystem? Asked of the kernel (statfs), never guessed from
 *  the path — Shepherd points agents' `TMPDIR` at a DISK-backed dir on purpose (#1875). */
export function isTmpfsPath(path: string, statfs?: (p: string) => { type: number }): boolean;

/** Injectable environment for the rules. `isTmpfs` defaults to {@link isTmpfsPath}; the run and
 *  branch lookups (consulted only by a literal-id `gh run watch`) default to one `gh` / `git` call
 *  each and return null on any failure. */
export interface ToolGuardDeps {
  isTmpfs?: (path: string) => boolean;
  /** `gh run view <id> --json event,headBranch`, with `-R <repo>` when given. */
  runInfo?: (
    id: string,
    repo: string | null,
    cwd: string | undefined,
  ) => { event: string; headBranch: string } | null;
  /** The session's checked-out branch. */
  currentBranch?: (cwd: string | undefined) => string | null;
  /** The repo's default branch (`origin/HEAD`, without `origin/`). */
  defaultBranch?: (cwd: string | undefined) => string | null;
  /** A package.json or shell script's text (null: missing, too big, unreadable) — read to tell
   *  whether `bun run X` / `./script.sh` is a heavy check (#3181). */
  readText?: (path: string) => string | null;
  /** The heavy-check runner to wrap heavy commands with, or null to rewrite nothing (#3181). */
  heavyRunner?: () => { node: string; script: string } | null;
  /** The operator's edits to the built-in heavy list (#3552), or null. Default: the JSON file
   *  `SHEPHERD_HEAVY_LIST_FILE` names. */
  heavyList?: () => HeavyListOverride | null;
}

/** Operator edits to the built-in "counts as heavy" list (Settings → Resources). */
export interface HeavyListOverride {
  /** Added commands; `subcommands: []` = heavy whatever the arguments. */
  custom: Array<{ command: string; subcommands: string[] }>;
  /** Built-in commands switched off. */
  disabled: string[];
}

/** The built-in heavy list as data — the single source the settings page shows as "default". */
export function heavyDefaults(): Array<{ command: string; subcommands: string[] }>;

/** Is `command` a heavy check (tests, type checks, builds)? The one detection shared by the guard
 *  and the Codex PATH shims (#3550). `cwd` resolves `bun run <script>` against package.json. */
export function isHeavyCommand(command: string, cwd?: string, deps?: ToolGuardDeps): boolean;

/** Decide one event: `null` = no opinion (normal permission flow). */
export function decideToolGuard(
  event: ToolGuardEvent | null | undefined,
  deps?: ToolGuardDeps,
): ToolGuardDecision | null;

/** Wrap a decision in the `hookSpecificOutput` envelope, or `null` for silence. */
export function hookOutput(
  decision: ToolGuardDecision | null,
): { hookSpecificOutput: { hookEventName: "PreToolUse" } & ToolGuardDecision } | null;
