import { pullRepo } from "$lib/api";
import { toasts } from "$lib/toasts.svelte";
import { m } from "$lib/paraglide/messages";

/** After a PR merge, offer a one-click fast-forward of the repo's local default-branch
 *  checkout. Persistent + per-repo deduped so the only path to the action doesn't
 *  expire and repeated merges to one repo collapse to a single offer. */
export function offerUpdateMain(repoPath: string, branch?: string): void {
  if (!repoPath) return;

  async function run(): Promise<void> {
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

  toasts.info(m.toast_update_main_offer(), {
    action: { label: m.toast_update_main_action(), run: () => run() },
    duration: null,
    key: `update-main-offer:${repoPath}`,
  });
}
