import type { SessionStore } from "./store";
import type { GitState } from "./forge/types";
import type { CiConclusion, Session } from "./types";

/** A terminal CI rollup pinned to the head it belongs to. */
interface CiObservation {
  headSha: string;
  conclusion: CiConclusion;
}

/**
 * The CI conclusion this observation carries, or null when it carries none (#2159).
 *
 * Terminal-rollup-only, on any PR state. `pending` is mid-flight and `none` is ambiguous — a
 * GitHub repo with zero defined workflows sits at a permanent `none`, so treating it as a
 * conclusion would score every no-CI repo as a failed push. Excluding `none` also excludes those
 * repos from the metric entirely, which is why no `noCi` guard is needed here.
 *
 * A `headSha` is required: without it the conclusion cannot be pinned to a head, and its absence
 * means there is no PR to have pushed to.
 */
function ciObservation(git: GitState): CiObservation | null {
  if (!git.headSha) return null;
  if (git.checks !== "success" && git.checks !== "failure") return null;
  return { headSha: git.headSha, conclusion: git.checks };
}

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
 * It also retains the first terminal CI conclusion it observes per session (#2159), which is the
 * only per-push CI result Shepherd keeps anywhere. Same first-write-wins discipline: the store
 * freezes it, so a re-run turning green, a later push, or a restart's replay cannot overwrite it.
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
  /** A terminal CI conclusion has been written for this session (#2159). Memory only — the real
   *  guarantee that it is never overwritten is the store's first-write-wins upsert. */
  ci: boolean;
}

/** What this observation could add to the row — the three independently-stamped facts. */
function wantedFrom(git: GitState, ci: CiObservation | null): Stamped {
  // `createdAt` is the forge's PR-opened epoch; it is absent on `state: "none"` and on payloads
  // that predate the field, so a PR-less session wants nothing.
  return { opened: git.createdAt != null, merged: git.state === "merged", ci: ci != null };
}

/** OR-merge of what is already stamped for a session with what this observation adds. */
function mergeStamped(seen: Stamped | undefined, want: Stamped): Stamped {
  return {
    opened: (seen?.opened ?? false) || want.opened,
    merged: (seen?.merged ?? false) || want.merged,
    ci: (seen?.ci ?? false) || want.ci,
  };
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
    return (want.opened && !seen.opened) || (want.merged && !seen.merged) || (want.ci && !seen.ci);
  }

  /** Handle one `session:git` observation. Never throws. */
  onGit(id: string, git: GitState): void {
    try {
      const ci = ciObservation(git);
      const want = wantedFrom(git, ci);
      if (!want.opened && !want.merged && !want.ci) return;
      if (!this.isNew(id, want)) return;
      const s = this.deps.store.get(id);
      if (!s) return;
      this.write(s, git, ci, want);
      this.stamped.set(id, mergeStamped(this.stamped.get(id), want));
    } catch (err) {
      console.warn(`[delivery] fact record failed for ${id}:`, err);
    }
  }

  /** Persist everything this observation newly carries. First-write-wins in the store, so a
   *  field already recorded keeps its earlier — and therefore truer — value. */
  private write(s: Session, git: GitState, ci: CiObservation | null, want: Stamped): void {
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
      // Written as a pair; the store keeps whichever conclusion landed first and pins the sha
      // to it, so a later push can never re-label an earlier one.
      firstCiHeadSha: ci?.headSha ?? null,
      firstCiConclusion: ci?.conclusion ?? null,
      now,
    });
  }

  /** Drop a session's in-memory stamp state on archive, so the map can't grow without bound. */
  forget(id: string): void {
    this.stamped.delete(id);
  }
}
