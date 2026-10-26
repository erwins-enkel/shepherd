import {
  ApiError,
  MergeRefusedError,
  mergeBacklogPr,
  refreshUpNext,
  requestDependabotRebase,
  startUpNextPrFix,
} from "./api";
import { mergeConfirmFromPr } from "./components/merge-confirm";
import { MergeConfirmFlow } from "./components/merge-confirm-flow.svelte";
import { m } from "./paraglide/messages";
import { toasts } from "./toasts.svelte";
import type { Steer, UpNextPr } from "./types";
import type { UpNextLaunchContext } from "./up-next-start.svelte";
import { upNextPrKey, upNextUi } from "./up-next-ui.svelte";

function mergeFailure(e: unknown): string {
  const code = e instanceof ApiError ? e.code : undefined;
  if (code === "base_already_merged") return m.prspanel_merge_failed_base_merged();
  if (code === "stack_untested") return m.prspanel_merge_failed_stack_untested();
  return m.prspanel_merge_failed();
}

function fixFailure(e: unknown, number: number): string {
  const code = e instanceof ApiError ? e.code : undefined;
  if (code === "head_not_in_repo") return m.upnext_pr_fix_fork({ number });
  if (code === "pr_in_flight") return m.upnext_pr_fix_in_flight({ number });
  return m.upnext_pr_fix_failed({ number });
}

/** Runs a waiting PR's one next action from either Up Next surface — the rail row or the
 *  preview — through the paths the Backlog PRs tab already uses. Each surface holds its own
 *  instance and renders `mergeFlow` through MergeConfirmHost. A merged or fixed PR is hidden
 *  locally (upNextUi.markActed) until the server's next snapshot drops it. */
export class UpNextPrActions {
  readonly mergeFlow = new MergeConfirmFlow();
  /** The PR key whose action is in flight; every action button disables meanwhile. */
  busy = $state<string | null>(null);
  #ctx: () => UpNextLaunchContext | null;

  constructor(ctx: () => UpNextLaunchContext | null) {
    this.#ctx = ctx;
  }

  /** Merge behind the confirmation (#2299), bound to the head the row was classified at. */
  merge(pr: UpNextPr) {
    if (this.busy) return;
    const key = upNextPrKey(pr);
    this.mergeFlow.open(mergeConfirmFromPr(pr, pr.repoLabel), async (confirm) => {
      this.busy = key;
      try {
        await mergeBacklogPr(pr.repoPath, pr.number, { deleteBranch: true, confirm });
        upNextUi.markActed(key);
        void refreshUpNext().catch(() => {});
      } catch (e) {
        if (e instanceof MergeRefusedError) throw e; // the dialog re-states the responsibility
        if (e instanceof ApiError && (e.code === "merge_enqueued" || e.code === "merge_pending")) {
          upNextUi.markActed(key);
          toasts.info(m.prspanel_merge_in_progress(), { key: "upnext-pr-merge" });
        } else {
          toasts.info(mergeFailure(e), { key: "upnext-pr-merge", alert: true });
        }
      } finally {
        this.busy = null;
      }
    });
  }

  review(pr: UpNextPr) {
    this.#ctx()?.onreviewpr?.(pr.repoPath, pr);
  }

  /** Start the push-only fix session; a steer's prompt leads the server-built fix assignment. */
  async fix(pr: UpNextPr, steer?: Steer) {
    if (this.busy) return;
    const key = upNextPrKey(pr);
    this.busy = key;
    try {
      await startUpNextPrFix(pr.repoPath, pr.number, steer?.text);
      upNextUi.markActed(key);
      toasts.info(m.upnext_pr_fix_started({ number: pr.number }), { key: "upnext-pr-fix" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "pr_in_flight") upNextUi.markActed(key);
      toasts.info(fixFailure(e, pr.number), { key: "upnext-pr-fix", alert: true });
    } finally {
      this.busy = null;
    }
  }

  /** Ask Dependabot to rebase its PR — once per PR. */
  async rebase(pr: UpNextPr) {
    const key = upNextPrKey(pr);
    if (this.busy || upNextUi.rebaseRequested.has(key)) return;
    this.busy = key;
    try {
      await requestDependabotRebase(pr.repoPath, pr.number);
      upNextUi.rebaseRequested.add(key);
      toasts.info(m.prspanel_rebase_requested(), { key: "upnext-pr-rebase" });
    } catch {
      toasts.info(m.prspanel_rebase_failed(), { key: "upnext-pr-rebase", alert: true });
    } finally {
      this.busy = null;
    }
  }
}
