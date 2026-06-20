<script lang="ts">
  import type { HerdFilter } from "$lib/components/herd-partition";
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

  let {
    filter = $bindable<HerdFilter>(),
    statusFilter,
    statusLabel,
    collapsible,
    flow,
    onstatusfilter,
    oncollapse,
  }: {
    filter: HerdFilter;
    statusFilter: "running" | "idle" | "blocked" | null;
    statusLabel: string;
    collapsible: boolean;
    flow: boolean;
    onstatusfilter?: (status: "running" | "idle" | "blocked" | null) => void;
    oncollapse?: () => void;
  } = $props();
</script>

<div class="right filters" class:flow>
  <button
    type="button"
    class="micro fbtn"
    class:active={statusFilter == null && filter === "all"}
    title={m.herd_all_title()}
    aria-pressed={statusFilter == null && filter === "all"}
    onclick={() => {
      filter = "all";
      onstatusfilter?.(null);
    }}>{m.herd_all_hint()}</button
  >
  <button
    type="button"
    class="micro fbtn"
    class:active={statusFilter == null && filter === "ready"}
    title={m.herd_ready_title()}
    aria-pressed={statusFilter == null && filter === "ready"}
    onclick={() => {
      filter = "ready";
      onstatusfilter?.(null);
    }}>{m.herd_ready_filter()}</button
  >
  <button
    type="button"
    class="micro fbtn"
    class:active={statusFilter == null && filter === "research"}
    title={m.herd_research_title()}
    aria-pressed={statusFilter == null && filter === "research"}
    onclick={() => {
      filter = "research";
      onstatusfilter?.(null);
    }}>{m.herd_research_filter()}</button
  >
  <button
    type="button"
    class="micro fbtn"
    class:active={statusFilter == null && filter === "done"}
    title={m.herd_done_title()}
    aria-pressed={statusFilter == null && filter === "done"}
    use:coachTarget={"done-lens"}
    onclick={() => {
      filter = "done";
      onstatusfilter?.(null);
    }}>{m.herd_done_filter()}</button
  >
  <button
    type="button"
    class="micro fbtn"
    class:active={statusFilter == null && filter === "rundown"}
    title={m.herd_rundown_title()}
    aria-pressed={statusFilter == null && filter === "rundown"}
    use:coachTarget={"herd-rundown"}
    onclick={() => {
      filter = "rundown";
      onstatusfilter?.(null);
    }}>{m.herd_rundown_filter()}</button
  >
  {#if statusFilter != null}
    <!-- aria-label carries status + clear action; the visible "✕" glyph would
       otherwise be read aloud without conveying what the chip does -->
    <button
      type="button"
      class="micro fbtn active statchip"
      title={m.topbar_tally_clear_title()}
      aria-label={m.herd_status_chip_aria({ status: statusLabel })}
      aria-pressed="true"
      onclick={() => onstatusfilter?.(null)}>{statusLabel} ✕</button
    >
  {/if}
  {#if collapsible}
    <button
      id="herd-collapse-btn"
      type="button"
      class="fbtn collapse-inline"
      title={m.herd_collapse()}
      aria-label={m.herd_collapse()}
      onclick={() => oncollapse?.()}>‹</button
    >
  {/if}
</div>

<style>
  .filters {
    display: flex;
    gap: 4px;
    margin-left: auto;
  }
  /* In flow mode the desktop .fbtn row is replaced by the segmented control row
     below; hide the entire filters bar (and the statchip within it) on mobile.
     Desktop keeps .phead + .filters exactly as-is. */
  .filters.flow {
    display: none;
  }
  /* Compact (touch / unfolded-fold) layout pins the sidebar to ~288px. There the
     .phead wraps the whole .right.filters group onto its own line, where it sizes
     to its content width (~330px) and spills past the panel's right border (the
     trailing "Rundown" filter). Let the group wrap onto a second row only here;
     the non-touch desktop sidebar resolves to its 360px max where the row fits on
     one line, so it stays single-line and unchanged. The ancestor .grid.compact
     lives in +page.svelte (outside this component), hence the :global wrapper. */
  :global(.grid.compact) .filters {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .fbtn {
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    padding: 2px 5px;
    color: var(--color-faint);
    transition: color 0.12s ease;
  }
  .fbtn:hover {
    color: var(--color-ink);
  }
  .fbtn.active {
    color: var(--color-amber);
  }
  .fbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* inline collapse trigger living in the filters group (touch wide devices). */
  .collapse-inline {
    flex: none;
    margin-left: 4px;
    font-size: var(--fs-lg);
    line-height: 1;
  }

  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
