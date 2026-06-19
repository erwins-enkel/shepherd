<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let { block }: { block: Extract<VisualBlock, { type: "question-form" }> } = $props();

  function kindLabel(kind: "single" | "multi" | "freeform"): string {
    if (kind === "single") return m.qform_kind_single();
    if (kind === "multi") return m.qform_kind_multi();
    return m.qform_kind_freeform();
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
              <label class="qf-label">
                <input type="radio" name={q.id} value={i} disabled />
                <span>{option}</span>
              </label>
            </li>
          {/each}
        </ul>
      {:else if q.kind === "multi" && q.options}
        <ul class="qf-options">
          {#each q.options as option, i (i)}
            <li class="qf-option">
              <label class="qf-label">
                <input type="checkbox" name={`${q.id}-${i}`} disabled />
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
            disabled
            placeholder={m.qform_freeform_placeholder()}
          />
        </div>
      {/if}
    </div>
  {/each}
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
</style>
