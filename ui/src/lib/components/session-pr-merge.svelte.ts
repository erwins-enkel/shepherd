import { SvelteSet } from "svelte/reactivity";
import { ApiError, MergeRefusedError, mergePr } from "#lib/api.js";
import { basename } from "#lib/basename.js";
import { m } from "#lib/paraglide/messages.js";
import { isConflicting } from "#lib/pr-conflict.js";
import { toasts } from "#lib/toasts.svelte.js";
import type { GitState } from "#lib/types.js";
import { mergeConfirmFromGit } from "./merge-confirm";
import { MergeConfirmFlow } from "./merge-confirm-flow.svelte";

/** The session a merge is for, as it stood when the confirmation opened. */
export interface SessionMergeTarget {
  sessionId: string;
  git: GitState | null | undefined;
  /** Session name for the merged toast. */
  name: string;
  repoPath: string;
}

// server message, when meaningful, becomes the {reason} clause; otherwise a generic fallback
function reason(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message.trim() : "";
  return msg || fallback;
}

/** A failed merge's message — the known local cause preferred over a raw server string. */
function mergeFailureText(e: unknown, git: GitState | null | undefined): string {
  if (e instanceof ApiError && e.code === "base_already_merged")
    return m.gitrail_merge_failed_base_merged();
  if (e instanceof ApiError && e.code === "stack_untested")
    return m.gitrail_merge_failed_stack_untested();
  if (git?.checks === "failure") return m.gitrail_merge_failed_checks();
  if (git && isConflicting(git)) return m.gitrail_merge_failed_unmergeable();
  return m.gitrail_merge_failed({ reason: reason(e, m.gitrail_merge()) });
}

/** A session's manual merge behind the confirmation dialog (#2299), for the merge row (#3540).
 *  The owner renders `flow` through MergeConfirmHost and shows `error`; `busy` covers the
 *  request after confirmation.
 *
 *  One instance serves every session the Viewport shows, and the merge runs in the background, so
 *  the operator can switch sessions mid-request. `busy` and `error` therefore belong to the session
 *  the merge was FOR: another session never shows its state, and a failure that lands after a
 *  switch is toasted instead of written to the wrong row. */
export class SessionPrMerge {
  /** Replaced when a different session merges while one is in flight — see merge(). */
  flow = $state(new MergeConfirmFlow());
  /** Sessions whose merge request is in flight — several, once the operator switches and merges on. */
  readonly #inFlight = new SvelteSet<string>();
  #error = $state<{ sessionId: string; text: string } | null>(null);
  readonly #current: () => string;

  /** `current` reads the session the owner shows now. */
  constructor(current: () => string) {
    this.#current = current;
  }

  get busy(): boolean {
    return this.#inFlight.has(this.#current());
  }

  /** Why the current session's last merge failed; cleared when the next one opens. */
  get error(): string | null {
    return this.#error?.sessionId === this.#current() ? this.#error.text : null;
  }

  merge(target: SessionMergeTarget): void {
    if (this.#inFlight.has(target.sessionId)) return;
    const ctx = mergeConfirmFromGit(target.git, basename(target.repoPath));
    if (!ctx) return;
    // Everything the merge and its toast act on is captured NOW, at dialog-open time: the
    // Viewport rebinds on a session switch and the confirmation is answered later, so a live
    // read could merge a different session.
    const t = { ...target };
    this.#error = null;
    // Another session's merge still holds the flow: give this one its own.
    if (this.flow.busy) this.flow = new MergeConfirmFlow();
    this.flow.open(ctx, async (confirm) => {
      this.#inFlight.add(t.sessionId);
      try {
        await mergePr(t.sessionId, { deleteBranch: true, confirm });
        // Only a note: the merge row, now MERGED, carries the next step (Decommission).
        toasts.info(m.toast_merged({ name: t.name || t.sessionId }), {
          key: `pr-merge:${t.sessionId}`,
        });
      } catch (e) {
        if (e instanceof MergeRefusedError) throw e; // the flow reopens the re-stated dialog
        const text = mergeFailureText(e, t.git);
        if (t.sessionId === this.#current()) this.#error = { sessionId: t.sessionId, text };
        else toasts.info(text, { alert: true, key: `pr-merge:${t.sessionId}` });
      } finally {
        this.#inFlight.delete(t.sessionId);
      }
    });
  }

  /** Session switch: drop the stale error and close an unanswered confirmation (a merge
   *  already in flight runs on behind its progress toast). */
  reset(): void {
    this.flow.close();
    this.#error = null;
  }
}
