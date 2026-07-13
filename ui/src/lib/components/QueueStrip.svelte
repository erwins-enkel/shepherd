<script lang="ts">
  import type { AutoMergeStatus } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { basename } from "./learnings-drawer";
  import { activeMergeTrain, mergeTrainIsAttention, mergeTrainLabel } from "./queue-strip";

  let {
    autoMerge = {},
    onselect,
  }: {
    autoMerge?: Record<string, AutoMergeStatus>;
    onselect?: (id: string) => void;
  } = $props();
  const mergeRows = $derived(activeMergeTrain(autoMerge));
</script>

{#if mergeRows.length > 0}
  <div class="queue-strip" role="status" aria-label={m.automation_automerge_name()}>
    <span class="qs-label">↣ {m.automation_automerge_name()}</span>
    <ul class="qs-rows">
      {#each mergeRows as s (s.repoPath)}
        {@const label = mergeTrainLabel(s.state)}
        {@const attention = mergeTrainIsAttention(s.state!)}
        {@const sessionId = s.sessionId}
        <li>
          {#if sessionId}
            <button
              type="button"
              class="qs-row qs-link"
              class:paused={attention}
              onclick={() => onselect?.(sessionId)}
            >
              <span class="qs-repo">{basename(s.repoPath)}</span>
              <span class={["qs-mt-state", { "qs-pause": attention }]}
                >{s.detail ? `${label} (${s.detail})` : label}</span
              >
            </button>
          {:else}
            <span class="qs-row" class:paused={attention}>
              <span class="qs-repo">{basename(s.repoPath)}</span>
              <span class={["qs-mt-state", { "qs-pause": attention }]}
                >{s.detail ? `${label} (${s.detail})` : label}</span
              >
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .queue-strip {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
    padding: 5px 10px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-panel);
    font-family: var(--font-mono);
    /* override the parent .chrome column's default align-items:stretch so the
       band shrink-wraps its content instead of spanning the full viewport width */
    align-self: flex-start;
  }
  .qs-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
    flex-shrink: 0;
    /* top-aligned with the first stacked row */
    padding-top: 2px;
  }
  /* one repo per line — a clean vertical list instead of an inline wrap that
     breaks mid-row at narrow widths */
  .qs-rows {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
  }
  .qs-row {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
  }
  .qs-link {
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 2px;
    background: transparent;
    font-family: inherit;
    font-weight: inherit;
    line-height: inherit;
    cursor: pointer;
  }
  .qs-link:hover .qs-repo {
    color: var(--color-amber);
  }
  .qs-link:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .qs-repo {
    color: var(--color-ink-bright);
    font-weight: 500;
  }
  /* merge-train state: active tone (merging/rebasing) matches inflight color */
  .qs-mt-state {
    color: var(--color-ink);
  }

  /* merge-train attention state is the loud thing in the merge-train band: red, with its detail inline */
  .qs-pause {
    color: var(--color-red);
    background: color-mix(in oklab, var(--color-red) 12%, transparent);
    padding: 1px 6px;
    border-radius: 2px;
    text-transform: none;
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: min(320px, 50vw);
  }

  /* on phones the capped, ellipsis-clipped pause reason hides the actionable
     detail; let it wrap to full width instead of truncating */
  @media (max-width: 768px) {
    .qs-row.paused {
      /* top-align the repo label with the now-multi-line wrapped reason */
      align-items: flex-start;
    }
    .qs-pause {
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
      max-width: none;
    }
  }

  @media (pointer: coarse) {
    .qs-link {
      min-height: 44px;
    }
  }
</style>
