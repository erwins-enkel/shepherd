<script lang="ts" module>
  export type FilesSource = "scratchpad" | "worktree" | "diff";
</script>

<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import InfoTip from "#lib/components/InfoTip.svelte";
  import type { TooltipExplanation } from "#lib/tooltips/content.js";

  // The Files tab's source switch: Scratchpad · Worktree · Diff, plus the ⓘ explaining each.
  let { source, onswitch }: { source: FilesSource; onswitch: (s: FilesSource) => void } = $props();

  const SOURCES: { id: FilesSource; label: () => string; tip: () => string }[] = [
    { id: "scratchpad", label: m.files_source_scratchpad, tip: m.files_source_tip_scratchpad },
    { id: "worktree", label: m.files_source_worktree, tip: m.files_source_tip_worktree },
    { id: "diff", label: m.files_source_diff, tip: m.files_source_tip_diff },
  ];

  // one labelled section per source
  const sourceTip: TooltipExplanation = {
    title: m.files_source_tip_title(),
    summary: m.files_source_tip_summary(),
    sections: SOURCES.map((s) => ({ label: s.label(), text: s.tip() })),
  };
</script>

<div class="seg-row">
  <div class="seg-tabs" role="group" aria-label={m.files_source_switch_aria()}>
    {#each SOURCES as s (s.id)}
      <button
        type="button"
        class="seg-btn"
        class:seg-active={source === s.id}
        aria-pressed={source === s.id}
        onclick={() => onswitch(s.id)}>{s.label()}</button
      >
    {/each}
  </div>
  <div class="seg-tip">
    <InfoTip
      text={sourceTip}
      label={m.newtask_info_aria({ topic: m.files_source_switch_aria() })}
      prominent={true}
    />
  </div>
</div>

<style>
  .seg-row {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .seg-tabs {
    display: flex;
    flex: 1;
    min-width: 0;
  }
  .seg-tip {
    flex: 0 0 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-left: 1px solid var(--color-line);
    background: var(--color-inset);
  }
  .seg-btn {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    border: 0;
    border-right: 1px solid var(--color-line);
    background: none;
    font-family: inherit;
    font-size: var(--fs-base);
    cursor: pointer;
    padding: 0 2px;
    color: var(--color-muted);
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .seg-btn:last-child {
    border-right: 0;
  }
  .seg-btn:hover {
    color: var(--color-ink);
  }
  .seg-btn.seg-active {
    color: var(--color-amber);
    background: var(--color-inset);
    box-shadow: inset 0 -2px 0 var(--color-amber);
  }
  .seg-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
