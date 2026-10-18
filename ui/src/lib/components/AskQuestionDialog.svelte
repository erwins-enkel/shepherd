<script lang="ts">
  import type { PendingAsk, RawAnswer } from "#lib/types.js";
  import { answerAsk } from "#lib/api.js";
  import { askToQuestionForm } from "#lib/askForm.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { m } from "#lib/paraglide/messages.js";
  import QuestionFormBlock from "./blocks/QuestionFormBlock.svelte";

  // The agent's AskUserQuestion dialog as a native form (#3165). The answer is typed into the real
  // terminal by the server, which then reports what landed. The parent unmounts this when the
  // block's `ask` disappears — e.g. the operator answered in the terminal first.
  let { sessionId, ask, onclose }: { sessionId: string; ask: PendingAsk; onclose: () => void } =
    $props();

  const block = $derived(askToQuestionForm(ask));

  async function onanswer(answers: RawAnswer[]) {
    // Captured first: onclose() unmounts this component, the request outlives it.
    const id = sessionId;
    const toolUseId = ask.toolUseId;
    // One keyed toast: "typing…" while the server types + verifies (up to ~10 s), then the verdict.
    const key = `ask:${toolUseId}`;
    onclose();
    toasts.info(m.ask_result_sending(), { key, sticky: true });
    try {
      const result = await answerAsk(id, toolUseId, answers);
      if (result === "verified") toasts.info(m.ask_result_verified(), { key });
      else
        toasts.info(result === "mismatch" ? m.ask_result_mismatch() : m.ask_result_unverified(), {
          key,
          alert: true,
        });
    } catch {
      toasts.info(m.ask_result_failed(), { key, alert: true });
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.ask_dialog_title()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.ask_dialog_title()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>
    <p class="hint">{m.ask_dialog_hint()}</p>
    {#key ask.toolUseId}
      <QuestionFormBlock {block} {onanswer} submitLabel={m.ask_dialog_submit()} />
    {/key}
  </div>
</div>

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
    width: min(560px, 92vw);
    max-height: 90dvh;
    overflow-y: auto;
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
  .hint {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      max-height: none;
      height: 100dvh;
      border: 0;
    }
  }
</style>
