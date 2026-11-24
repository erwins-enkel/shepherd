import { m } from "#lib/paraglide/messages.js";
import type { ReviewFeedbackItem } from "#lib/types.js";

/** Where a review-feedback item sits (#4126): a review's verdict, an inline comment's
 *  `path:line`, or a PR conversation comment. `mono` marks a file location (an identifier). */
export function feedbackWhere(item: ReviewFeedbackItem): { text: string; mono: boolean } {
  if (item.kind === "rc") {
    if (!item.path) return { text: m.reviewfeedback_kind_inline(), mono: false };
    return { text: item.line != null ? `${item.path}:${item.line}` : item.path, mono: true };
  }
  if (item.kind === "ic") return { text: m.reviewfeedback_kind_comment(), mono: false };
  switch (item.reviewState) {
    case "approved":
      return { text: m.reviewfeedback_state_approved(), mono: false };
    case "changes_requested":
      return { text: m.reviewfeedback_state_changes_requested(), mono: false };
    case "commented":
      return { text: m.reviewfeedback_state_commented(), mono: false };
    default:
      return { text: m.reviewfeedback_kind_review(), mono: false };
  }
}

/** "N review comments" with the right plural. */
export function feedbackCountLabel(count: number): string {
  return count === 1 ? m.reviewfeedback_badge_one() : m.reviewfeedback_badge_other({ count });
}
