<script lang="ts">
  import type { RundownItem } from "$lib/types";
  import { herdDigest } from "$lib/herd-digest.svelte";
  import { regenerateHerdDigest } from "$lib/api";
  import { formatAgo } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";
  import GlossaryText from "./GlossaryText.svelte";

  // A rundown item with a sessionId deep-links to that session; the page swaps the
  // lens away from Rundown and selects it. PR-only items render as a static ref.
  // onepicland deep-links a landing-ready epic to the IntegratedEpicsBand's Land CTA (#1045).
  let {
    onitemselect,
    onepicland,
  }: {
    onitemselect?: (id: string) => void;
    onepicland?: (repo: string, parent: number) => void;
  } = $props();

  const digest = $derived(herdDigest.digest);
  const digestState = $derived(digest?.state ?? null);
  const generating = $derived(digestState === "generating");

  // Epics-to-land (#1045): server ground truth on the digest row, NOT from the LLM verdict — so it
  // renders in generating/ready/failed alike (it must not vanish mid-regenerate or on LLM failure).
  const epicsToLand = $derived(digest?.epicsToLand ?? []);
  // repo basename for a compact deep-link label (mirrors IntegratedEpicRow).
  const repoBase = (p: string) => p.split("/").filter(Boolean).at(-1) ?? p;

  // "generated X ago" off the digest's generatedAt; ticks with the shared 30s clock
  // (same helper DoneRecapPanel uses for "finished X ago"). Null until a first digest.
  const generatedAgo = $derived(
    digest?.generatedAt != null ? formatAgo(clock.current - digest.generatedAt) : null,
  );

  // Staleness: server-computed count of herd changes since the digest was generated.
  // Derived from the payload — never hardcoded; absent/0 → no hint.
  const staleCount = $derived(digest?.staleCount ?? 0);

  // Ready, yet every section empty: a legitimate all-clear, not a failure. Without an
  // explicit affordance the body renders blank and reads as broken.
  // epicsToLand must gate all-quiet too (#1045): a landing-ready epic is a Tier-1 attention item,
  // so the "all quiet" copy must never render above a populated epics section.
  const allQuiet = $derived(
    digestState === "ready" &&
      !digest?.overnight &&
      !digest?.train &&
      (digest?.decisions.length ?? 0) === 0 &&
      (digest?.ciRework.length ?? 0) === 0 &&
      (digest?.focusNext.length ?? 0) === 0 &&
      epicsToLand.length === 0,
  );

  // Fail-closed refresh: a rejected regenerate sets an error flag so it never reads
  // as success. The server's herd:digest WS push self-updates the panel.
  let refreshing = $state(false);
  let refreshError = $state(false);
  async function refresh() {
    if (refreshing || generating) return;
    refreshing = true;
    refreshError = false;
    try {
      await regenerateHerdDigest();
    } catch {
      refreshError = true;
    } finally {
      refreshing = false;
    }
  }

  function clickItem(it: RundownItem) {
    if (it.sessionId) onitemselect?.(it.sessionId);
  }
</script>

<!-- Shared item renderers — extracted as snippets so the three near-identical section blocks
     (focusNext/decisions/ciRework) don't repeat the sessionId/pr/static three-way (keeps the
     template's complexity + duplication down). -->
{#snippet linkItem(it: RundownItem, btnClass: string)}
  {#if it.sessionId}
    <button type="button" class={btnClass} onclick={() => clickItem(it)}>{it.label}</button>
  {:else if it.pr != null}
    <span class="rd-item-pr">{it.label} · {m.prbadge_open({ number: it.pr })}</span>
  {:else}
    <span class="rd-item-static">{it.label}</span>
  {/if}
{/snippet}

{#snippet reworkItem(it: RundownItem)}
  {#if it.sessionId}
    <button type="button" class="rd-item rd-item-red" onclick={() => clickItem(it)}
      >{it.label}{#if it.pr != null}&nbsp;· {m.prbadge_open({ number: it.pr })}{/if}</button
    >
  {:else if it.pr != null}
    <span class="rd-item-pr">{it.label} · {m.prbadge_open({ number: it.pr })}</span>
  {:else}
    <span class="rd-item-static">{it.label}</span>
  {/if}
{/snippet}

<section class="rundown" aria-label={m.rundown_title()}>
  <header class="rd-head">
    <span class="rd-title">{m.rundown_title()}</span>
    {#if generatedAgo}
      <span class="rd-generated">{m.rundown_generated_ago({ ago: generatedAgo })}</span>
    {/if}
    <div class="rd-actions">
      {#if staleCount > 0}
        <span class="rd-stale">{m.rundown_changes_since({ count: staleCount })}</span>
      {/if}
      <button
        type="button"
        class="rd-refresh"
        disabled={refreshing || generating}
        aria-busy={refreshing}
        title={m.rundown_refresh()}
        aria-label={m.rundown_refresh()}
        onclick={refresh}>⟳</button
      >
    </div>
  </header>

  <div class="rd-body">
    {#if epicsToLand.length > 0}
      <!-- Tier-1 epics-to-land (#1045): rendered regardless of digest state (generating/ready/failed)
           because it is server ground truth, not LLM output, and must stay visible mid-regenerate. -->
      <div class="rd-section rd-epics">
        <p class="rd-section-head rd-section-head-epics">
          <GlossaryText text={m.rundown_epics_to_land()} />
        </p>
        <ul class="rd-list">
          {#each epicsToLand as e (`${e.repo}#${e.parent}`)}
            <li>
              <button
                type="button"
                class="rd-item rd-item-epic"
                aria-label={m.rundown_epic_open_aria({ number: e.parent })}
                onclick={() => onepicland?.(e.repo, e.parent)}
              >
                {m.rundown_epic_label({ repo: repoBase(e.repo), title: e.title, number: e.parent })}
                {#if e.landingPr != null}&nbsp;· {m.prbadge_open({ number: e.landingPr })}{/if}
                {#if e.stranded}<span class="rd-epic-stranded">{m.rundown_epic_stranded()}</span
                  >{/if}
                {#if e.repairing}<span class="rd-epic-repairing">{m.rundown_epic_repairing()}</span
                  >{/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if generating}
      <p class="rd-muted">{m.rundown_generating()}</p>
    {:else if digestState === "failed"}
      <!-- generation ran but couldn't produce a digest — say so, never an empty all-clear. -->
      <p class="rd-muted rd-failed">{m.rundown_failed()}</p>
    {:else if digest == null}
      <div class="rd-empty">
        {#if refreshError}
          <p class="rd-error" role="alert">{m.common_retry()}</p>
        {/if}
        <p class="rd-muted">{m.rundown_empty()}</p>
        <button
          type="button"
          class="rd-generate"
          disabled={refreshing || generating}
          onclick={refresh}>{m.rundown_generate()}</button
        >
      </div>
    {:else}
      {#if refreshError}
        <p class="rd-error" role="alert">{m.common_retry()}</p>
      {/if}
      {#if allQuiet}
        <p class="rd-muted">{m.rundown_all_quiet()}</p>
      {/if}
      {#if digest.focusNext.length > 0}
        <div class="rd-section rd-focus">
          <p class="rd-section-head">{m.rundown_focus_next()}</p>
          <ul class="rd-list">
            {#each digest.focusNext as it, i (i)}
              <li>{@render linkItem(it, "rd-item rd-item-focus")}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if digest.decisions.length > 0}
        <div class="rd-section">
          <p class="rd-section-head">{m.rundown_decisions()}</p>
          <ul class="rd-list">
            {#each digest.decisions as it, i (i)}
              <li>{@render linkItem(it, "rd-item")}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if digest.ciRework.length > 0}
        <div class="rd-section rd-rework">
          <p class="rd-section-head rd-section-head-red">
            <GlossaryText text={m.rundown_ci_rework()} />
          </p>
          <ul class="rd-list">
            {#each digest.ciRework as it, i (i)}
              <li>{@render reworkItem(it)}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if digest.train}
        <div class="rd-section">
          <p class="rd-section-head"><GlossaryText text={m.rundown_merge_train()} /></p>
          <p class="rd-line">{digest.train}</p>
        </div>
      {/if}

      {#if digest.overnight}
        <div class="rd-section">
          <p class="rd-section-head">{m.rundown_overnight()}</p>
          <p class="rd-line">{digest.overnight}</p>
        </div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .rundown {
    position: relative;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    overflow: auto;
    min-height: 0;
    flex: 1;
  }

  .rd-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-line);
  }

  .rd-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
    font-weight: 600;
  }

  .rd-generated {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }

  .rd-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .rd-stale {
    font-size: var(--fs-micro);
    color: var(--color-amber);
  }

  .rd-refresh {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 2px 7px;
    cursor: pointer;
    transition: color 0.12s ease;
  }
  .rd-refresh:hover:not(:disabled) {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .rd-refresh:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .rd-refresh:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .rd-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 16px;
  }

  .rd-section {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .rd-section-head {
    margin: 0;
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
  }
  .rd-section-head-red {
    color: var(--color-red);
  }
  /* Epics-to-land is a Tier-1 actionable escalation (a ready landing awaiting a human), so its
     heading carries the amber attention hue — the same "needs you, action available" signal. */
  .rd-section-head-epics {
    color: var(--color-amber);
  }

  /* Deep-link to the band's Land CTA; reads as actionable amber like the heading. */
  .rd-item-epic {
    color: var(--color-amber);
  }
  .rd-item-epic:hover {
    color: var(--color-amber);
    text-decoration: underline;
  }
  /* Stranded (overdue) landing — escalate to red. */
  .rd-epic-stranded {
    margin-left: 6px;
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-red);
  }
  /* Non-actionable: an auto-repair session is live driving CI back to green. Slate, same tone
     as the IntegratedEpicLanding .chip-repairing recipe — never red/warn (no action needed). */
  .rd-epic-repairing {
    margin-left: 6px;
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--status-done);
  }

  /* Focus-next is the headline shortlist — give its heading a touch more presence. */
  .rd-focus .rd-section-head {
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
  }

  .rd-list {
    margin: 0;
    padding-left: 16px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  /* deep-link item: a quiet inline button that reads as text but is clearly actionable */
  .rd-item {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: var(--fs-meta);
    text-align: left;
    color: var(--color-ink);
    cursor: pointer;
    transition: color 0.12s ease;
  }
  .rd-item:hover {
    color: var(--color-amber);
  }
  .rd-item:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .rd-item-focus {
    color: var(--color-ink-bright);
    font-weight: 500;
  }
  .rd-item-red {
    color: var(--color-red);
  }
  .rd-item-red:hover {
    color: var(--color-red);
    text-decoration: underline;
  }

  .rd-item-pr,
  .rd-item-static {
    color: var(--color-ink);
  }

  .rd-line {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    line-height: 1.5;
  }

  .rd-muted {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .rd-failed {
    color: var(--color-red);
  }
  .rd-error {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-red);
  }

  .rd-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  .rd-generate {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    padding: 5px 11px;
    cursor: pointer;
    transition:
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .rd-generate:hover:not(:disabled) {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .rd-generate:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .rd-generate:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
