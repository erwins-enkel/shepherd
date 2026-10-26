<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { yesNoQuestions } from "#lib/assistant-chat.js";

  // Yes/No buttons under a reply that ends on explicit (yes/no) questions. One question sends at
  // once; several collect an answer each, then send together.
  let {
    questions,
    answers,
    onreply,
    onsendall,
  }: {
    questions: ReturnType<typeof yesNoQuestions>;
    answers: Record<number, string>;
    onreply: (index: number, value: string) => void;
    onsendall: () => void;
  } = $props();
</script>

<div class="ac-replies">
  {#each questions as question, i (i)}
    <div role="group" aria-label={question.text} class="ac-answer">
      {#if questions.length > 1}<p>{question.number}. {question.text}</p>{/if}
      <button
        type="button"
        class="gbtn"
        aria-pressed={answers[i] === m.assistant_chat_yes()}
        onclick={() => onreply(i, m.assistant_chat_yes())}>{m.assistant_chat_yes()}</button
      >
      <button
        type="button"
        class="gbtn"
        aria-pressed={answers[i] === m.assistant_chat_no()}
        onclick={() => onreply(i, m.assistant_chat_no())}>{m.assistant_chat_no()}</button
      >
    </div>
  {/each}
  {#if questions.length > 1}
    <button
      type="button"
      class="gbtn primary"
      disabled={!questions.every((_, i) => answers[i])}
      onclick={onsendall}>{m.assistant_chat_send_answers()}</button
    >
  {/if}
</div>

<style>
  .ac-replies {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .ac-answer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .ac-answer p {
    flex-basis: 100%;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .ac-answer .gbtn[aria-pressed="true"] {
    border-color: var(--color-amber);
    color: var(--color-amber);
    background: var(--color-inset);
  }
</style>
