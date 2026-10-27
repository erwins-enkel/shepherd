import { m } from "#lib/paraglide/messages.js";
import type { TooltipExplanation } from "#lib/tooltips/content.js";
import type { UpNextPr, UpNextPrAction, UpNextPrBand } from "#lib/types.js";
import { buttonAction, ciShown, mergeBlock } from "./up-next-prs";

// The words for Up Next's PR rows and preview, shared by both so they never drift.

export function prBandTitle(band: UpNextPrBand): string {
  if (band === "ready") return m.upnext_pr_band_ready();
  if (band === "review") return m.upnext_pr_band_review();
  if (band === "blocked") return m.upnext_pr_band_blocked();
  return m.upnext_pr_band_dependabot();
}

export function actionLabel(action: UpNextPrAction): string {
  if (action === "merge") return m.prspanel_merge_button();
  if (action === "review") return m.prspanel_review_button();
  if (action === "fix") return m.upnext_pr_action_fix();
  if (action === "dependabot_rebase") return m.prspanel_rebase_button();
  return m.upnext_pr_action_approve();
}

export function ciWord(pr: UpNextPr): string {
  const ci = ciShown(pr);
  if (ci === "green") return m.upnext_pr_ci_green();
  if (ci === "red") return m.upnext_pr_ci_red();
  if (ci === "running") return m.upnext_pr_ci_running();
  return m.upnext_pr_ci_none();
}

const baseOf = (pr: UpNextPr) => pr.baseRefName ?? "main";

/** Why merging is locked right now, or null when merging is the next action. */
export function mergeBlockLine(pr: UpNextPr): string | null {
  const block = mergeBlock(pr);
  if (block === null) return null;
  const base = baseOf(pr);
  if (block === "conflict") return m.upnext_pr_why_conflict({ base });
  if (block === "behind") return m.upnext_pr_why_behind({ base });
  if (block === "ci_failed") return m.upnext_pr_why_ci_failed();
  if (block === "workflow_approval") return m.upnext_pr_why_workflow_approval();
  if (block === "review") return m.upnext_pr_why_review();
  if (block === "mergeability") return m.upnext_pr_why_mergeability();
  return m.upnext_pr_why_ci_running();
}

/** What the fix session will do for this PR. */
export function fixSummary(pr: UpNextPr): string {
  const args = { number: pr.number, base: baseOf(pr) };
  if (pr.blockReason === "conflict") return m.upnext_pr_tip_fix_conflict(args);
  if (pr.blockReason === "behind") return m.upnext_pr_tip_fix_behind(args);
  return m.upnext_pr_tip_fix_ci(args);
}

/** The action button's explanation: what it does and what follows. A disabled button (CI still
 *  running) says what it waits for instead. */
export function actionTip(pr: UpNextPr, mergeFailed = false): TooltipExplanation {
  const action = buttonAction(pr, mergeFailed);
  const title = actionLabel(action);
  if (pr.action === null)
    return {
      title,
      summary: action === "fix" ? m.upnext_pr_fix_locked() : (mergeBlockLine(pr) ?? ""),
      sections: [],
    };
  const number = pr.number;
  const [summary, then] =
    action === "merge"
      ? [m.upnext_pr_tip_merge_summary({ number }), m.upnext_pr_tip_merge_then()]
      : action === "review"
        ? [m.upnext_pr_tip_review_summary({ number }), m.upnext_pr_tip_review_then()]
        : action === "fix"
          ? [fixSummary(pr), m.upnext_pr_tip_fix_then()]
          : action === "dependabot_rebase"
            ? [m.upnext_pr_tip_rebase_summary({ number }), m.upnext_pr_tip_rebase_then()]
            : [m.upnext_pr_tip_approve_summary({ number }), m.upnext_pr_tip_approve_then()];
  return { title, summary, sections: [{ label: m.upnext_pr_tip_then(), text: then }] };
}
