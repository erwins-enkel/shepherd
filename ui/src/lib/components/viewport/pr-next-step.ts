import { m } from "#lib/paraglide/messages.js";
import { isConflicting } from "#lib/pr-conflict.js";
import type { GitState, Session, LivenessState } from "#lib/types.js";
import { firstSafeHttpUrl } from "#lib/url.js";
import type { PrRowKind } from "./pr-action-row";

/** The one action the merge row offers in its main slot (#3541). `merge` is #3540's own. */
export type NextAction = "merge" | "fix-ci" | "rebase" | "decommission";

/** `button` is live; `locked` keeps the button focusable with a reason (`aria-disabled`);
 *  `passive` is a hint instead of a button (autopilot owns the step). */
export type NextMode = "button" | "locked" | "passive";

export interface NextStep {
  action: NextAction;
  mode: NextMode;
  /** Why the step is locked, or the passive hint's text. Null for a live button. */
  reason: string | null;
}

const MAX_NAMES = 5;
const MAX_NAME_CHARS = 80;

/** Mirrors the server's `failingChecks` (src/ci-steer.ts): the agent-facing list of failing check
 *  names, or a pointer to `gh pr checks` when the host gave no per-job data. */
export function failingChecksText(git: Pick<GitState, "jobs" | "number">): string {
  const names = (git.jobs ?? [])
    .filter((j) => j.state === "failure")
    .map((j) => {
      const flat = j.name.replace(/[\p{Cc}\s]+/gu, " ").trim();
      return flat.length > MAX_NAME_CHARS ? `${flat.slice(0, MAX_NAME_CHARS - 1)}…` : flat;
    });
  if (names.length === 0) {
    const pr = git.number === undefined ? "" : ` ${git.number}`;
    return `run \`gh pr checks${pr}\` once for the failing checks`;
  }
  const shown = names.slice(0, MAX_NAMES).join(", ");
  return names.length > MAX_NAMES ? `${shown} +${names.length - MAX_NAMES} more` : shown;
}

/** The CI-fix steer. Typed into the PTY, so fixed English like the server's CI steers. */
export function ciFixSteer(git: GitState): string {
  const head = `PR #${git.number ?? "?"} (head ${(git.headSha ?? "").slice(0, 7)})`;
  return (
    `Shepherd: CI is failing on ${head}: ${failingChecksText(git)}. Read the logs with ` +
    "`gh run view <run-id> --log-failed`, fix the root cause, rebase onto your PR's base and push. " +
    "Don't watch the new run — Shepherd steers you when it finishes."
  );
}

/** The rebase steer; a conflict also names the resolution. Fixed English. */
export function rebaseSteer(base: string, conflict: boolean): string {
  return (
    `Shepherd: your PR is ${conflict ? "in conflict with" : "behind"} ${base}. Fetch origin and ` +
    `rebase your branch onto origin/${base} (never merge it in)` +
    `${conflict ? ", resolve the conflicts" : ""} and push with --force-with-lease.`
  );
}

/** The text the main-slot steer sends, or null for actions that send nothing. */
export function nextStepSteer(action: NextAction, git: GitState, base: string): string | null {
  if (action === "fix-ci") return ciFixSteer(git);
  if (action === "rebase") return rebaseSteer(base, isConflicting(git));
  return null;
}

/** A steerable agent: a live pane of a non-terminal, non-shelved session. Resuming a dead agent
 *  stays on the existing Resume path — a steer must never be the thing that revives it. */
export function agentLive(
  s: Pick<Session, "terminal" | "shelved" | "status">,
  liveness?: LivenessState,
): boolean {
  return (
    !s.terminal &&
    !s.shelved &&
    (s.status === "running" || s.status === "idle" || s.status === "blocked") &&
    liveness !== "husk" &&
    liveness !== "stranded"
  );
}

/** What the main slot offers for this row state. `autopilot` is the session's EFFECTIVE autopilot
 *  (it already owns red CI and rebases); `criticReviewing` holds the CI steer, whose failure the
 *  critic's findings steer may carry (#3426). */
export function prNextStep(input: {
  kind: PrRowKind;
  autopilot: boolean;
  criticReviewing: boolean;
  live: boolean;
}): NextStep {
  const { kind, autopilot, criticReviewing, live } = input;
  if (kind === "merged") return { action: "decommission", mode: "button", reason: null };
  if (kind === "ci_failed") {
    if (autopilot) return { action: "fix-ci", mode: "passive", reason: m.prrow_passive_ci() };
    if (criticReviewing)
      return { action: "fix-ci", mode: "locked", reason: m.prrow_locked_critic() };
    if (!live) return { action: "fix-ci", mode: "locked", reason: m.prrow_locked_not_live() };
    return { action: "fix-ci", mode: "button", reason: null };
  }
  if (kind === "behind" || kind === "conflict") {
    if (autopilot) return { action: "rebase", mode: "passive", reason: m.prrow_passive_rebase() };
    if (!live) return { action: "rebase", mode: "locked", reason: m.prrow_locked_not_live() };
    return { action: "rebase", mode: "button", reason: null };
  }
  return { action: "merge", mode: "button", reason: null };
}

/** The button label of a non-merge action. */
export function nextActionLabel(action: Exclude<NextAction, "merge">): string {
  switch (action) {
    case "fix-ci":
      return m.prrow_fix_ci();
    case "rebase":
      return m.prrow_rebase();
    case "decommission":
      return m.gitrail_decommission_action();
  }
}

/** One-line tooltip summary of what a live non-merge action does. */
export function nextActionSummary(action: Exclude<NextAction, "merge">): string {
  switch (action) {
    case "fix-ci":
      return m.prrow_tip_fix_ci();
    case "rebase":
      return m.prrow_tip_rebase();
    case "decommission":
      return m.prrow_tip_decommission();
  }
}

/** `Logs ↗` target for a red PR: the first failing check's own page, else the PR's checks tab. */
export function logsHref(git: Pick<GitState, "jobs" | "url">): string | null {
  const job = (git.jobs ?? []).find((j) => j.state === "failure" && firstSafeHttpUrl(j.url));
  if (job) return firstSafeHttpUrl(job.url);
  const pr = firstSafeHttpUrl(git.url);
  return pr ? `${pr.replace(/\/+$/, "")}/checks` : null;
}
