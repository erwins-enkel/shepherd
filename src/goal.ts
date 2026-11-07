/**
 * Claude Code `/goal` vs the plan gate (#2596). Both claim who may end a turn: in planning that is
 * the operator / plan reviewer, in execution the goal evaluator. So Shepherd HOLDS a prompt-leading
 * `/goal X` while a session plans, ARMS it with the Go steer, and pauses any goal typed in the
 * terminal during planning by answering the Stop hook with `continue:false`.
 *
 * Transcript shape, observed live on Claude Code 2.1.319: setting a goal writes
 * `{"type":"attachment","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":…}}`
 * immediately, every evaluation writes another `goal_status` (`met` true/false), and `/goal clear`
 * writes `met:true`. A Stop hook answering `continue:false` while an unmet goal is active ends the
 * turn as "Goal paused" with no extra turn; the next prompt resumes the goal.
 */
import { readTranscriptTailAsync } from "./activity";
import type { GoalState, Session } from "./types";

/** Claude Code's own cap on a goal condition. */
export const GOAL_CONDITION_MAX = 4000;

/** Fail-open budget for the Stop hook's transcript read — the hook itself times out at 5 s. */
const STOP_READ_TIMEOUT_MS = 2000;

/** What the Stop hook answers while a goal would push a planning agent past its hand-back. */
export const PLAN_GATE_STOP_REASON = "Shepherd plan gate: plan awaits review";

const LEADING_GOAL_RE = /^\/goal\s+([\s\S]+)$/;

/** One line, no control characters: a newline typed into the TUI would submit early. */
export function normalizeGoalCondition(raw: string): string {
  // C0, DEL and C1 (incl. ESC, so no paste marker survives) become spaces.
  const spaced = Array.from(raw, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }).join("");
  return spaced.replace(/\s+/g, " ").trim();
}

/**
 * Split a prompt-leading `/goal X` into the condition to hold and the task text to plan with.
 * Null when the prompt is not a goal, clears one, or its condition exceeds Claude Code's cap —
 * those prompts keep today's behavior.
 */
export function splitHeldGoal(prompt: string): { condition: string; task: string } | null {
  const m = LEADING_GOAL_RE.exec(prompt.trimStart());
  const task = m?.[1]?.trim();
  if (!task || task.toLowerCase() === "clear") return null;
  const condition = normalizeGoalCondition(task);
  if (condition.length > GOAL_CONDITION_MAX) return null;
  return { condition, task };
}

/** The slash command that arms a held goal. */
export function goalArmCommand(condition: string): string {
  return `/goal ${condition}`;
}

/** The newest `goal_status` attachment in a transcript tail, or null when it has none. */
export function latestGoalStatus(tail: string): { condition: string; met: boolean } | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"goal_status"')) continue;
    const status = parseGoalStatus(line);
    if (status) return status;
  }
  return null;
}

function parseGoalStatus(line: string): { condition: string; met: boolean } | null {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  const att = (rec as { attachment?: Record<string, unknown> } | null)?.attachment;
  if (att?.type !== "goal_status" || typeof att.met !== "boolean") return null;
  return { condition: typeof att.condition === "string" ? att.condition : "", met: att.met };
}

/** The goal a session's row should show, from its current state and the transcript's active goal.
 *  A held goal is Shepherd's own and never changed by a transcript read. */
function nextGoal(
  s: Pick<Session, "goalCondition" | "goalState">,
  active: string | null,
): { goalCondition: string | null; goalState: GoalState | null } {
  if (s.goalState === "held") return { goalCondition: s.goalCondition ?? null, goalState: "held" };
  return active === null
    ? { goalCondition: null, goalState: null }
    : { goalCondition: active, goalState: "active" };
}

export interface GoalTrackerDeps {
  store: {
    setGoal(id: string, condition: string | null, state: GoalState | null): void;
  };
  events?: { emit(event: string, data: unknown): void };
  /** Server-resolved transcript — never the hook body's `transcript_path`. */
  transcriptPath: (s: Session) => string | null;
  readTail?: (path: string) => Promise<string>;
  timeoutMs?: number;
}

/** Reads a Claude session's active goal on each Stop hook: mirrors it onto the row and decides the
 *  plan-gate pause. Total: an unreadable transcript or a slow read is "no goal" (fail open). */
export class GoalTracker {
  constructor(private deps: GoalTrackerDeps) {}

  async onStop(s: Session): Promise<{ pause: boolean }> {
    if ((s.agentProvider ?? "claude") !== "claude") return { pause: false };
    const path = this.deps.transcriptPath(s);
    if (!path) return { pause: false };
    const tail = await this.#readTail(path);
    if (tail === null) return { pause: false };
    const status = latestGoalStatus(tail);
    const active = status && !status.met ? status.condition : null;
    this.#reconcile(s, active);
    return { pause: active !== null && s.planPhase === "planning" };
  }

  async #readTail(path: string): Promise<string | null> {
    const read = (this.deps.readTail ?? readTranscriptTailAsync)(path).catch(() => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.deps.timeoutMs ?? STOP_READ_TIMEOUT_MS);
      timer.unref?.();
    });
    return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
  }

  #reconcile(s: Session, active: string | null): void {
    const next = nextGoal(s, active);
    if (
      next.goalCondition === (s.goalCondition ?? null) &&
      next.goalState === (s.goalState ?? null)
    )
      return;
    this.deps.store.setGoal(s.id, next.goalCondition, next.goalState);
    this.deps.events?.emit("session:goal", { id: s.id, ...next });
  }
}
