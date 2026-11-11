import type { EventHub } from "./events";
import type { GitState, PrStatus } from "./forge/types";
import { isOperatorAssistant } from "./operator-assistant-core";
import { isShelved } from "./shelve";
import type { SessionStore } from "./store";
import type { Session } from "./types";

export interface MergeSteerDeps {
  /** Steer a LIVE pane only — never resume an exited agent just to tell it its PR merged. */
  reply: (id: string, text: string) => Promise<boolean>;
  /** The persisted PR cache at attach time (PrPoller.snapshot()), so a merge observed right after
   *  a restart is still announced and an already-merged PR never is. */
  seed?: Record<string, GitState>;
}

/** The agent-facing PR-merged steer. Typed into the PTY, so fixed English (ciFinishedSteer
 *  precedent). Exported for tests. */
export function mergedSteer(git: GitState): string {
  const base = git.baseRefName;
  const into = base ? ` into ${base}.` : ".";
  const fresh = base ? `origin/${base}` : "the PR's base";
  return (
    `Shepherd: PR #${git.number ?? "?"} merged${into} Your work has landed — ` +
    `don't push more commits to this branch. Any follow-up needs a fresh branch off ${fresh}.`
  );
}

/** Sessions the steer may address: a live, attended agent session. Auto sessions are archived
 *  (agent stopped) by the merge teardown, so a steer there would race a dying pane. */
function steerable(s: Session | null | undefined): s is Session {
  return (
    !!s &&
    !s.auto &&
    s.status !== "archived" &&
    !s.terminal &&
    !isOperatorAssistant(s) &&
    !isShelved(s)
  );
}

/**
 * Tell a live attended agent once when its PR goes open→merged — whoever merged it (session Merge
 * button, Backlog Merge, the host UI). The first sighting of a session only primes; `deps.seed`
 * pre-primes from the persisted cache. Repeated merged samples (the Merge button's own emit, then
 * the poller's) announce once.
 */
export function attachMergeSteer(
  events: EventHub,
  store: Pick<SessionStore, "get">,
  deps: MergeSteerDeps,
): void {
  const last = new Map<string, PrStatus["state"]>(
    Object.entries(deps.seed ?? {}).map(([id, git]) => [id, git.state]),
  );

  const onGit = (id: string, git: GitState) => {
    const prev = last.get(id);
    last.set(id, git.state);
    if (git.state !== "merged" || prev === undefined || prev === "merged") return;
    const s = store.get(id);
    if (!steerable(s)) return;
    void deps.reply(id, mergedSteer(git)).catch((err) => console.warn("[merge-steer] steer:", err));
  };

  events.subscribe((event, data) => {
    if (event === "session:archived") last.delete((data as { id: string }).id);
    else if (event === "session:git") {
      const { id, git } = data as { id: string; git: GitState };
      onGit(id, git);
    }
  });
}
