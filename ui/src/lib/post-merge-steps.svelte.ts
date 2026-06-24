import type { PostMergeSteps } from "./types";
import { getOutstandingManualSteps, setManualStepDone, dismissManualSteps } from "./api";

/** Lazy client store of durable post-merge steps still owed across merged sessions (#1061),
 *  populated when the Owed lens opens and refreshed on the `post-merge-steps:changed` WS event
 *  (wired in store.svelte.ts). Independent of the 48h Done window — owed steps persist until done. */
class PostMergeStepsStore {
  records = $state<PostMergeSteps[]>([]);
  loaded = $state(false);

  /** Re-fetch the outstanding set. On failure leaves the existing list untouched (next call retries). */
  async load() {
    try {
      this.records = await getOutstandingManualSteps();
      this.loaded = true;
    } catch {
      /* best-effort; the next load retries */
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
