import { ApiError, MergeRefusedError, mergePr } from "#lib/api.js";
import { basename } from "#lib/basename.js";
import { m } from "#lib/paraglide/messages.js";
import { isConflicting } from "#lib/pr-conflict.js";
import { pullMainAndToast } from "#lib/pull-offer.js";
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
  /** With `repoPath` set, the merged toast offers "Decommission & update local". */
  isolated: boolean;
  /** The local default branch that combined action fast-forwards. */
  baseBranch: string;
  /** Offer to tear down the merged session; called with its id. */
  ondecommission?: (id: string) => void;
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

// Local-forge merges get a plain confirmation; remote-forge merges add a one-click Decommission,
// upgraded to "Decommission & update local" for isolated sessions (which also fast-forwards the
// local default branch).
function showMergedToast(kind: string, t: SessionMergeTarget) {
  const text = m.toast_merged({ name: t.name || t.sessionId });
  if (kind === "local") {
    toasts.info(text);
    return;
  }
  const update = t.isolated && !!t.repoPath;
  toasts.info(text, {
    action: {
      label: update ? m.gitrail_decommission_update_action() : m.gitrail_decommission_action(),
      run: () => {
        t.ondecommission?.(t.sessionId);
        if (update) pullMainAndToast(t.repoPath, t.baseBranch);
      },
    },
    duration: 15_000,
    key: `decommission-offer:${t.sessionId}`,
  });
}

/** A session's manual merge behind the confirmation dialog (#2299), for the merge row (#3540).
 *  The owner renders `flow` through MergeConfirmHost and shows `error`; `busy` covers the
 *  request after confirmation. */
export class SessionPrMerge {
  readonly flow = new MergeConfirmFlow();
  busy = $state(false);
  /** Why the last merge failed; cleared when the next one opens. */
  error = $state<string | null>(null);

  merge(target: SessionMergeTarget): void {
    if (this.busy) return;
    const ctx = mergeConfirmFromGit(target.git, basename(target.repoPath));
    if (!ctx) return;
    // Everything the merge and its toast act on is captured NOW, at dialog-open time: the
    // Viewport rebinds on a session switch and the confirmation is answered later, so a live
    // read could merge — or fast-forward the checkout of — a different session. The toast lives
    // 15s, which is why the FF target and isolation must travel together with the id.
    const t = { ...target };
    this.error = null;
    this.flow.open(ctx, async (confirm) => {
      this.busy = true;
      this.error = null;
      try {
        await mergePr(t.sessionId, { deleteBranch: true, confirm });
        showMergedToast(t.git?.kind ?? "github", t);
      } catch (e) {
        if (e instanceof MergeRefusedError) throw e; // the dialog re-states and stays open
        this.error = mergeFailureText(e, t.git);
      } finally {
        this.busy = false;
      }
    });
  }

  /** Session switch: drop the stale error and close an unanswered confirmation (a merge
   *  already in flight keeps its dialog until it settles). */
  reset(): void {
    this.flow.close();
    this.error = null;
  }
}
