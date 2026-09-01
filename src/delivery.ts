import type { SessionStore } from "./store";
import type { GitState } from "./forge/types";

/**
 * DeliveryFactsService — records the PR timestamps the delivery metrics need (#2151 R1).
 *
 * It owns exactly ONE of the two stamp sites. `prOpenedAt` (and the PR number) can only come from
 * a forge observation, so it rides the `session:git` event. `mergedAt` is stamped by
 * `SessionStore.archive(id, 'merged')` instead — the merge train never emits `session:git` for a
 * session it merges (`AutoMergeService.doMerge` → `settleMergedSession` archives and drops the
 * session from the PR poller), so the event alone would exclude every autonomous merge. This
 * service still stamps `mergedAt` on an OBSERVED merge, which covers an out-of-band merge the
 * poller sees before teardown runs; `upsertDeliveryFact` is first-write-wins, so whichever site
 * fires first supplies the earliest — and therefore truest — observation.
 *
 * Two properties this must hold:
 *  1. **Cheap on the hot path.** `session:git` fires on every poll observation for every session,
 *     on the single Bun loop that also pumps the web terminal. Nothing already stamped is
 *     re-written: the per-session `stamped` map turns the steady state into a map lookup and an
 *     early return, never a DB write. The map is memory only — after a restart the first
 *     observation re-upserts once, which COALESCE absorbs.
 *  2. **Never throws.** A store failure here must not break the git event for its other
 *     subscribers (doc agent, post-merge steps, hold service).
 */
export interface DeliveryFactsServiceDeps {
  store: Pick<SessionStore, "get" | "upsertDeliveryFact">;
  now?: () => number;
}

/** What has already been persisted for a session, so a steady-state poll writes nothing. */
interface Stamped {
  opened: boolean;
  merged: boolean;
}

export class DeliveryFactsService {
  private stamped = new Map<string, Stamped>();
  private readonly now: () => number;

  constructor(private deps: DeliveryFactsServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** True when this observation carries something not already persisted for the session. */
  private isNew(id: string, want: Stamped): boolean {
    const seen = this.stamped.get(id);
    if (!seen) return true;
    return (want.opened && !seen.opened) || (want.merged && !seen.merged);
  }

  /** Handle one `session:git` observation. Never throws. */
  onGit(id: string, git: GitState): void {
    try {
      // A PR-less session has nothing to record. `createdAt` is the forge's PR-opened epoch; it is
      // absent on `state: "none"` and on payloads that predate the field.
      const want: Stamped = { opened: git.createdAt != null, merged: git.state === "merged" };
      if (!want.opened && !want.merged) return;
      if (!this.isNew(id, want)) return;
      const s = this.deps.store.get(id);
      if (!s) return;
      const now = this.now();
      this.deps.store.upsertDeliveryFact({
        sessionId: s.id,
        repoPath: s.repoPath,
        desig: s.desig,
        issueNumber: s.issueNumber ?? null,
        prNumber: git.number ?? null,
        createdAt: s.createdAt,
        prOpenedAt: git.createdAt ?? null,
        // The observation time, not the forge's merge timestamp — the forge payload carries no
        // mergedAt. Documented on the column; the archive stamp has the same caveat.
        mergedAt: want.merged ? now : null,
        now,
      });
      const seen = this.stamped.get(id);
      this.stamped.set(id, {
        opened: (seen?.opened ?? false) || want.opened,
        merged: (seen?.merged ?? false) || want.merged,
      });
    } catch (err) {
      console.warn(`[delivery] fact record failed for ${id}:`, err);
    }
  }

  /** Drop a session's in-memory stamp state on archive, so the map can't grow without bound. */
  forget(id: string): void {
    this.stamped.delete(id);
  }
}
