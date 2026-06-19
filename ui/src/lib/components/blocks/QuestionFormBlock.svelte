<script lang="ts">
  import type { VisualBlock, RawAnswer } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { answerPlanQuestions } from "$lib/api";

  // `answerCtx` present → interactive (the planning-phase plan gate). Absent → read-only
  // (recap / Done panels, or once the session has left the planning phase).
  let {
    block,
    answerCtx,
  }: {
    block: Extract<VisualBlock, { type: "question-form" }>;
    answerCtx?: { sessionId: string; locked: boolean };
  } = $props();

  const interactive = $derived(!!answerCtx);

  // Per-question answer state (one block per component instance → keying by q.id is collision-free).
  // Built via helpers so the initializers don't statically capture the reactive `block` prop —
  // a question-form block is fixed for the life of an instance (keyed each by block.id).
  const initSingle = () =>
    Object.fromEntries(
      block.questions.filter((q) => q.kind === "single").map((q) => [q.id, null as number | null]),
    );
  const initMulti = () =>
    Object.fromEntries(
      block.questions.filter((q) => q.kind === "multi").map((q) => [q.id, [] as number[]]),
    );
  const initFreeform = () =>
    Object.fromEntries(block.questions.filter((q) => q.kind === "freeform").map((q) => [q.id, ""]));

  let single = $state<Record<string, number | null>>(initSingle());
  let multi = $state<Record<string, number[]>>(initMulti());
  let freeform = $state<Record<string, string>>(initFreeform());

  let submitting = $state(false);
  let submitted = $state(false);
  let delivered = $state(true);
  let errored = $state(false);

  const locked = $derived(submitting || submitted || !!answerCtx?.locked);
  const inputsDisabled = $derived(!interactive || locked);

  // Submit requires every single + freeform answered; multi is optional (empty = "none").
  const canSubmit = $derived.by(() => {
    if (!interactive || locked) return false;
    for (const q of block.questions) {
      if (q.kind === "single" && single[q.id] == null) return false;
      if (q.kind === "freeform" && !freeform[q.id]?.trim()) return false;
    }
    return true;
  });

  function kindLabel(kind: "single" | "multi" | "freeform"): string {
    if (kind === "single") return m.qform_kind_single();
    if (kind === "multi") return interactive ? m.qform_kind_multi_optional() : m.qform_kind_multi();
    return m.qform_kind_freeform();
  }

  function buildAnswers(): RawAnswer[] {
    return block.questions.map((q) => {
      if (q.kind === "single") {
        const i = single[q.id];
        return { blockId: block.id, questionId: q.id, optionIndices: i == null ? [] : [i] };
      }
      if (q.kind === "multi") {
        return {
          blockId: block.id,
          questionId: q.id,
          optionIndices: [...(multi[q.id] ?? [])].sort((a, b) => a - b),
        };
      }
      return { blockId: block.id, questionId: q.id, text: freeform[q.id] ?? "" };
    });
  }

  async function submit() {
    if (!answerCtx || !canSubmit) return;
    submitting = true;
    errored = false;
    try {
      const res = await answerPlanQuestions(answerCtx.sessionId, buildAnswers());
      delivered = res.delivered;
      submitted = true;
    } catch {
      errored = true;
    } finally {
      submitting = false;
    }
  }
</script>

<div class="qf-form">
  {#each block.questions as q (q.id)}
    <div class="qf-question">
      <p class="qf-prompt">{q.prompt}</p>
      <span class="qf-kind">{kindLabel(q.kind)}</span>
      {#if q.kind === "single" && q.options}
        <ul class="qf-options">
          {#each q.options as option, i (i)}
            <li class="qf-option">
              <label class="qf-label" class:qf-label-live={interactive}>
                <input
                  type="radio"
                  name={`${block.id}-${q.id}`}
                  value={i}
                  bind:group={single[q.id]}
                  disabled={inputsDisabled}
                />
                <span>{option}</span>
              </label>
            </li>
          {/each}
        </ul>
      {:else if q.kind === "multi" && q.options}
        <ul class="qf-options">
          {#each q.options as option, i (i)}
            <li class="qf-option">
              <label class="qf-label" class:qf-label-live={interactive}>
                <input
                  type="checkbox"
                  name={`${block.id}-${q.id}-${i}`}
                  value={i}
                  bind:group={multi[q.id]}
                  disabled={inputsDisabled}
                />
                <span>{option}</span>
              </label>
            </li>
          {/each}
        </ul>
      {:else if q.kind === "freeform"}
        <div class="qf-freeform">
          <input
            type="text"
            class="qf-freeform-input"
            class:qf-freeform-live={interactive}
            bind:value={freeform[q.id]}
            disabled={inputsDisabled}
            placeholder={m.qform_freeform_placeholder()}
          />
        </div>
      {/if}
    </div>
  {/each}

  {#if interactive}
    <div class="qf-actions">
      {#if submitted}
        <p class="qf-confirm" class:qf-confirm-warn={!delivered} role="status">
          {delivered ? m.qform_sent() : m.qform_sent_undelivered()}
        </p>
      {:else}
        {#if errored}
          <p class="qf-error" role="alert">{m.qform_submit_error()}</p>
        {/if}
        <button type="button" class="gbtn primary" onclick={submit} disabled={!canSubmit}>
          {submitting ? m.qform_submitting() : m.qform_submit()}
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .qf-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .qf-question {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .qf-prompt {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-ink);
    line-height: 1.5;
    font-weight: 500;
  }
  .qf-kind {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .qf-options {
    margin: 4px 0 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .qf-option {
    display: flex;
    align-items: center;
  }
  .qf-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-base);
    color: var(--color-ink);
    opacity: 0.7;
    cursor: default;
  }
  /* Interactive: full opacity + pointer affordance. */
  .qf-label-live {
    opacity: 1;
    cursor: pointer;
  }
  .qf-freeform {
    margin-top: 4px;
  }
  .qf-freeform-input {
    width: 100%;
    font-size: var(--fs-base);
    color: var(--color-muted);
    background: transparent;
    border: 1px solid var(--color-muted);
    border-radius: 4px;
    padding: 4px 8px;
    opacity: 0.5;
    cursor: default;
  }
  .qf-freeform-live {
    color: var(--color-ink-bright);
    background: var(--color-inset);
    border-color: var(--color-line);
    opacity: 1;
    cursor: text;
  }
  .qf-actions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .qf-confirm {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .qf-confirm-warn {
    color: var(--status-warn);
  }
  .qf-error {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--status-warn);
  }

  /* Canonical .gbtn recipe (scoped per-component; see /design-system). */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 4px 10px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
</style>
