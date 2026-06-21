<script lang="ts">
  import type { FeedbackKind } from "$lib/feedback-link";
  import { buildIssueUrl } from "$lib/feedback-link";
  import { feedbackDialog, closeFeedback } from "$lib/feedback-dialog.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  let title = $state("");
  let details = $state("");

  // The dialog component stays mounted (only its content is gated on the kind),
  // so its state survives close. Clear the fields each time it (re)opens, else
  // the previous report's title/details are still there on the next open.
  $effect(() => {
    if (feedbackDialog.kind) {
      title = "";
      details = "";
    }
  });

  const headingFor: Record<FeedbackKind, () => string> = {
    bug: m.feedback_dialog_title_bug,
    feature: m.feedback_dialog_title_feature,
    feedback: m.feedback_dialog_title_feedback,
  };

  const detailsPlaceholderFor: Record<FeedbackKind, () => string> = {
    bug: m.feedback_dialog_details_placeholder_bug,
    feature: m.feedback_dialog_details_placeholder_feature,
    feedback: m.feedback_dialog_details_placeholder_feedback,
  };

  function submit() {
    const k = feedbackDialog.kind;
    if (!k) return;
    window.open(buildIssueUrl(k, { title, description: details }), "_blank", "noopener,noreferrer");
    closeFeedback();
  }
</script>

{#if feedbackDialog.kind}
  {@const k = feedbackDialog.kind}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) closeFeedback();
    }}
  >
    <div
      class="card"
      role="dialog"
      aria-modal="true"
      aria-label={headingFor[k]()}
      use:dialog={{ onclose: closeFeedback }}
    >
      <div class="chead">
        <span class="micro">{headingFor[k]()}</span>
        <button type="button" class="x" onclick={closeFeedback} aria-label={m.common_close()}
          >✕</button
        >
      </div>

      <div class="field">
        <label class="field-label" for="feedback-title">{m.feedback_dialog_summary_label()}</label>
        <input
          id="feedback-title"
          type="text"
          placeholder={m.feedback_dialog_summary_placeholder()}
          bind:value={title}
        />
      </div>

      <div class="field">
        <label class="field-label" for="feedback-details">{m.feedback_dialog_details_label()}</label
        >
        <textarea
          id="feedback-details"
          rows="5"
          placeholder={detailsPlaceholderFor[k]()}
          bind:value={details}></textarea>
      </div>

      <p class="note">{m.feedback_dialog_note()}</p>

      <div class="actions">
        <button type="button" class="ghost" onclick={closeFeedback}>{m.common_cancel()}</button>
        <button type="button" class="run" onclick={submit}>{m.feedback_dialog_submit()}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }
  .card {
    width: min(480px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .chead {
    display: flex;
    align-items: center;
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field-label {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  input,
  textarea {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
  }
  .note {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.4;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
  }
  .ghost,
  .run {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .run {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      height: 100dvh;
      border: 0;
      overflow-y: auto;
    }
  }
</style>
