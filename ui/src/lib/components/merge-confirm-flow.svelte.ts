import { MergeRefusedError } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import { toasts } from "#lib/toasts.svelte.js";
import {
  applyMergeGate,
  mergeConfirmPayload,
  type MergeConfirmContext,
  type MergeConfirmPayload,
} from "./merge-confirm";

let flowSeq = 0;

/** Runs one manual merge behind the confirmation dialog (#2299).
 *
 *  Every manual merge entry point owns one of these, so the parts that must not drift — the
 *  in-flight lock, what happens to a refused confirmation, and the fact that a refusal RE-STATES
 *  the responsibility instead of giving up — are written once.
 *
 *  Confirming closes the dialog at once and runs the merge in the background behind a sticky
 *  progress toast, so the operator gets the rest of the UI back while the host merges.
 *
 *  `run` handles its own ordinary failures (each entry point surfaces those its own way: a toast,
 *  the rail's error line, the row's red text) and resolves. It rethrows ONLY
 *  {@link MergeRefusedError}, which is the one failure this flow owns. */
export class MergeConfirmFlow {
  /** The open dialog's context; null = closed. */
  ctx = $state<MergeConfirmContext | null>(null);
  /** A merge is in flight — nothing can open or start a second one from this flow. */
  busy = $state(false);
  /** Why the last confirmation was refused; cleared on every open and every fresh attempt. */
  error = $state<string | null>(null);

  #run: ((confirm: MergeConfirmPayload) => Promise<void>) | null = null;
  /** Mounted MergeConfirmHosts rendering this flow — a refusal can only reopen a dialog into one. */
  #hosts = 0;
  readonly #progressKey = `merge-progress:${++flowSeq}`;

  /** Called by MergeConfirmHost while mounted; returns the detach. */
  attach(): () => void {
    this.#hosts++;
    return () => {
      this.#hosts--;
    };
  }

  open(ctx: MergeConfirmContext, run: (confirm: MergeConfirmPayload) => Promise<void>): void {
    if (this.busy) return; // the progress toast already says a merge is on its way
    this.ctx = ctx;
    this.error = null;
    this.#run = run;
  }

  close(): void {
    if (this.busy) return;
    this.#reset();
  }

  async confirm(): Promise<void> {
    const ctx = this.ctx;
    const run = this.#run;
    if (!ctx || !run || this.busy) return;
    this.busy = true;
    this.#reset();
    toasts.info(
      ctx.repoLabel
        ? m.mergeconfirm_progress_repo({ repo: ctx.repoLabel, number: ctx.number })
        : m.mergeconfirm_progress({ number: ctx.number }),
      { sticky: true, key: this.#progressKey },
    );
    try {
      await run(mergeConfirmPayload(ctx));
    } catch (err) {
      if (err instanceof MergeRefusedError) this.#refused(ctx, run, err);
    } finally {
      toasts.dismissKey(this.#progressKey);
      this.busy = false;
    }
  }

  /** Re-state, don't drop: the operator answers the responsibility the server just derived, and
   *  the dialog's arm delay restarts because `ctx` is replaced. The refusal lands before the host
   *  merges anything, so reopening follows the close within a second or two. */
  #refused(
    ctx: MergeConfirmContext,
    run: (confirm: MergeConfirmPayload) => Promise<void>,
    err: MergeRefusedError,
  ): void {
    const error =
      err.code === "merge_confirm_stale" ? m.mergeconfirm_stale() : m.mergeconfirm_required();
    if (this.#hosts === 0) {
      // The entry point unmounted meanwhile — no dialog can render, so say it in a toast.
      toasts.info(error, { alert: true });
      return;
    }
    this.ctx = applyMergeGate(ctx, err.gate, err.pr);
    this.#run = run;
    this.error = error;
  }

  #reset(): void {
    this.ctx = null;
    this.#run = null;
    this.error = null;
  }
}
