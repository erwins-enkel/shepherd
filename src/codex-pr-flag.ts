import type { EventHub } from "./events";
import type { SessionStore } from "./store";
import type { GitForge, GitState } from "./forge/types";

/** Give up on a session after this many failed label attempts in one process. */
const MAX_ATTEMPTS = 3;
const LABEL = "codex-authored";

/**
 * Flag Codex-authored session PRs with the `codex-authored` label so reviewers give them
 * the extra care they warrant.
 *
 * Why server-side (not a GitHub Actions workflow): authorship can't be inferred from commit
 * metadata. Claude Code deterministically stamps a `Co-authored-by: Claude` trailer, but Codex
 * leaves no fingerprint — its commits are indistinguishable from a plain human commit. The only
 * authoritative signal is Shepherd's own `agentProvider`, which lives here. (Replaces the old
 * `.github/workflows/codex-pr-flag.yml`, which keyed off a Codex trailer that is never present.)
 *
 * Reliability vs `wirePrOpenedTelemetry`: this does NOT require a non-open → open transition. It
 * labels on the FIRST observed `open` state, so a PR already open when the process (re)starts is
 * still flagged. Idempotency + no subprocess storm on the frequent `session:git` churn
 * (checks/mergeable/review/headSha) are provided by three per-session in-process guards:
 *  - `done`: terminal — the label was applied OR we gave up after `MAX_ATTEMPTS`; never retried.
 *  - `busy`: an add is in flight — blocks a second overlapping attempt during the await.
 *  - `attempts`: transient-failure counter; bounded retries, then `done`.
 * A no-write-access repo therefore costs at most `MAX_ATTEMPTS` `gh` calls + warns, then stops.
 * `gh pr edit --add-label` is itself a no-op on an already-present label, covering cross-restart
 * re-adds (guards reset on restart).
 */
export function wireCodexPrFlag(deps: {
  events: Pick<EventHub, "subscribe">;
  store: Pick<SessionStore, "get">;
  resolveForge: (repoPath: string) => GitForge | null;
}): void {
  const done = new Set<string>();
  const busy = new Set<string>();
  const attempts = new Map<string, number>();

  deps.events.subscribe((event, data) => {
    if (event === "session:archived") {
      const { id } = data as { id: string };
      done.delete(id);
      busy.delete(id);
      attempts.delete(id);
      return;
    }
    if (event !== "session:git") return;

    const { id, git } = data as { id: string; git: GitState };
    if (done.has(id) || busy.has(id)) return;
    if (git.number == null || git.state !== "open") return;

    const s = deps.store.get(id);
    if (!s || (s.agentProvider ?? "claude") !== "codex") return;

    // `resolveForge` may return null (e.g. origin remote not yet added); non-GitHub hosts
    // omit `addPrLabel`. Either way there's nothing to flag with — skip.
    const forge = deps.resolveForge(s.repoPath);
    if (!forge?.addPrLabel) return;

    const prNumber = git.number;
    busy.add(id); // mark before awaiting so a concurrent session:git can't double-fire
    void forge
      .addPrLabel(prNumber, LABEL)
      .then(() => {
        busy.delete(id);
        done.add(id);
      })
      .catch((err: unknown) => {
        busy.delete(id);
        const n = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, n);
        console.warn(
          `[codex-pr-flag] labeling ${id} pr#${prNumber} failed (attempt ${n}/${MAX_ATTEMPTS}):`,
          err,
        );
        if (n >= MAX_ATTEMPTS) done.add(id); // give up — stop retrying on later git events
      });
  });
}
