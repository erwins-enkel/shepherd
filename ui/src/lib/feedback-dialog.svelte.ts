import type { FeedbackKind } from "$lib/feedback-link";

// Shared store for the feedback modal. Call openFeedback(kind) to open it;
// closeFeedback() to dismiss. Mount <FeedbackDialog> once in +page.svelte and
// gate it on feedbackDialog.kind.

let kind = $state<FeedbackKind | null>(null);

export const feedbackDialog = {
  get kind() {
    return kind;
  },
};

export function openFeedback(k: FeedbackKind): void {
  kind = k;
}

export function closeFeedback(): void {
  kind = null;
}
