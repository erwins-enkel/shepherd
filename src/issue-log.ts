import { SHEPHERD_ISSUE_LOG_MARKER } from "./forge/types";
import type { GitForge, GitState } from "./forge/types";
import type { Session } from "./types";
import { checksCleared } from "./checks-gate";

/**
 * Issue-log: the workflow protocol on a session's backlog issue. For a session
 * spawned from an issue, post one comment when its PR enters the waiting-on-handoff
 * state (open + green CI + a foreign reviewer/merger from `.shepherd/roles.json`)
 * and one when the PR merges — so the issue's timeline records who the work was
 * parked on and when it landed.
 *
 * A handoff may now also be auto-inferred from the PR's requested reviewers when a
 * repo has no `.shepherd/roles.json` (GitState.handoffInferred = true). The outward
 * issue comment is intentionally gated to explicitly-configured (non-inferred)
 * handoffs — auto-inference drives the in-app herd grouping, but does not write to
 * the public issue timeline unless the operator opted in via roles config.
 *
 * Deliberately STATELESS over the current GitState (no prev-state comparison):
 * dedup lives in the persisted `issue_log` stamps, so each transition comments
 * exactly once per PR across restarts, CI flaps, and the one-time backfill burst
 * when roles are first configured (the operator chose to backfill already-waiting
 * PRs). A reviewer→merger handoff flip after approval does NOT re-comment — one
 * "waiting" note per PR, keyed `waiting:<pr>` / `merged:<pr>`; a NEW PR (new
 * number) logs again. Best-effort like closeIssue: a failed comment is not
 * stamped, so the next session:git event retries it.
 */
export interface IssueLogEntry {
  key: string;
  body: string;
}

/** The comments `git`'s current state still owes the issue — pure, testable core.
 *  Wording is forge content (English, like PR bodies); the merged note is phrased
 *  to stay valid whether the issue is open (manual session) or being closed by
 *  merge-teardown at the same moment (auto session). */
export function issueLogEntries(
  git: GitState,
  alreadyLogged: (key: string) => boolean,
): IssueLogEntry[] {
  if (git.number == null) return [];
  const out: IssueLogEntry[] = [];
  // handoff is only annotated on an open+green PR (annotateHandoff), but re-check
  // the full condition so a stale/hand-rolled GitState can't comment early. An
  // auto-inferred handoff (no roles.json) is excluded — the outward comment is
  // opt-in to explicitly-configured roles (see module doc).
  if (git.state === "open" && checksCleared(git.checks, git.noCi ?? false) && git.reviewBlock) {
    const key = `changes-requested:${git.number}`;
    if (!alreadyLogged(key))
      out.push({
        key,
        body: stamp(`⚠️ Changes requested on PR #${git.number} by @${git.reviewBlock.reviewer}.`),
      });
  } else if (
    git.state === "open" &&
    checksCleared(git.checks, git.noCi ?? false) &&
    git.handoff &&
    !git.handoffInferred
  ) {
    const key = `waiting:${git.number}`;
    if (!alreadyLogged(key)) out.push({ key, body: stamp(waitingBody(git, git.number)) });
  }
  if (git.state === "merged") {
    const key = `merged:${git.number}`;
    if (!alreadyLogged(key)) out.push({ key, body: stamp(`✅ PR #${git.number} merged.`) });
  }
  return out;
}

/** Append the invisible issue-log marker so a task later spawned from this issue can
 *  filter Shepherd's own workflow notes out of the comment thread it feeds the agent.
 *  Appended (not prepended) so the leading wording stays intact for the spawn filter's
 *  pre-marker wording fallback (and for human readers of the issue timeline). */
function stamp(body: string): string {
  return `${body}\n\n${SHEPHERD_ISSUE_LOG_MARKER}`;
}

/** The "waiting" comment wording. Only reached for a non-inferred (explicitly
 *  configured) handoff — an auto-inferred merger is filtered out by the caller, so
 *  this never authors a public comment off a guessed reviewer. */
function waitingBody(git: GitState, prNumber: number): string {
  if (git.handoff === "reviewer" && git.handoffWho)
    return `⏸️ Waiting on review of PR #${prNumber} by @${git.handoffWho}.`;
  if (git.handoff === "merger" && git.handoffWho)
    return `⏸️ Waiting on @${git.handoffWho} to merge PR #${prNumber}.`;
  return `⏸️ Waiting on PR #${prNumber} to merge.`;
}

export interface IssueLogDeps {
  resolveForge: (repoPath: string) => Pick<GitForge, "commentIssue"> | null;
  store: {
    hasIssueLog(sessionId: string, key: string): boolean;
    markIssueLog(sessionId: string, key: string): void;
  };
}

type IssueLogSession = Pick<Session, "id" | "repoPath" | "issueNumber">;

/** Build the session:git handler: post any owed comments, stamping each only after
 *  its comment succeeded. The in-flight guard closes the check-then-comment race
 *  when two git events for one session land back-to-back (poller + repushHandoff). */
export function createIssueLogger(deps: IssueLogDeps) {
  const inFlight = new Set<string>();
  return async (s: IssueLogSession, git: GitState): Promise<void> => {
    if (s.issueNumber == null) return;
    const entries = issueLogEntries(git, (key) => deps.store.hasIssueLog(s.id, key));
    if (entries.length === 0) return;
    const forge = deps.resolveForge(s.repoPath);
    if (!forge?.commentIssue) return; // host can't comment → stay silent, don't stamp
    for (const e of entries) {
      const flightKey = `${s.id}:${e.key}`;
      if (inFlight.has(flightKey)) continue;
      inFlight.add(flightKey);
      try {
        await forge.commentIssue(s.issueNumber, e.body);
        deps.store.markIssueLog(s.id, e.key);
      } finally {
        inFlight.delete(flightKey);
      }
    }
  };
}
