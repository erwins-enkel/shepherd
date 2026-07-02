import type { PostMergeSteps } from "./types";
import { getOutstandingManualSteps, setManualStepDone, dismissManualSteps } from "./api";

/** Scope owed records to the active repo chip filter (#owed): `repoFilter` is the set of
 *  selected repo paths, empty = all repos (unfiltered). Pure so both the Owed lens count badge
 *  (Herd.svelte) and the panel list (PostMergeStepsPanel) share one filter and can't drift.
 *  Mirrors every sibling consumer's `repoFilter.has(repoPath)` client-side scope (UpNextPanel,
 *  herdSessions). */
export function owedRecordsForRepo(
  records: PostMergeSteps[],
  repoFilter: ReadonlySet<string>,
): PostMergeSteps[] {
  if (repoFilter.size === 0) return records;
  return records.filter((r) => repoFilter.has(r.repoPath));
}

/** Lazy client store of durable post-merge steps still owed across merged sessions (#1061),
 *  populated when the Owed lens opens and refreshed on the `post-merge-steps:changed` WS event
 *  (wired in store.svelte.ts). Independent of the 48h Done window — owed steps persist until done. */
class PostMergeStepsStore {
  records = $state<PostMergeSteps[]>([]);
  loaded = $state(false);
  /** True once any `load()` attempt has completed (success or failure); lets a consumer tell
   *  in-flight (`!settled`) from finished. Invariant: `loaded === true` ⇒ success;
   *  `settled && !loaded` ⇒ the attempt failed. */
  settled = $state(false);
  /** In-flight guard (#1257): true while a `load()` GET is outstanding. Stops a viewport toggle (or
   *  any re-entrant caller — eager badge load, lens-open fallback, WS refresh) from firing a
   *  duplicate fetch before the first one resolves and flips `loaded`. */
  private loading = false;

  /** Re-fetch the outstanding set. On failure leaves the existing list untouched (next call retries). */
  async load() {
    if (this.loading) return; // a fetch is already in flight — don't duplicate it
    this.loading = true;
    try {
      this.records = await getOutstandingManualSteps();
      this.loaded = true;
    } catch {
      /* best-effort; the next load retries */
    } finally {
      this.settled = true;
      this.loading = false;
    }
  }

  /** Refresh only if already loaded — used by the live `post-merge-steps:changed` event so we don't
   *  eagerly fetch before the operator has ever opened the lens. */
  async refreshIfLoaded() {
    if (this.loaded) await this.load();
  }

  /** Tick / un-tick one step, then drop cleared records from the local list (optimistic on the
   *  server's returned record). */
  async setStepDone(sessionId: string, stepId: string, done: boolean) {
    const updated = await setManualStepDone(sessionId, stepId, done);
    this.applyUpdate(updated);
  }

  /** Dismiss a whole record (clear all its owed steps). */
  async dismiss(sessionId: string) {
    const updated = await dismissManualSteps(sessionId);
    this.applyUpdate(updated);
  }

  /** Replace the record in place, or remove it once it is cleared (no longer outstanding). */
  private applyUpdate(updated: PostMergeSteps) {
    if (updated.clearedAt != null) {
      this.records = this.records.filter((r) => r.sessionId !== updated.sessionId);
      return;
    }
    const i = this.records.findIndex((r) => r.sessionId === updated.sessionId);
    if (i === -1) this.records = [updated, ...this.records];
    else this.records[i] = updated;
  }
}
export const postMergeSteps = new PostMergeStepsStore();
