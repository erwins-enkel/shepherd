import type { EventHub } from "./events";
import type { SessionStore } from "./store";
import type { GitState } from "./forge/types";
import type { TelemetryService } from "./telemetry";

/**
 * Emit `pr_opened` the first time a session's tracked PR transitions to open.
 *
 * A PR is opened externally by the agent (`gh pr create`); Shepherd only *discovers* it by
 * polling, so the git-state transition broadcast as `session:git` is the detection substrate.
 * Guards:
 *  - transition: emit only on a genuine previously-seen-non-open → open transition (with a PR number).
 *  - cold-start skip: if no prior state was seen for the session (fresh process, or a PR already
 *    open before a restart), record the state WITHOUT emitting — a cold re-observation of a
 *    pre-existing open PR never false-fires.
 *  - once-per-session: an emitted set bounds emission to one per session per process. Combined with
 *    the single-threaded synchronous event dispatch, it also serializes the poller's concurrent
 *    tick()-vs-pollSession() refreshes so they cannot double-emit.
 * Counts are therefore approximate across restarts — consistent with the anonymity design (spec §7).
 */
export function wirePrOpenedTelemetry(deps: {
  events: Pick<EventHub, "subscribe">;
  store: Pick<SessionStore, "get">;
  telemetry: Pick<TelemetryService, "event">;
}): void {
  const lastState = new Map<string, GitState["state"]>();
  const emitted = new Set<string>();
  deps.events.subscribe((event, data) => {
    if (event === "session:archived") {
      const { id } = data as { id: string };
      lastState.delete(id);
      emitted.delete(id);
      return;
    }
    if (event !== "session:git") return;
    const { id, git } = data as { id: string; git: GitState };
    const prev = lastState.get(id);
    lastState.set(id, git.state);
    if (emitted.has(id)) return;
    if (prev !== undefined && prev !== "open" && git.state === "open" && git.number != null) {
      const s = deps.store.get(id);
      if (!s) return;
      emitted.add(id);
      deps.telemetry.event("pr_opened", {
        agentProvider: s.agentProvider ?? "claude",
        isDraft: git.isDraft ?? false,
      });
    }
  });
}
