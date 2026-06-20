<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { MergeSuggestion } from "$lib/types";
  import type { LearningsCtx } from "./ctx";

  let {
    suggestion,
    ctx,
  }: {
    suggestion: MergeSuggestion;
    ctx: LearningsCtx;
  } = $props();
</script>

<article class="ms-card">
  <ul class="ms-members">
    {#each suggestion.members ?? [] as mem (mem.id)}
      <li class="ms-member">{mem.rule}</li>
    {/each}
  </ul>
  <p class="ms-result">
    <span class="ms-result-label">{m.learnings_merge_result_label()}</span>
    {suggestion.mergedRule}
  </p>
  <div class="ms-foot">
    <button class="ms-dismiss" type="button" onclick={() => ctx.ondismissmerge(suggestion.id)}>
      {m.learnings_dismiss()}
    </button>
    <button class="ms-apply" type="button" onclick={() => ctx.onmerge(suggestion.id)}>
      {m.learnings_merge_apply()}
    </button>
  </div>
</article>

<style>
  .ms-card {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ms-members {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .ms-member {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
    padding-left: 12px;
    position: relative;
  }
  .ms-member::before {
    content: "•";
    position: absolute;
    left: 2px;
    color: var(--color-line-bright);
  }
  .ms-result {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    line-height: 1.5;
  }
  .ms-result-label {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .ms-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }
  /* Merge = actionable consolidation → green (matches .promote) */
  .ms-apply {
    font-size: var(--fs-base);
    padding: 4px 12px;
    cursor: pointer;
    border: 1px solid var(--color-green);
    background: none;
    color: var(--color-green);
  }
  .ms-dismiss {
    font-size: var(--fs-base);
    padding: 4px 10px;
    cursor: pointer;
    border: 1px solid var(--color-line-bright);
    background: none;
    color: var(--color-muted);
  }
  .ms-dismiss:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink-bright);
  }
</style>
