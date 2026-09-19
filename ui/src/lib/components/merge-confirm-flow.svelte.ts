import { MergeRefusedError } from "$lib/api";
import { m } from "$lib/paraglide/messages";
import {
  applyMergeGate,
  mergeConfirmPayload,
  type MergeConfirmContext,
  type MergeConfirmPayload,
} from "./merge-confirm";

/** Runs one manual merge behind the confirmation dialog (#2299).
 *
 *  Every manual merge entry point owns one of these, so the parts that must not drift — the
 *  in-flight lock, what happens to a refused confirmation, and the fact that a refusal RE-STATES
 *  the responsibility instead of closing the dialog — are written once.
 *
 *  `run` handles its own ordinary failures (each entry point surfaces those its own way: a toast,
 *  the rail's error line, the row's red text) and resolves. It rethrows ONLY
 *  {@link MergeRefusedError}, which is the one failure this flow owns. */
export class MergeConfirmFlow {
  /** The open dialog's context; null = closed. */
  ctx = $state<MergeConfirmContext | null>(null);
  /** A merge is in flight — the dialog locks rather than closing, so nothing can start a second. */
  busy = $state(false);
  /** Why the last confirmation was refused; cleared on every open and every fresh attempt. */
  error = $state<string | null>(null);

  #run: ((confirm: MergeConfirmPayload) => Promise<void>) | null = null;

  open(ctx: MergeConfirmContext, run: (confirm: MergeConfirmPayload) => Promise<void>): void {
    this.ctx = ctx;
    this.error = null;
    this.busy = false;
    this.#run = run;
  }

  close(): void {
    if (this.busy) return; // a merge is already on its way to the host — closing would lie
    this.#reset();
  }

  async confirm(): Promise<void> {
    const ctx = this.ctx;
    const run = this.#run;
    if (!ctx || !run || this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      await run(mergeConfirmPayload(ctx));
      this.#reset();
    } catch (err) {
      if (!(err instanceof MergeRefusedError)) {
        this.#reset();
        return;
      }
      // Re-state, don't close: the operator answers the responsibility the server just derived,
      // and the dialog's arm delay restarts because `ctx` is replaced.
      this.ctx = applyMergeGate(ctx, err.gate, err.pr);
      this.error =
        err.code === "merge_confirm_stale" ? m.mergeconfirm_stale() : m.mergeconfirm_required();
    } finally {
      this.busy = false;
    }
  }

  #reset(): void {
    this.ctx = null;
    this.#run = null;
    this.error = null;
  }
}
