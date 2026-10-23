import type { EventHub } from "./events";
import type { ChecksState, GitState } from "./forge/types";
import { isOperatorAssistant } from "./operator-assistant-core";
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
}

/** One check name as a short single line (names come from the repo's CI config). */
function cleanName(name: string): string {
  const flat = name.replace(/[\p{Cc}\s]+/gu, " ").trim();
  return flat.length > MAX_NAME_CHARS ? `${flat.slice(0, MAX_NAME_CHARS - 1)}…` : flat;
}

function failingChecks(git: GitState): string {
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

/** Sessions the steer may address: a live agent session with an open PR, not planning and not
 *  owned by the merge train (which steers its own rebase). */
function steerable(s: Session | null | undefined, git: GitState): s is Session {
  return (
    !!s &&
    s.status !== "archived" &&
    !s.terminal &&
    !isOperatorAssistant(s) &&
    s.planPhase !== "planning" &&
    s.mergingSince === null &&
    git.state === "open"
  );
}

/**
 * Push a CI-finished steer to the task agent when its PR's checks turn terminal (#2852), so an
 * agent waiting for CI needs no `gh pr checks --watch` / `gh run watch` of its own. Fires once per
 * announced `(headSha, checks)` pair — a rerun that flips red→green on the same head steers again. The
 * first sighting of a session only primes (a restart must not re-announce settled CI). A red PR
 * under autopilot is skipped: autopilot's CI_FIX_STEER already acts on it.
 */
export function attachCiSteer(
  events: EventHub,
  store: Pick<SessionStore, "get">,
  deps: CiSteerDeps,
): void {
  const last = new Map<string, string>();
  // Last pair actually announced: a rollup that flaps (pending again, a REST-fallback sample
  // without a head) and settles back on the same result must not announce it twice.
  const steered = new Map<string, string>();
  events.subscribe((event, data) => {
    if (event === "session:archived") {
      const { id } = data as { id: string };
      last.delete(id);
      steered.delete(id);
      return;
    }
    if (event !== "session:git") return;
    const { id, git } = data as { id: string; git: GitState };
    const key = `${git.headSha ?? ""}:${git.checks}`;
    const prev = last.get(id);
    last.set(id, key);
    if (prev === undefined || prev === key || steered.get(id) === key) return;
    if (!finished(git.checks) || !git.headSha) return;
    const s = store.get(id);
    if (!steerable(s, git)) return;
    if (git.checks === "failure" && deps.autopilotOn(s)) return;
    steered.set(id, key);
    void deps
      .reply(id, ciFinishedSteer(git))
      .catch((err) => console.warn("[ci-steer] steer:", err));
  });
}
