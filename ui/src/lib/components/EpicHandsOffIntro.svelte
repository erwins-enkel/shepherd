<script lang="ts">
  import type { Epic } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { repoConfig } from "$lib/reviews.svelte";
  import { featureDiscovery } from "$lib/featureDiscovery.svelte";
  import { updateEpic } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { DOCS_URL } from "$lib/build-info";
  import { handsOffDelta, type HandsOffItemKey } from "./epic-handsoff";
  import { onMount } from "svelte";

  let { repoPath, parent, epic }: { repoPath: string; parent: number; epic: Epic } = $props();

  const GUIDE_URL = `${DOCS_URL}hands-off-epics/`;
  const SEEN_ID = "epic-hands-off-intro";

  // Latch: snapshot the seen-state once on mount (localStorage is SSR-unsafe at module init),
  // then hide immediately on Apply/Dismiss without waiting for a store round-trip.
  let hydrated = $state(false);
  let dismissed = $state(false);
  onMount(() => {
    featureDiscovery.hydrate();
    if (featureDiscovery.isSeen(SEEN_ID)) dismissed = true;
    hydrated = true;
  });

  // Only surface while the epic is not already running (idle or paused) — the "setting up /
  // about to start" moment. A running epic has already committed; the automation-pane hint +
  // docs cover it.
  const show = $derived(hydrated && !dismissed && epic.run.status !== "running");

  const flags = $derived(repoConfig.flags(repoPath));
  const items = $derived(
    handsOffDelta({
      autopilot: flags.autopilot,
      autoMerge: flags.autoMerge,
      draftMode: flags.draftMode,
      critic: flags.critic,
      autoAddress: flags.autoAddress,
      planGate: flags.planGate,
      epicModeAuto: epic.run.mode === "auto",
    }),
  );

  function itemLabel(key: HandsOffItemKey): string {
    switch (key) {
      case "autopilot":
        return m.epic_handsoff_item_autopilot();
      case "automerge":
        return m.epic_handsoff_item_automerge();
      case "critic":
        return m.epic_handsoff_item_critic();
      case "autoaddress":
        return m.epic_handsoff_item_autoaddress();
      case "plangate":
        return m.epic_handsoff_item_plangate();
      case "epicmode":
        return m.epic_handsoff_item_epicmode();
    }
  }

  let applying = $state(false);
  async function apply() {
    if (applying) return;
    applying = true;
    try {
      await repoConfig.applyHandsOffDefaults(repoPath);
      if (epic.run.mode !== "auto") await updateEpic(repoPath, parent, { mode: "auto" });
      featureDiscovery.markSeen(SEEN_ID);
      dismissed = true;
      toasts.info(m.epic_handsoff_applied(), { key: "epic-handsoff-applied" });
    } catch {
      toasts.info(m.epic_handsoff_apply_failed(), {
        duration: null,
        alert: true,
        key: "epic-handsoff-apply-fail",
      });
    } finally {
      applying = false;
    }
  }

  function dismiss() {
    featureDiscovery.markSeen(SEEN_ID);
    dismissed = true;
  }
</script>

{#if show}
  <div class="handsoff panel" role="note" aria-label={m.epic_handsoff_title()}>
    <div class="ho-title">{m.epic_handsoff_title()}</div>
    <p class="ho-intro">{m.epic_handsoff_intro()}</p>

    <ul class="ho-checklist">
      {#each items as it (it.key)}
        <li class={["ho-item", { ok: it.ok }]}>
          <span class="ho-mark" aria-hidden="true">{it.ok ? "✓" : "•"}</span>
          <span class="ho-label">{itemLabel(it.key)}</span>
        </li>
      {/each}
    </ul>

    <p class="ho-note">{m.epic_handsoff_plangate_note()}</p>
    <p class="ho-note">{m.epic_handsoff_stops()}</p>
    <p class="ho-repowide">{m.epic_handsoff_repowide()}</p>

    <div class="ho-actions">
      <button class="gbtn primary" type="button" disabled={applying} onclick={apply}>
        {m.epic_handsoff_apply()}
      </button>
      <button class="gbtn" type="button" onclick={dismiss}>{m.epic_handsoff_dismiss()}</button>
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external docs URL -->
      <a class="ho-guide" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
        {m.epic_handsoff_guide()}
      </a>
    </div>
  </div>
{/if}

<style>
  .handsoff {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }

  .ho-title {
    color: var(--color-ink-bright);
    font-weight: 600;
  }

  .ho-intro {
    margin: 0;
    color: var(--color-ink);
  }

  .ho-checklist {
    margin: 2px 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .ho-item {
    display: flex;
    align-items: baseline;
    gap: 7px;
    color: var(--color-muted);
  }

  .ho-item.ok {
    color: var(--color-ink);
  }

  .ho-mark {
    flex-shrink: 0;
    width: 1ch;
    color: var(--color-amber);
  }

  .ho-item.ok .ho-mark {
    color: var(--color-green);
  }

  .ho-note {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  .ho-repowide {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }

  .ho-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding-top: 4px;
  }

  .ho-guide {
    color: var(--color-blue);
    font-size: var(--fs-micro);
    text-decoration: none;
  }

  .ho-guide:hover {
    text-decoration: underline;
  }
</style>
