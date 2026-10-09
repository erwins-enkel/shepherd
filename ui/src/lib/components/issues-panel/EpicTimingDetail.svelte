<script lang="ts">
  import type { Epic } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import {
    epicGantt,
    epicTimeTiles,
    fasterSlotsHint,
    forecastBasisLines,
  } from "#lib/epic-timing-detail.js";
  import { automationFocus } from "#lib/automation-focus.js";
  import GlossaryText from "../GlossaryText.svelte";
  import EpicTimeline from "./EpicTimeline.svelte";

  // The epic detail's time (#2939): how long it has run and when it lands (ZEIT), the timeline,
  // what one more agent slot would buy, and how the forecast is made. Mirrors the EPIC badge's
  // hover (slice 3) for every phase; renders nothing for a server without the epic clock.
  let {
    epic,
    nowMs,
    slots = null,
    onopenautomation = undefined,
  }: {
    epic: Epic;
    /** The detail's tick — the clocks run on it. */
    nowMs: number;
    /** The repo's agent slots (its drain cap); null when unknown. */
    slots?: number | null;
    /** Show the repo's Automation tab; the hint's button opens it at the agent-slot cap. */
    onopenautomation?: () => void;
  } = $props();

  const tiles = $derived(epicTimeTiles(epic, nowMs));
  const gantt = $derived(epicGantt(epic, nowMs));
  const hint = $derived(fasterSlotsHint(epic, nowMs));
  const basis = $derived(gantt ? forecastBasisLines(epic, slots) : null);

  /** Opens the cap with focus, for the operator to raise — never changes it here. */
  function allowSlots() {
    automationFocus.request("max-auto");
    onopenautomation?.();
  }
</script>

{#if tiles}
  <div class="epic-timing">
    <section class="time" aria-label={m.epic_tip_section_time()}>
      <span class="caption">{m.epic_tip_section_time()}</span>
      {#if tiles.length === 0}
        <p class="unstarted">{m.epic_tip_summary_unstarted()}</p>
      {:else}
        <ul class="tiles">
          {#each tiles as tile, i (i)}
            <li class="tile" class:warn={tile.tone === "warn"}>
              <span class="tile-label"><GlossaryText text={tile.label} /></span>
              <span class="tile-value">{tile.value}</span>
              {#if tile.sub || tile.confidence}
                <span class="tile-sub">
                  {#if tile.sub}<span>{tile.sub}</span>{/if}
                  {#if tile.confidence}
                    <span class="meter" aria-hidden="true">
                      {#each [0, 1, 2] as k (k)}
                        <span class="cell" class:on={k < tile.confidence.rung}></span>
                      {/each}
                    </span>
                    <span>{tile.confidence.text}</span>
                  {/if}
                </span>
              {/if}
              {#if tile.note}<span class="tile-note">{tile.note}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if gantt}<EpicTimeline {gantt} />{/if}

    {#if hint}
      <div class="hint">
        <svg
          class="hint-icon"
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M4 6l7 6-7 6z"></path><path d="M13 6l7 6-7 6z"></path></svg
        >
        <p class="hint-text">
          <strong><GlossaryText text={hint.title} /></strong>
          <span>{hint.body}</span>
        </p>
        {#if onopenautomation}
          <button class="allow" type="button" onclick={allowSlots}>{hint.action}</button>
        {/if}
      </div>
    {/if}

    {#if basis}
      <details class="basis">
        <summary>{m.epicdetail_basis_title()}</summary>
        <ul>
          {#each basis as line, i (i)}
            <li><GlossaryText text={line} /></li>
          {/each}
        </ul>
      </details>
    {/if}
  </div>
{/if}

<style>
  .epic-timing {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }

  .time {
    /* The tiles answer to this box's width, not the window's: the detail pane can be narrow on
       a desktop too. */
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }

  .caption {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .unstarted {
    margin: 0;
    color: var(--color-muted);
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 10px 12px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }

  .tile-label {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  /* A marked term is a button, which drops the label's case and tracking. */
  .tile-label :global(.gloss-term) {
    letter-spacing: inherit;
    text-transform: inherit;
  }

  .tile-value {
    color: var(--color-ink-bright);
    font-size: var(--fs-xl);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .warn .tile-value,
  .tile-note {
    color: var(--status-warn);
  }

  .tile-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }

  /* The forecast's confidence, as on the hover's meter. */
  .meter {
    display: inline-flex;
    gap: 2px;
  }
  .cell {
    width: 10px;
    height: 4px;
    background: var(--color-line-bright);
  }
  .cell.on {
    background: var(--status-running);
  }

  @container (max-width: 560px) {
    .tiles {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .tile-value {
      font-size: var(--fs-lg);
    }
  }

  .hint {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 14px;
    padding: 10px 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
  }

  .hint-icon {
    flex: none;
    color: var(--color-blue);
  }

  .hint-text {
    display: flex;
    flex: 1 1 24ch;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    margin: 0;
    color: var(--color-muted);
  }
  .hint-text strong {
    color: var(--color-ink-bright);
    font-weight: 600;
  }

  .basis {
    color: var(--color-ink);
  }
  .basis summary {
    cursor: pointer;
    color: var(--color-ink-bright);
  }
  .basis ul {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0 0;
    padding: 0 0 0 18px;
  }

  /* The hint's one action, outlined in its blue: it opens a setting, it changes nothing. */
  .allow {
    flex: none;
    min-height: 32px;
    padding: 2px 12px;
    background: transparent;
    border: 1px solid var(--color-blue);
    border-radius: 2px;
    color: var(--color-blue);
    font: inherit;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .allow:hover {
    background: color-mix(in srgb, var(--color-blue) 12%, transparent);
  }
  .allow:focus-visible {
    outline: 1px solid var(--color-blue);
    outline-offset: 2px;
  }
  /* The tap-target floor on a phone (app.css's mobile branch). */
  @media (max-width: 768px), (max-height: 600px) {
    .allow {
      min-height: 44px;
    }
  }
</style>
