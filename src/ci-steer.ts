import type { EventHub } from "./events";
import type { ChecksState, GitState, PrStatus } from "./forge/types";
import { isOperatorAssistant } from "./operator-assistant-core";
import { isShelved } from "./shelve";
import type { SessionStore } from "./store";
import type { Session } from "./types";

/** Failing check names listed in the steer before the rest collapse into "+N more". */
const MAX_NAMES = 5;
const MAX_NAME_CHARS = 80;

export interface CiSteerDeps {
  /** Steer a LIVE pane only — never resume an exited agent just to tell it CI finished. */
  reply: (id: string, text: string) => Promise<boolean>;
  /** Whether autopilot is effective for the session: its CI_FIX_STEER already owns red CI. */
  autopilotOn: (s: Session) => boolean;
  /** The persisted PR cache at attach time (PrPoller.snapshot()). Without it the first post-restart
   *  transition of every session only primes and is never announced. */
  seed?: Record<string, GitState>;
  /** #3426: a critic run on this head is in flight (ReviewService.ciSteerHeld). A red result is
   *  held until it settles — its findings steer may carry the failure — and re-evaluated on the
   *  `session:reviewing` false edge. Omitted → never held. */
  criticReviewing?: (id: string, headSha: string) => boolean;
}

/** The handle attachCiSteer returns. */
export interface CiSteerHandle {
  /** #3426: the critic's findings steer carried this head's CI failure — treat it as announced. */
  noteCriticSteered: (id: string, headSha: string) => void;
}

/** One check name as a short single line (names come from the repo's CI config). */
function cleanName(name: string): string {
  const flat = name.replace(/[\p{Cc}\s]+/gu, " ").trim();
  return flat.length > MAX_NAME_CHARS ? `${flat.slice(0, MAX_NAME_CHARS - 1)}…` : flat;
}

/** The failing check names for a steer, or a pointer to `gh pr checks` without per-job data.
 *  Also used by the critic's combined CI+findings steer (#3426), off its live PR read. */
export function failingChecks(git: Pick<PrStatus, "jobs" | "number">): string {
  const names = (git.jobs ?? []).filter((j) => j.state === "failure").map((j) => cleanName(j.name));
  if (names.length === 0) {
    const pr = git.number === undefined ? "" : ` ${git.number}`;
    return `run \`gh pr checks${pr}\` once for the failing checks`;
  }
  const shown = names.slice(0, MAX_NAMES).join(", ");
  return names.length > MAX_NAMES ? `${shown} +${names.length - MAX_NAMES} more` : shown;
}

/**
 * The agent-facing CI-finished steer (#2852). Typed into the PTY, so fixed English — same
 * precedent as CI_FIX_STEER. Exported for tests.
 */
export function ciFinishedSteer(git: GitState): string {
  const head = `PR #${git.number ?? "?"} (head ${(git.headSha ?? "").slice(0, 7)})`;
  if (git.checks === "success") {
    return `Shepherd: CI finished on ${head}: all checks passed. No need to check CI again for this head.`;
  }
  return (
    `Shepherd: CI finished on ${head}: failed — ${failingChecks(git)}. Read the logs with ` +
    "`gh run view <run-id> --log-failed`, fix the root cause, rebase onto your PR's base and push. " +
    "Don't watch the new run — Shepherd steers you when it finishes."
  );
}

const finished = (c: ChecksState): c is "success" | "failure" => c === "success" || c === "failure";

/** Checks still running on the head. The rollup is worst-of with failure ABOVE pending, so a red
 *  rollup can still have jobs in flight; absent per-job data (REST fallback, Gitea) reads as none. */
function inFlight(git: GitState): boolean {
  return (
    (git.runningChecks?.length ?? 0) > 0 || (git.jobs ?? []).some((j) => j.state === "pending")
  );
}

/** The announced-pair key: in-flight is part of it so a red head whose remaining jobs then finish
 *  is a new pair — the steer waits for that, and then names every failure, not the first one. */
function pairKey(git: GitState): string {
  return `${git.headSha ?? ""}:${git.checks}:${inFlight(git) ? "running" : "done"}`;
}

/** Sessions the steer may address: a live agent session with an open PR, not planning and not
 *  owned by the merge train (which steers its own rebase). */
function steerable(s: Session | null | undefined, git: GitState): s is Session {
  return (
    !!s &&
    s.status !== "archived" &&
    !s.terminal &&
    !isOperatorAssistant(s) &&
    !isShelved(s) &&
    s.planPhase !== "planning" &&
    s.mergingSince === null &&
    git.state === "open"
  );
}

/**
 * Push a CI-finished steer to the task agent when its PR's checks turn terminal (#2852), so an
 * agent waiting for CI needs no `gh pr checks --watch` / `gh run watch` of its own. Fires once per
 * announced `(headSha, checks)` pair — a rerun that flips red→green on the same head steers again. The
 * first sighting of a session only primes (a restart must not re-announce settled CI); `deps.seed`
 * pre-primes from the persisted cache so a transition right after a restart still fires. A red PR
 * under autopilot is skipped: autopilot's CI_FIX_STEER already acts on it. A red PR whose head the
 * critic is reviewing is held until that run settles (#3426): announced then, unless the critic's
 * findings steer already carried it (noteCriticSteered).
 */
export function attachCiSteer(
  events: EventHub,
  store: Pick<SessionStore, "get">,
  deps: CiSteerDeps,
): CiSteerHandle {
  const last = new Map<string, string>(
    Object.entries(deps.seed ?? {}).map(([id, git]) => [id, pairKey(git)]),
  );
  // Last pair actually announced: a rollup that flaps (pending again, a REST-fallback sample
  // without a head) and settles back on the same result must not announce it twice.
  const steered = new Map<string, string>();
  // Red sample held back while the critic reviews its head, re-evaluated when the run settles.
  const deferred = new Map<string, GitState>();
  // Head whose CI failure the critic's combined steer already delivered.
  const criticSteered = new Map<string, string>();

  const announce = (id: string, git: GitState, key: string) => {
    const s = store.get(id);
    if (!steerable(s, git)) return;
    if (git.checks === "failure") {
      if (deps.autopilotOn(s)) return;
      if (criticSteered.get(id) === git.headSha) {
        steered.set(id, key);
        return;
      }
      if (deps.criticReviewing?.(id, git.headSha!)) {
        deferred.set(id, git);
        return;
      }
    }
    steered.set(id, key);
    void deps
      .reply(id, ciFinishedSteer(git))
      .catch((err) => console.warn("[ci-steer] steer:", err));
  };

  const onArchived = (id: string) => {
    last.delete(id);
    steered.delete(id);
    deferred.delete(id);
    criticSteered.delete(id);
  };

  // The critic run settled: re-evaluate the red sample it held.
  const onReviewing = (id: string, reviewing: boolean) => {
    const held = deferred.get(id);
    if (reviewing || !held) return;
    deferred.delete(id);
    const key = pairKey(held);
    if (steered.get(id) !== key) announce(id, held, key);
  };

  const onGit = (id: string, git: GitState) => {
    const running = inFlight(git);
    const key = pairKey(git);
    const prev = last.get(id);
    last.set(id, key);
    // A held red sample survives a resample of the same pair (e.g. a mergeability flip) — refreshed
    // so the release names the latest jobs — and is dropped once the pair moves on.
    const held = deferred.get(id);
    if (held) {
      if (pairKey(held) === key) deferred.set(id, git);
      else deferred.delete(id);
    }
    // Jobs seen running again are a real new attempt (a rerun on the same head): forget the last
    // announcement so a repeat red is announced. Samples without job data keep the suppression.
    if (running) steered.delete(id);
    if (prev === undefined || prev === key || steered.get(id) === key) return;
    if (!finished(git.checks) || running || !git.headSha) return;
    announce(id, git, key);
  };

  events.subscribe((event, data) => {
    if (event === "session:archived") onArchived((data as { id: string }).id);
    else if (event === "session:reviewing") {
      const { id, reviewing } = data as { id: string; reviewing: boolean };
      onReviewing(id, reviewing);
    } else if (event === "session:git") {
      const { id, git } = data as { id: string; git: GitState };
      onGit(id, git);
    }
  });

  return {
    noteCriticSteered: (id, headSha) => {
      criticSteered.set(id, headSha);
    },
  };
}
