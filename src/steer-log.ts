/** Which channel typed a message into a session. Shepherd's own steers open with fixed words
 *  (src/autopilot.ts, plan-gate.ts, review.ts, automerge.ts, build-queue-reminder.ts, the
 *  plan-go and queue-approval texts); anything else is the operator's. */
export type SteerKind =
  | "go"
  | "plan_review"
  | "ci_fix"
  | "rebase"
  | "open_pr"
  | "nudge"
  | "review"
  | "queue"
  | "operator";

/** One message typed into a session — time and channel only, never the text. */
export interface SteerLogEntry {
  ts: number;
  kind: SteerKind;
}

/** Opening words → channel, most specific first ("You're in autopilot" alone is the generic
 *  nudge family). test/steer-log.test.ts feeds the real steer builders through this table, so a
 *  reworded steer fails a test instead of silently turning into an operator message. */
const PREFIXES: ReadonlyArray<readonly [string, SteerKind]> = [
  ["You're in autopilot and CI is failing", "ci_fix"],
  ["You're in autopilot and your PR is behind", "rebase"],
  ["You're in autopilot and your PR has merge conflicts", "rebase"],
  ["You're in full-auto and your PR can't merge as-is", "rebase"],
  ["You're in autopilot and you've stopped, but there's no pull request yet", "open_pr"],
  ["You're in autopilot", "nudge"],
  ["Plan approved.", "go"],
  ["✅ Build queue approved", "go"],
  ["The plan reviewer raised", "plan_review"],
  ["Shepherd could not run the plan reviewer", "plan_review"],
  ["The operator answered the open questions", "plan_review"],
  ["The PR critic reviewed your latest push", "review"],
  ["🔄 Your build-queue step statuses", "queue"],
];

export function classifySteer(text: string): SteerKind {
  return PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? "operator";
}

/** The recorded `reply` signals of one session as a steer log, oldest first. */
export function steerLog(rows: readonly { ts: number; payload: string }[]): SteerLogEntry[] {
  return rows.map(({ ts, payload }) => ({ ts, kind: classifySteer(payload) }));
}
