import type { DrainStatus } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { ApiError } from "#lib/api.js";
import { bootstrapMissingText } from "./queue-strip";

// #3457: the drain holds the epic's run area already explains — project bootstrap, the usage
// ceiling, the integration branch's base, a stuck agent, an attended approval — as one halt line
// at the epic's list row and in the repo overview, each with the action that already exists for
// it. Pure; the copy follows the "Halt-Gründe" artboard. The sandbox, CLI and host gates keep
// their own line with Fix (#3455).

/** Where the hold sits: the repo's settings, this run (a repo limit it may lift), or this epic. */
export type HoldScope = "repo" | "run" | "epic";

/** One way out — every one an existing call. */
export type HoldAction =
  | { kind: "bootstrap_view" }
  | { kind: "bootstrap_override" }
  | { kind: "usage_lift" }
  | { kind: "base_resolve" }
  | { kind: "base_continue"; override: "base" | "predecessor" }
  | { kind: "open_session"; sessionId: string }
  | { kind: "approve" };

export interface DrainHoldView {
  code: string;
  scope: HoldScope;
  /** `halt` stops the run (red); `wait` waits on the operator (amber). */
  tone: "halt" | "wait";
  /** The thing at fault, emphasized. */
  what: string;
  text: string;
  actions: HoldAction[];
}

type HoldBuilder = (detail: string, drain: DrainStatus) => Omit<DrainHoldView, "code">;

/** The live session a trouble hold names by its desig — a slot holder or a landing repair. */
function sessionAction(drain: DrainStatus, desig: string): HoldAction[] {
  const summary = drain.runSummary;
  const live = [...(summary?.slots.holders ?? []), ...(summary?.landingRepairs ?? [])];
  const session = live.find((s) => s.desig === desig);
  return session ? [{ kind: "open_session", sessionId: session.sessionId }] : [];
}

function trouble(text: (desig: string) => string): HoldBuilder {
  return (desig, drain) => ({
    scope: "epic",
    tone: "halt",
    what: m.epic_rowhold_agent_what(),
    text: text(desig),
    actions: sessionAction(drain, desig),
  });
}

const HOLDS: Record<string, HoldBuilder> = {
  bootstrap_incomplete: (missing) => ({
    scope: "repo",
    tone: "halt",
    what: m.epic_rowhold_bootstrap_what(),
    text: m.epic_rowhold_bootstrap_text({ missing: bootstrapMissingText(missing) }),
    actions: [{ kind: "bootstrap_view" }, { kind: "bootstrap_override" }],
  }),
  usage: () => ({
    scope: "run",
    tone: "halt",
    what: m.epic_rowhold_usage_what(),
    text: m.epic_rowhold_usage_text(),
    actions: [{ kind: "usage_lift" }],
  }),
  epic_base_conflict: (branch) => ({
    scope: "epic",
    tone: "halt",
    what: m.epic_rowhold_base_what(),
    text: m.epic_rowhold_conflict_text({ branch }),
    actions: [{ kind: "base_resolve" }, { kind: "base_continue", override: "base" }],
  }),
  epic_base_stale: (branch) => ({
    scope: "epic",
    tone: "halt",
    what: m.epic_rowhold_base_what(),
    text: m.epic_rowhold_stale_text({ branch }),
    actions: [{ kind: "base_continue", override: "base" }],
  }),
  epic_predecessor_unlanded: (epics) => ({
    scope: "epic",
    tone: "halt",
    what: m.epic_rowhold_predecessor_what(),
    text: m.epic_rowhold_predecessor_text({ epics }),
    actions: [{ kind: "base_continue", override: "predecessor" }],
  }),
  blocked: trouble((desig) => m.epic_rowhold_blocked_text({ desig })),
  changes_requested: trouble((desig) => m.epic_rowhold_changes_text({ desig })),
  error: trouble((desig) => m.epic_rowhold_error_text({ desig })),
  awaiting_approval: (num) => ({
    scope: "epic",
    tone: "wait",
    what: m.epic_rowhold_approval_what(),
    text: m.epic_rowhold_approval_text({ num }),
    actions: [{ kind: "approve" }],
  }),
};

/** The drain's hold as a halt line, or null for a reason without one. The caller attaches it to
 *  the epic the drain runs (`drain.epicParent`); a repo-scoped hold also holds without one. */
export function drainHold(drain: DrainStatus | null | undefined): DrainHoldView | null {
  const build = drain?.reason ? HOLDS[drain.reason] : undefined;
  if (!drain?.reason || !build) return null;
  return { code: drain.reason, ...build(drain.detail ?? "", drain) };
}

const ACTION_LABELS: Record<HoldAction["kind"], () => string> = {
  bootstrap_view: () => m.epic_rowhold_bootstrap_view(),
  bootstrap_override: () => m.automation_bootstrap_override(),
  usage_lift: () => m.epic_rowhold_usage_lift(),
  base_resolve: () => m.epic_rowhold_resolve(),
  base_continue: () => m.epic_base_continue(),
  open_session: () => m.epic_run_open_session(),
  approve: () => m.epic_rowhold_approve(),
};

export function holdActionLabel(action: HoldAction): string {
  return ACTION_LABELS[action.kind]();
}

/** Why dispatching a base-rework agent failed (#3101), as its toast says it. */
export function baseReworkFailedText(err: unknown): string {
  const reason = err instanceof ApiError ? err.code : undefined;
  if (reason === "busy") return m.epic_base_resolve_busy();
  if (reason === "not-conflicting") return m.epic_base_resolve_not_conflicting();
  return m.epic_base_resolve_failed();
}
