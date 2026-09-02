<script lang="ts">
  import QuestionFormBlock from "./blocks/QuestionFormBlock.svelte";
  import { m } from "$lib/paraglide/messages";
  import type { RawAnswer, ShapeRound } from "$lib/types";
  import type { ShapeFailure } from "./new-task/shape";

  // One component, three states, because they occupy the same slot in the New Task card and the
  // operator reads them as one thing: the round is running, it failed, or here it is.
  let {
    status,
    round,
    errorKey,
    onuse,
    ondismiss,
  }: {
    status: "running" | "ready" | "error";
    round?: ShapeRound;
    errorKey?: ShapeFailure;
    onuse: (answers: RawAnswer[]) => void;
    ondismiss: () => void;
  } = $props();

  const errorCopy = $derived.by(() => {
    if (errorKey === "spawn-failed") return m.shape_err_spawn_failed();
    if (errorKey === "unavailable") return m.shape_err_unavailable();
    if (errorKey === "empty-prompt") return m.shape_err_empty_prompt();
    if (errorKey === "compose") return m.shape_err_compose();
    return m.shape_err_timeout();
  });

  const bullets = (items: string[]) => items.filter((s) => s.trim() !== "");
</script>

<section class="shape" aria-label={m.shape_heading()}>
  <div class="shape-head">
    <span class="shape-title">{m.shape_heading()}</span>
    {#if status === "ready" && round}
      <span class="shape-meta">
        {m.shape_questions_count({ count: round.block.questions.length })}
      </span>
    {/if}
    <button type="button" class="shape-dismiss" onclick={ondismiss}>{m.shape_discard()}</button>
  </div>

  {#if status === "running"}
    <p class="shape-status" role="status">{m.shape_running()}</p>
  {:else if status === "error"}
    <p class="shape-status shape-status-error" role="alert">{errorCopy}</p>
  {:else if round}
    <dl class="shape-draft">
      {#each [[m.shape_s_problem(), round.draft.problem], [m.shape_s_outcome(), round.draft.outcome]] as [label, body] (label)}
        {#if body.trim()}
          <dt>{label}</dt>
          <dd>{body}</dd>
        {/if}
      {/each}
      {#each [[m.shape_s_constraints(), bullets(round.draft.constraints)], [m.shape_s_nongoals(), bullets(round.draft.nonGoals)]] as [label, items] (label)}
        {#if items.length}
          <dt>{label}</dt>
          <dd>
            <ul>
              {#each items as item (item)}<li>{item}</li>{/each}
            </ul>
          </dd>
        {/if}
      {/each}
    </dl>
    <!-- The plan gate's own question form, in callback mode: no session exists yet, so the answers
         come back here instead of being posted to one. -->
    <QuestionFormBlock block={round.block} onanswer={onuse} submitLabel={m.shape_use_brief()} />
  {/if}
</section>

<style>
  .shape {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
  }
  .shape-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .shape-title {
    font-size: var(--fs-base);
    color: var(--color-ink);
    font-weight: 500;
  }
  .shape-meta {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .shape-dismiss {
    margin-left: auto;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .shape-dismiss:hover {
    color: var(--color-ink);
    text-decoration: underline;
  }
  .shape-status {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .shape-status-error {
    color: var(--color-red);
  }
  .shape-draft {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .shape-draft dt {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .shape-draft dd {
    margin: 0 0 4px 0;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    line-height: 1.5;
  }
  .shape-draft ul {
    margin: 0;
    padding-left: 18px;
  }
</style>
