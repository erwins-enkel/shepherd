<script lang="ts">
  import type { VisualBlock, RawAnswer } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { answerPlanQuestions } from "#lib/api.js";

  // Three modes. `answerCtx` present → interactive, answers POST to the planning-phase plan gate.
  // `onanswer` present → interactive, answers are handed to the PARENT instead (the New Task
  // shaping round, #2158 — it has no session to post to yet). Neither → read-only (recap / Done
  // panels, or once the session has left the planning phase).
  let {
    block,
    answerCtx,
    onanswer,
    submitLabel,
  }: {
    block: Extract<VisualBlock, { type: "question-form" }>;
    answerCtx?: { sessionId: string; locked: boolean };
    onanswer?: (answers: RawAnswer[]) => void;
    submitLabel?: string;
  } = $props();

  const interactive = $derived(!!answerCtx || !!onanswer);

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
  // `allowOther` questions (AskUserQuestion, #3165): an extra "Other…" choice that reveals a text
  // input. Single: the radio group's value OTHER. Multi: its own checkbox. The plan gate never sets
  // `allowOther`, so its forms are unchanged.
  const OTHER = -1;
  let otherChecked = $state<Record<string, boolean>>({});
  let otherText = $state<Record<string, string>>({});
  const otherOn = (q: { id: string; kind: string }) =>
    q.kind === "single" ? single[q.id] === OTHER : !!otherChecked[q.id];
  const otherFilled = (id: string) => !!otherText[id]?.trim();

  let submitting = $state(false);
  let submitted = $state(false);
  let delivered = $state(true);
  let errored = $state(false);

  const locked = $derived(submitting || submitted || !!answerCtx?.locked);
  const inputsDisabled = $derived(!interactive || locked);

  // Submit requires every single + freeform answered; multi is optional (empty = "none") — except
  // with `allowOther`, where a multi needs a choice too (a "none" goes through Other) and a picked
  // Other needs its text.
  type Question = (typeof block.questions)[number];
  function otherComplete(q: Question): boolean {
    if (otherOn(q) && !otherFilled(q.id)) return false;
    return q.kind !== "multi" || !!multi[q.id]?.length || otherOn(q);
  }
  function answered(q: Question): boolean {
    if (q.kind === "single" && single[q.id] == null) return false;
    if (q.kind === "freeform" && !freeform[q.id]?.trim()) return false;
    return !q.allowOther || otherComplete(q);
  }
  const canSubmit = $derived(interactive && !locked && block.questions.every(answered));

  function kindLabel(kind: "single" | "multi" | "freeform", required = false): string {
    if (kind === "single") return m.qform_kind_single();
    if (kind === "multi")
      return interactive && !required ? m.qform_kind_multi_optional() : m.qform_kind_multi();
    return m.qform_kind_freeform();
  }

  function buildAnswers(): RawAnswer[] {
    return block.questions.map((q) => {
      const other = q.allowOther && otherOn(q) ? { text: otherText[q.id]?.trim() ?? "" } : {};
      if (q.kind === "single") {
        const i = single[q.id];
        const indices = i == null || i === OTHER ? [] : [i];
        return { blockId: block.id, questionId: q.id, optionIndices: indices, ...other };
      }
      if (q.kind === "multi") {
        return {
          blockId: block.id,
          questionId: q.id,
          optionIndices: [...(multi[q.id] ?? [])].sort((a, b) => a - b),
          ...other,
        };
      }
      return { blockId: block.id, questionId: q.id, text: freeform[q.id] ?? "" };
    });
  }

  async function submit() {
    if (!canSubmit) return;
    // Callback mode: no request, no delivery state — the parent owns what happens next. Lock the
    // form so a double-click can't emit the same round twice.
    if (onanswer) {
      submitted = true;
      onanswer(buildAnswers());
      return;
    }
    if (!answerCtx) return;
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
      {#if q.header}<span class="qf-header">{q.header}</span>{/if}
      <p class="qf-prompt">{q.prompt}</p>
      <span class="qf-kind">{kindLabel(q.kind, !!q.allowOther)}</span>
      {#if (q.kind === "single" || q.kind === "multi") && q.options}
        <ul class="qf-options">
          {#each q.options as option, i (i)}
            <li class="qf-option">
              <label class="qf-label" class:qf-label-live={interactive}>
                {#if q.kind === "single"}
                  <input
                    type="radio"
                    name={`${block.id}-${q.id}`}
                    value={i}
                    bind:group={single[q.id]}
                    disabled={inputsDisabled}
                  />
                {:else}
                  <input
                    type="checkbox"
                    name={`${block.id}-${q.id}-${i}`}
                    value={i}
                    bind:group={multi[q.id]}
                    disabled={inputsDisabled}
                  />
                {/if}
                <span class="qf-option-text">
                  <span>{option}</span>
                  {#if q.optionDescriptions?.[i] && q.optionDescriptions[i] !== option}
                    <span class="qf-option-desc">{q.optionDescriptions[i]}</span>
                  {/if}
                </span>
              </label>
            </li>
          {/each}
          {#if q.allowOther}
            <li class="qf-option">
              <label class="qf-label" class:qf-label-live={interactive}>
                {#if q.kind === "single"}
                  <input
                    type="radio"
                    name={`${block.id}-${q.id}`}
                    value={OTHER}
                    bind:group={single[q.id]}
                    disabled={inputsDisabled}
                  />
                {:else}
                  <input
                    type="checkbox"
                    name={`${block.id}-${q.id}-other`}
                    bind:checked={otherChecked[q.id]}
                    disabled={inputsDisabled}
                  />
                {/if}
                <span>{m.qform_other()}</span>
              </label>
            </li>
            {#if otherOn(q)}
              <li class="qf-freeform">
                <input
                  type="text"
                  class="qf-freeform-input qf-freeform-live"
                  bind:value={otherText[q.id]}
                  disabled={inputsDisabled}
                  maxlength={500}
                  aria-label={`${q.prompt}: ${m.qform_other()}`}
                  placeholder={m.qform_other_placeholder()}
                />
              </li>
            {/if}
          {/if}
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
      {#if submitted && answerCtx}
        <p class="qf-confirm" class:qf-confirm-warn={!delivered} role="status">
          {delivered ? m.qform_sent() : m.qform_sent_undelivered()}
        </p>
      {:else}
        {#if errored}
          <p class="qf-error" role="alert">{m.qform_submit_error()}</p>
        {/if}
        <button type="button" class="gbtn primary" onclick={submit} disabled={!canSubmit}>
          {submitting ? m.qform_submitting() : (submitLabel ?? m.qform_submit())}
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
  .qf-header {
    align-self: flex-start;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-amber);
  }
  .qf-option-text {
    display: flex;
    flex-direction: column;
  }
  .qf-option-desc {
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
