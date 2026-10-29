<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import "./automation-fields.css";

  // #3305: auto-merge holds this repo's PRs for lack of PR CI — flagged here, on the repo,
  // with both ways out: set up CI, or opt in to merging without it.
  let {
    repoPath,
    onsetupci,
  }: {
    repoPath: string;
    /** Seed a New Task that sets up PR CI for this repo; absent hides that action. */
    onsetupci?: () => void;
  } = $props();
</script>

{#if repoConfig.noPrCiHeld(repoPath)}
  <div class="auto-hold" role="status">
    <div class="auto-hold-head">
      <span class="auto-hold-glyph" aria-hidden="true">⚠</span>{m.automation_no_pr_ci_title()}
    </div>
    <p class="auto-hold-text">{m.automation_no_pr_ci_body()}</p>
    <div class="auto-hold-actions">
      {#if onsetupci}
        <button type="button" class="bs-btn primary" onclick={onsetupci}>
          {m.automation_no_pr_ci_setup()}
        </button>
      {/if}
      <button
        type="button"
        class="bs-btn"
        onclick={() => repoConfig.toggleMergeWithoutCi(repoPath)}
      >
        {m.automation_no_pr_ci_merge_without()}
      </button>
    </div>
  </div>
{/if}

<style>
  /* a status card above the automation rows, not a row of its own */
  .auto-hold {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 12px;
    padding: 10px 12px;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel-2);
  }
  .auto-hold-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .auto-hold-glyph {
    color: var(--status-warn);
  }
  .auto-hold-text {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .auto-hold-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  /* .bs-btn (./automation-fields.css) is the /design-system .gbtn recipe; .primary its accent */
  .primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
</style>
