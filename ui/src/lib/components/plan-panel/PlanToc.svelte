<script lang="ts" module>
  /** The approval figures under the contents; null while no review has produced a gate. */
  export interface PlanReleaseFigures {
    round: number;
    cap: number;
    approved: boolean;
    findings: number;
    notes: number;
  }
</script>

<script lang="ts">
  import type { PlanSection } from "#lib/plan-outline.js";
  import { m } from "#lib/paraglide/messages.js";
  import InfoTip from "#lib/components/InfoTip.svelte";
  import { planReleaseExplanation } from "#lib/tooltips/explanations.js";

  let {
    sections,
    verdictTone,
    hasBlocks,
    release,
    onjump,
  }: {
    sections: PlanSection[];
    /** Tone of the reviewer-verdict entry's status dot; null hides the entry (no verdict yet). */
    verdictTone: "ready" | "changes" | "error" | "muted" | null;
    hasBlocks: boolean;
    release: PlanReleaseFigures | null;
    /** Scroll the plan to the element with this `data-anchor`. */
    onjump: (anchor: string) => void;
  } = $props();

  // Narrow cards fold the contents above the document; a jump folds it again.
  let open = $state(false);
  function jump(anchor: string) {
    open = false;
    onjump(anchor);
  }
</script>

<nav class="toc" class:open aria-label={m.planpanel_toc_label()}>
  <button type="button" class="toc-toggle" aria-expanded={open} onclick={() => (open = !open)}>
    {m.planpanel_toc_label()}
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"
      ><path d="M3 4.5 6 7.5l3-3" /></svg
    >
  </button>
  <div class="toc-list">
    <span class="toc-label">{m.planpanel_toc_label()}</span>
    {#if verdictTone}
      <button type="button" class="toc-item" onclick={() => jump("verdict")}>
        <span class="dot {verdictTone}" aria-hidden="true"></span>{m.planpanel_verdict()}
      </button>
    {/if}
    {#if hasBlocks}
      <button type="button" class="toc-item" onclick={() => jump("blocks")}
        >{m.planpanel_toc_blocks()}</button
      >
    {/if}
    {#each sections as section, i (i)}
      <button type="button" class="toc-item" onclick={() => jump(`part-${i}`)}
        >{section.title ?? m.planpanel_toc_overview()}</button
      >
      {#if section.steps.length > 0}
        <ol class="toc-steps">
          {#each section.steps as step (step.index)}
            <li>
              <button
                type="button"
                class="toc-step"
                onclick={() => jump(`part-${i}-${step.index}`)}
              >
                {#if step.number !== null}
                  <span class="toc-num">{String(step.number).padStart(2, "0")}</span>
                {/if}
                <span class="toc-step-label">{step.label}</span>
              </button>
            </li>
          {/each}
        </ol>
      {/if}
    {/each}

    <dl class="release">
      <dt>
        {m.planpanel_release_label()}
        <InfoTip text={planReleaseExplanation()} label={m.planpanel_release_info()} />
      </dt>
      {#if release}
        {#if !release.approved}
          <dd>
            <span>{m.planpanel_release_round()}</span>
            <b>{m.planpanel_release_round_value({ round: release.round, cap: release.cap })}</b>
          </dd>
        {/if}
        <dd>
          <span>{m.planpanel_release_findings()}</span>
          <b class:warn={release.findings > 0}>{release.findings}</b>
        </dd>
        <dd><span>{m.planpanel_release_notes()}</span><b>{release.notes}</b></dd>
      {:else}
        <dd><span>{m.planpanel_release_unreviewed()}</span></dd>
      {/if}
    </dl>
  </div>
</nav>

<style>
  /* Narrow card: a folded block above the document. */
  .toc {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .toc-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 44px;
    padding: 0 12px;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .toc-toggle svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
  .open .toc-toggle svg {
    transform: rotate(180deg);
  }
  .toc-list {
    display: none;
    flex-direction: column;
    gap: 2px;
    padding: 0 4px 10px;
  }
  .open .toc-list {
    display: flex;
  }
  .toc-list > .toc-label {
    display: none;
  }

  /* Wide card: a sticky column beside the plan that scrolls itself when a long plan outgrows it. */
  @container (min-width: 880px) {
    .toc {
      position: sticky;
      top: 0;
      max-height: calc(90dvh - 220px);
      overflow-y: auto;
      border: 0;
      border-right: 1px solid var(--color-line);
      border-radius: 0;
      padding: 18px 12px 12px 0;
    }
    .toc-toggle {
      display: none;
    }
    .toc-list {
      display: flex;
      padding: 0;
    }
    .toc-list > .toc-label {
      display: block;
    }
  }

  .toc-label {
    padding: 0 8px 8px;
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .toc-item,
  .toc-step {
    width: 100%;
    background: none;
    border: 0;
    border-radius: 2px;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .toc-item {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 4px 8px;
    color: var(--color-ink);
    font-size: var(--fs-base);
  }
  .toc-item:hover,
  .toc-item:focus-visible,
  .toc-step:hover,
  .toc-step:focus-visible {
    background: var(--color-hover);
    color: var(--color-ink-bright);
  }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-muted);
  }
  .dot.ready {
    background: var(--color-green);
  }
  .dot.changes {
    background: var(--color-amber);
  }
  .dot.error {
    background: var(--color-red);
  }
  .toc-steps {
    margin: 0 0 4px;
    padding: 0;
    list-style: none;
  }
  .toc-step {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 2px 8px 2px 22px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .toc-num {
    flex: none;
    color: var(--color-amber);
  }
  .toc-step-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .release {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 14px 0 0;
    padding: 14px 8px 0;
    border-top: 1px solid var(--color-line);
    font-size: var(--fs-meta);
  }
  .release dt {
    display: flex;
    align-items: center;
    gap: 6px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .release dd {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin: 0;
    color: var(--color-muted);
  }
  .release b {
    font-weight: 500;
    color: var(--color-ink-bright);
  }
  .release b.warn {
    color: var(--color-amber);
  }
</style>
