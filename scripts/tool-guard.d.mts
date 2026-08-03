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

export type ToolGuardDecision = ToolGuardDenial | ToolGuardContext;

export const STASH_REASON: string;
export const PR_CREATE_CONTEXT: string;
export const BACKGROUND_CONTEXT: string;
export function worktreeTmpfsReason(path: string): string;
export function installTmpfsReason(path: string): string;

/** Is `path` really on a memory-backed filesystem? Asked of the kernel (statfs), never guessed from
 *  the path — Shepherd points agents' `TMPDIR` at a DISK-backed dir on purpose (#1875). */
export function isTmpfsPath(path: string, statfs?: (p: string) => { type: number }): boolean;

/** Injectable environment for the rules. `isTmpfs` defaults to {@link isTmpfsPath}. */
export interface ToolGuardDeps {
  isTmpfs?: (path: string) => boolean;
}

/** Decide one event: `null` = no opinion (normal permission flow). */
export function decideToolGuard(
  event: ToolGuardEvent | null | undefined,
  deps?: ToolGuardDeps,
): ToolGuardDecision | null;

/** Wrap a decision in the `hookSpecificOutput` envelope, or `null` for silence. */
export function hookOutput(
  decision: ToolGuardDecision | null,
): { hookSpecificOutput: { hookEventName: "PreToolUse" } & ToolGuardDecision } | null;
