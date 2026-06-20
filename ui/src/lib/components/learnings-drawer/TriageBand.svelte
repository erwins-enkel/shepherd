<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { basename } from "../learnings-drawer";
  import type { reposNeedingAttention } from "../learnings-drawer";

  type AttentionItem = ReturnType<typeof reposNeedingAttention>[number];

  let {
    attention,
    onjump,
  }: {
    attention: AttentionItem[];
    onjump: (repoPath: string) => void;
  } = $props();
</script>

{#if attention.length > 0}
  <section class="triage" aria-label={m.learnings_triage_heading()}>
    <span class="triage-label">{m.learnings_triage_heading()}</span>
    <div class="triage-chips">
      {#each attention as a (a.repoPath)}
        <button
          class="triage-chip"
          type="button"
          aria-label={m.learnings_triage_jump_aria({ repo: basename(a.repoPath) })}
          onclick={() => onjump(a.repoPath)}
        >
          <span class="tc-repo">{basename(a.repoPath)}</span>
          {#if a.droppedCount > 0}<span class="tc-over"
              >{m.learnings_triage_over({ count: a.droppedCount })}</span
            >{/if}
          {#if a.flaggedCount > 0}<span class="tc-flagged"
              >{m.learnings_triage_flagged({ count: a.flaggedCount })}</span
            >{/if}
        </button>
      {/each}
    </div>
  </section>
{/if}

<style>
  /* Change 3: Triage summary band */
  .triage {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    background: var(--color-head);
  }
  .triage-label {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-muted);
  }
  .triage-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .triage-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: 1px solid var(--color-line-bright);
    padding: 3px 8px;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
  }
  .triage-chip:hover {
    border-color: var(--color-ink-bright);
  }
  .tc-repo {
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .tc-over,
  .tc-flagged {
    color: var(--color-amber);
    font-size: var(--fs-meta);
  }
</style>
