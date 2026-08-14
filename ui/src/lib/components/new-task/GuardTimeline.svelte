<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import AutomationPanel from "$lib/components/AutomationPanel.svelte";
  import { buildGuardTimeline, type GuardRepoConfig, type GuardStep } from "$lib/guard-timeline";
  import type { AgentProvider } from "$lib/types";

  // "Where does this task wait for a human?" — rendered under the Guards toggles.
  //
  // The header line is always visible and names the current combination; the step list
  // starts collapsed and is NOT remembered across dialog openings (deliberate: the New
  // Task card is already dense, and the header carries the answer on its own).
  //
  // All of the semantics live in $lib/guard-timeline — this component only renders keys.
  let {
    planGate,
    autopilot,
    provider,
    baseBranch,
    repo,
    repoPath,
  }: {
    planGate: boolean;
    autopilot: boolean;
    provider: AgentProvider;
    baseBranch: string;
    /** null while the repo config is still loading → the post-PR steps are omitted. */
    repo: GuardRepoConfig | null;
    repoPath: string;
  } = $props();

  let expanded = $state(false);
  let panelOpen = $state(false);
  let wrapEl = $state<HTMLDivElement | null>(null);

  const timeline = $derived(
    buildGuardTimeline({ planGate, autopilot, provider, baseBranch, repo }),
  );
  // Split rather than interleaving a divider row into one <ol>: a non-step <li> would
  // consume an ordinal, so the repo steps would be misnumbered.
  const localSteps = $derived(timeline.steps.filter((s) => !s.repoScoped));
  const repoSteps = $derived(timeline.steps.filter((s) => s.repoScoped));

  const msg = (key: string) => (m as unknown as Record<string, () => string>)[key]!();

  function markerLabel(kind: GuardStep["kind"]): string {
    if (kind === "human") return m.guardtl_marker_you();
    if (kind === "auto") return m.guardtl_marker_auto();
    return m.guardtl_marker_conditional();
  }

  function markerGlyph(kind: GuardStep["kind"]): string {
    if (kind === "human") return "▲";
    if (kind === "auto") return "⚙";
    return "◈";
  }

  // The card's use:dialog Escape handler bails on defaultPrevented, so consuming the
  // event here closes the popover first and leaves the dialog open.
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && panelOpen) {
      e.preventDefault();
      panelOpen = false;
    }
  }

  // Click-outside dismiss, mirroring GitRail's automation popover. Window-scoped because
  // the popover has no backdrop of its own on desktop.
  function onWindowPointerdown(e: PointerEvent) {
    if (panelOpen && wrapEl && !wrapEl.contains(e.target as Node)) panelOpen = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<div class="gtl" bind:this={wrapEl} onkeydowncapture={onKeydown}>
  <button
    type="button"
    class="gtl-head"
    aria-expanded={expanded}
    aria-label={m.guardtl_toggle_aria()}
    onclick={() => (expanded = !expanded)}
  >
    <span class="gtl-head-text">{msg(timeline.headerKey)}</span>
    <span class="gtl-chev" class:open={expanded} aria-hidden="true">▾</span>
  </button>

  {#if expanded}
    <ol class="gtl-list">
      {#each localSteps as step (step.id)}
        <li class="gtl-step">
          <span class="gtl-marker {step.kind}">
            <span class="gtl-glyph" aria-hidden="true">{markerGlyph(step.kind)}</span>
            {markerLabel(step.kind)}
          </span>
          <span class="gtl-text">{msg(step.key)}</span>
        </li>
      {/each}
    </ol>

    {#if repoSteps.length > 0}
      <span class="gtl-divider">{m.guardtl_divider()}</span>
      <ol class="gtl-list" start={localSteps.length + 1}>
        {#each repoSteps as step (step.id)}
          <li class="gtl-step">
            <span class="gtl-marker {step.kind}">
              <span class="gtl-glyph" aria-hidden="true">{markerGlyph(step.kind)}</span>
              {markerLabel(step.kind)}
            </span>
            <span class="gtl-text">{msg(step.key)}</span>
            <button
              type="button"
              class="gtl-open"
              aria-label={m.guardtl_open_automation()}
              aria-expanded={panelOpen}
              onclick={() => (panelOpen = !panelOpen)}>↗</button
            >
          </li>
        {/each}
      </ol>
    {/if}
  {/if}

  {#if panelOpen}
    <!-- touch-only dim+blur behind the automation sheet: on coarse pointers
         AutomationPanel becomes a centered fixed sheet rather than the desktop's
         anchored, non-modal popover. Purely visual → aria-hidden. -->
    <div class="gtl-auto-scrim scrim" aria-hidden="true"></div>
    <div class="gtl-anchor">
      <AutomationPanel {repoPath} onClose={() => (panelOpen = false)} />
    </div>
  {/if}
</div>

<style>
  .gtl {
    position: relative;
    display: flex;
    flex-direction: column;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--color-line);
  }
  .gtl-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin: 0;
    padding: 0;
    background: transparent;
    border: 0;
    text-align: left;
    cursor: pointer;
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }
  .gtl-head:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gtl-head-text {
    min-width: 0;
  }
  .gtl-chev {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .gtl-chev.open {
    transform: rotate(180deg);
  }
  .gtl-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 6px 0 0;
    padding-left: 18px;
    font-size: var(--fs-micro);
    color: var(--color-ink);
  }
  .gtl-step {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .gtl-marker {
    flex-shrink: 0;
    display: inline-flex;
    align-items: baseline;
    gap: 3px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-slate);
  }
  /* Semantic, not decorative: amber is the "needs you" accent already carried by the
     guard toggles' ON readout; blue marks a condition without reading as a failure
     (red) or as actionable-complete (green, reserved). */
  .gtl-marker.human {
    color: var(--color-amber);
  }
  .gtl-marker.conditional {
    color: var(--color-blue);
  }
  .gtl-glyph {
    font-size: var(--fs-micro);
  }
  .gtl-text {
    min-width: 0;
  }
  .gtl-open {
    flex-shrink: 0;
    margin: 0;
    padding: 0 2px;
    background: transparent;
    border: 0;
    cursor: pointer;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .gtl-open:hover,
  .gtl-open:focus-visible {
    color: var(--color-ink-bright);
  }
  .gtl-open:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gtl-divider {
    margin-top: 8px;
    font-size: var(--fs-micro);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .gtl-auto-scrim {
    display: none;
    z-index: 50;
  }
  @media (pointer: coarse) {
    .gtl-auto-scrim {
      display: block;
    }
  }
</style>
