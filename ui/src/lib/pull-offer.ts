import { pullRepo } from "$lib/api";
import { toasts } from "$lib/toasts.svelte";
import { m } from "$lib/paraglide/messages";

/** Execute a fast-forward pull of `repoPath`'s default branch and queue the
 *  appropriate outcome toast. The `branch` hint is optional — when omitted the
 *  server resolves the repo's default branch. */
export async function pullMainAndToast(repoPath: string, branch?: string): Promise<void> {
  const r = await pullRepo(repoPath, branch);
  if (r.ok) {
    toasts.info(
      r.updated
        ? m.toast_update_main_done({ branch: r.branch })
        : m.toast_update_main_uptodate({ branch: r.branch }),
    );
    return;
  }
  const b = r.branch ?? "";
  switch (r.reason) {
    // Benign non-fast-forwardable local states: the checkout simply isn't updatable
    // right now. Plain transient info, not a failure.
    case "wrong_branch":
      toasts.info(m.toast_update_main_wrong_branch({ branch: b }));
      return;
    case "dirty":
      toasts.info(m.toast_update_main_dirty({ branch: b }));
      return;
    case "diverged":
      toasts.info(m.toast_update_main_diverged({ branch: b }));
      return;
    // Genuine unexpected git/network failure: persistent + assertive.
    case "error":
      toasts.info(m.toast_update_main_failed(), {
        duration: null,
        alert: true,
        key: `update-main:${repoPath}`,
      });
      return;
  }
}

/** After a PR merge, offer a one-click fast-forward of the repo's local default-branch
 *  checkout. Auto-dismisses after 15s (paused while hovered/focused) and per-repo
 *  deduped so repeated merges to one repo re-arm a single offer. */
export function offerUpdateMain(repoPath: string, branch?: string): void {
  if (!repoPath) return;

  toasts.info(m.toast_update_main_offer(), {
    action: { label: m.toast_update_main_action(), run: () => pullMainAndToast(repoPath, branch) },
    duration: 15_000,
    key: `update-main-offer:${repoPath}`,
  });
}
