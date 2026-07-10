import { m } from "$lib/paraglide/messages";
import { holdLine } from "$lib/hold";
import { planGateChip, type PlanGateChip } from "$lib/components/plan-gate-badge";
import { planQuestionsUnanswered } from "$lib/tab-signal.svelte";
import type { HoldReason, PlanGate, Session } from "$lib/types";

/** The ten mutually-exclusive presentations a plan-gate row can take. One classifier
 *  decides the state; LINE and ACTION are total maps over it, so the subline can never
 *  contradict the button beside it. */
export type RowState =
  | "passthrough"
  | "dismissed"
  | "reviewing"
  | "revising"
  | "quota"
  | "error"
  | "question"
  | "awaiting-rereview"
  | "ready"
  | "none";

export interface HoldAction {
  kind: "go" | "rereview" | "resume" | "answer";
  label: string;
  title: string;
}

export interface RowHold {
  state: RowState;
  line: string | null;
  action: HoldAction | null;
}

/** Plan-domain hold codes — the ONLY server holds this module is allowed to reinterpret.
 *  Any other code passes through untouched (R3). */
const PLAN_DOMAIN = new Set<HoldReason["code"]>(["plan-rework", "quota-plan", "plan-question"]);

/** One ordered classifier, first match wins. Reads only `session` (synchronous with the
 *  row) + `gate`/`serverHold` (both async — a missing `gate` degrades to passthrough/none,
 *  never a wrong line). Exported so tests can assert the branch taken. */
export function rowState(
  session: Session,
  gate: PlanGate | undefined,
  planReviewing: boolean,
  serverHold: HoldReason | undefined,
  // Callers that already computed the chip (rowHold) pass it in to avoid recomputing the
  // identical pure value; direct callers (tests) omit it and it's derived here.
  chip: PlanGateChip = planGateChip(session, gate, planReviewing, { allowView: false }),
): RowState {
  const running = session.status === "running";
  const parked = session.status === "idle" || session.status === "done";
  const atCap = chip.kind === "changes" && chip.round >= chip.cap;

  if (session.planPhase !== "planning") return "passthrough"; // R1
  if (
    session.status === "blocked" ||
    session.haltReason != null ||
    (session.autopilotPaused && session.autopilotQuestion != null)
  )
    return "passthrough"; // R2 — mirrors blocked-decision's predicate; always-fresh session fields
  if (serverHold && !PLAN_DOMAIN.has(serverHold.code)) return "passthrough"; // R3
  if (gate?.dismissed) return "dismissed"; // R4
  if (chip.kind === "reviewing") return "reviewing"; // R5
  if (chip.kind === "changes" && running) return "revising"; // R6
  if (atCap) return "quota"; // R7 (atCap ⟹ chip changes)
  if (chip.kind === "error") return "error"; // R8
  if (planQuestionsUnanswered(gate) && parked) return "question"; // R9
  if (chip.kind === "changes") return "awaiting-rereview"; // R10
  if (chip.kind === "ready" && parked) return "ready"; // R11
  return "none"; // R12
}

interface Ctx {
  gate: PlanGate | undefined;
  chip: PlanGateChip;
  serverHold: HoldReason | undefined;
}

const serverLine = ({ serverHold }: Ctx): string | null =>
  serverHold ? holdLine(serverHold) : null;

/** round/cap off the `changes` chip (which copies gate.round/gate.cap); 0/0 otherwise. */
function counter(chip: PlanGateChip): { round: number; cap: number } {
  return chip.kind === "changes" ? { round: chip.round, cap: chip.cap } : { round: 0, cap: 0 };
}

/** A state authors its own line ONLY when it replaces the server's; otherwise it keeps
 *  holdLine(serverHold) so the row never blanks a line `/why` renders today. */
const LINE: Record<RowState, (ctx: Ctx) => string | null> = {
  passthrough: serverLine,
  dismissed: serverLine,
  none: serverLine,
  reviewing: ({ gate }) => {
    const n = gate?.findings?.length ?? 0;
    return n > 0 ? m.hold_reviewing_findings({ count: n }) : m.hold_reviewing_plain();
  },
  revising: ({ chip }) => {
    const { round, cap } = counter(chip);
    return round > 0 ? m.hold_revising_round({ round, cap }) : m.hold_revising();
  },
  quota: ({ serverHold }) =>
    serverHold?.code === "quota-plan" ? holdLine(serverHold) : m.hold_quota_plan(),
  error: () => m.hold_error(),
  question: () => m.hold_plan_question(),
  "awaiting-rereview": ({ chip }) => {
    const { round, cap } = counter(chip);
    return m.hold_awaiting_rereview({ round, cap });
  },
  ready: () => m.hold_ready(),
};

const go = (): HoldAction => ({ kind: "go", label: m.hold_cta_go(), title: m.hold_cta_go_title() });
const rereview = (): HoldAction => ({
  kind: "rereview",
  label: m.hold_cta_rereview(),
  title: m.hold_cta_rereview_title(),
});
const resume = (): HoldAction => ({
  kind: "resume",
  label: m.hold_cta_resume(),
  title: m.hold_cta_resume_title(),
});
const answer = (): HoldAction => ({
  kind: "answer",
  label: m.hold_cta_answer(),
  title: m.hold_cta_answer_title(),
});

const ACTION: Record<RowState, () => HoldAction | null> = {
  passthrough: () => null,
  dismissed: () => null,
  reviewing: () => null,
  revising: () => null,
  none: () => null,
  quota: resume,
  error: rereview,
  question: answer,
  "awaiting-rereview": rereview,
  ready: go,
};

/** Classify the row, then read its line and action off the two total maps. */
export function rowHold(
  session: Session,
  gate: PlanGate | undefined,
  planReviewing: boolean,
  serverHold: HoldReason | undefined,
): RowHold {
  const chip = planGateChip(session, gate, planReviewing, { allowView: false });
  const state = rowState(session, gate, planReviewing, serverHold, chip);
  const ctx: Ctx = { gate, chip, serverHold };
  return { state, line: LINE[state](ctx), action: ACTION[state]() };
}
