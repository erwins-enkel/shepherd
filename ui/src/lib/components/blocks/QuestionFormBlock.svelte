<script lang="ts" module>
  /** A form's unsent inputs, keyed by question id — what `draft` seeds and `ondraft` reports. */
  export interface QuestionFormDraft {
    single: Record<string, number | null>;
    multi: Record<string, number[]>;
    freeform: Record<string, string>;
    otherChecked: Record<string, boolean>;
    otherText: Record<string, string>;
  }
</script>

<script lang="ts">
  import type { VisualBlock, RawAnswer } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { answerPlanQuestions } from "#lib/api.js";
  import { linkSegments } from "#lib/textLinks.js";
  import { untrack } from "svelte";

  // Three modes. `answerCtx` present → interactive, answers POST to the planning-phase plan gate.
  // `onanswer` present → interactive, answers are handed to the PARENT instead (the New Task
  // shaping round, #2158 — it has no session to post to yet). Neither → read-only (recap / Done
  // panels, or once the session has left the planning phase).
  let {
    block,
    answerCtx,
    onanswer,
    submitLabel,
    draft,
    ondraft,
  }: {
    block: Extract<VisualBlock, { type: "question-form" }>;
    answerCtx?: { sessionId: string; locked: boolean };
    /** Return false to unlock the form while preserving its draft after an unconfirmed reply. */
    onanswer?: (answers: RawAnswer[]) => void | boolean | Promise<void | boolean>;
    submitLabel?: string;
    /** Inputs to start from instead of empty ones — read once, like `block`. */
    draft?: QuestionFormDraft;
    /** Called with the current inputs whenever they change, so a parent can keep the draft. */
    ondraft?: (draft: QuestionFormDraft) => void;
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

  const seed = () => (draft ? $state.snapshot(draft) : null);
  const initial = seed();
  let single = $state<Record<string, number | null>>(initial?.single ?? initSingle());
  let multi = $state<Record<string, number[]>>(initial?.multi ?? initMulti());
  let freeform = $state<Record<string, string>>(initial?.freeform ?? initFreeform());
  // `allowOther` questions (AskUserQuestion, #3165): an extra "Other…" choice that reveals a text
  // input. Single: the radio group's value OTHER. Multi: its own checkbox. The plan gate never sets
  // `allowOther`, so its forms are unchanged.
  const OTHER = -1;
  let otherChecked = $state<Record<string, boolean>>(initial?.otherChecked ?? {});
  let otherText = $state<Record<string, string>>(initial?.otherText ?? {});
  $effect(() => {
    if (!ondraft) return;
    const current = $state.snapshot({ single, multi, freeform, otherChecked, otherText });
    untrack(() => ondraft(current));
  });
  const otherOn = (q: { id: string; kind: string }) =>
    q.kind === "single" ? single[q.id] === OTHER : !!otherChecked[q.id];
  const otherFilled = (id: string) => !!otherText[id]?.trim();
  // AskUserQuestion marks its suggested choice with a trailing "(Recommended)": shown as a tag
  // instead. Answers go by option index, so trimming the label changes nothing that is sent.
  const RECOMMENDED = /\s*\(recommended\)\s*$/i;
  const optionLabel = (option: string) => option.replace(RECOMMENDED, "");

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

  // Enter in a text field submits the whole form once every question is answered; until then it
  // moves focus to the first unanswered question (its Other text when that is what's missing).
  let formEl = $state<HTMLDivElement>();
  function onEnter(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.isComposing || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)
      return;
    e.preventDefault();
    if (canSubmit) {
      void submit();
      return;
    }
    const q = block.questions.find((x) => !answered(x));
    const el = q && formEl?.querySelector<HTMLElement>(`[data-qid="${CSS.escape(q.id)}"]`);
    if (!q || !el) return;
    const target =
      (otherOn(q) && el.querySelector<HTMLInputElement>("input.qf-other-input")) ||
      el.querySelector<HTMLInputElement>("input:not(:disabled)");
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }

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
      void Promise.resolve(onanswer(buildAnswers()))
        .then((accepted) => {
          submitted = accepted !== false;
        })
        .catch(() => {
          submitted = false;
          errored = true;
        });
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

<!-- Bare URLs in agent-written text open in a new tab. A link inside an option's <label> is
     interactive content, so clicking it follows the link without picking the option. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -- external, http(s)-only URL -->
{#snippet linked(text: string)}
  {#each linkSegments(text) as seg, i (i)}{#if seg.href}<a
        class="qf-link"
        href={seg.href}
        target="_blank"
        rel="noopener noreferrer">{seg.text}</a
      >{:else}{seg.text}{/if}{/each}
{/snippet}
<!-- eslint-enable svelte/no-navigation-without-resolve -->

<div class="qf-form" bind:this={formEl}>
  {#each block.questions as q (q.id)}
    <div class="qf-question" data-qid={q.id}>
      {#if q.header}<span class="qf-header">{q.header}</span>{/if}
      <p class="qf-prompt">{@render linked(q.prompt)}</p>
      <span class="qf-kind">{kindLabel(q.kind, !!q.allowOther)}</span>
      {#if (q.kind === "single" || q.kind === "multi") && q.options}
        <ul class="qf-options">
          {#each q.options as option, i (i)}
            {@const recommended = RECOMMENDED.test(option)}
            <li class="qf-option">
              <label class="qf-label" class:qf-label-live={interactive} class:qf-rec={recommended}>
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
                  <span class="qf-option-label">{optionLabel(option)}</span>
                  {#if q.optionDescriptions?.[i] && q.optionDescriptions[i] !== option}
                    <span class="qf-option-desc">{@render linked(q.optionDescriptions[i])}</span>
                  {/if}
                </span>
                {#if recommended}
                  <span class="qf-rec-tag">{m.qform_recommended()}</span>
                {/if}
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
                <span class="qf-option-text">{m.qform_other()}</span>
              </label>
            </li>
            {#if otherOn(q)}
              <li class="qf-freeform">
                <input
                  type="text"
                  class="qf-freeform-input qf-freeform-live qf-other-input"
                  bind:value={otherText[q.id]}
                  onkeydown={onEnter}
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
            onkeydown={onEnter}
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
  .qf-link {
    color: var(--color-amber);
    text-decoration: underline;
    overflow-wrap: anywhere;
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
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .qf-option-label {
    font-weight: 500;
    color: var(--color-ink-bright);
  }
  .qf-option-desc {
    font-size: var(--fs-meta);
    line-height: 1.45;
    color: var(--color-muted);
  }
  .qf-options {
    margin: 8px 0 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* Each answer is its own full-width row: the whole row is the label, so a click anywhere on
     it picks the answer, not only the control at its start. */
  .qf-label {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    box-sizing: border-box;
    padding: 9px 12px;
    border: 1px solid var(--color-line);
    border-radius: 3px;
    background: var(--color-inset);
    font-size: var(--fs-base);
    color: var(--color-ink);
    opacity: 0.7;
    cursor: default;
    transition:
      border-color 0.12s,
      background-color 0.12s;
  }
  .qf-label input {
    flex: none;
    margin: 2px 0 0;
    accent-color: var(--color-amber);
  }
  .qf-rec {
    border-color: var(--wash-recommended-edge);
    background: var(--wash-recommended);
  }
  .qf-rec-tag {
    flex: none;
    align-self: center;
    font-size: var(--fs-meta);
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--wash-recommended-ink);
    border: 1px solid var(--wash-recommended-edge);
    border-radius: 2px;
    padding: 1px 6px;
  }
  /* Interactive: full opacity + pointer affordance. */
  .qf-label-live {
    opacity: 1;
    cursor: pointer;
  }
  .qf-label-live:hover {
    border-color: var(--color-line-bright);
    background: var(--color-hover);
  }
  .qf-label-live.qf-rec:hover {
    border-color: var(--color-blue);
    background: var(--wash-recommended);
  }
  /* The operator's pick wins over the recommendation tint; the tag still names it. */
  .qf-label:has(input:checked) {
    border-color: var(--color-amber);
    background: var(--color-sel);
  }
  .qf-label:has(input:focus-visible) {
    box-shadow: 0 0 0 1px var(--color-amber);
  }
  @media (pointer: coarse) {
    .qf-label {
      min-height: 44px;
    }
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
