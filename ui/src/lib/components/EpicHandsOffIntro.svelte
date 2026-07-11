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
      // Two independent writes: repo-wide defaults, then the per-epic mode switch. Fail each
      // separately so a mode-switch failure doesn't misreport the already-applied defaults as
      // un-applied. On any failure keep the panel open (not marked seen) so its live checklist
      // reflects reality and the operator can retry — both writes are idempotent.
      try {
        await repoConfig.applyHandsOffDefaults(repoPath);
      } catch {
        toasts.info(m.epic_handsoff_apply_failed(), {
          alert: true,
          key: "epic-handsoff-apply-fail",
        });
        return;
      }
      if (epic.run.mode !== "auto") {
        try {
          await updateEpic(repoPath, parent, { mode: "auto" });
        } catch {
          // Partial success: repo defaults landed, only the auto-mode switch failed.
          toasts.info(m.epic_handsoff_mode_failed(), {
            alert: true,
            key: "epic-handsoff-mode-fail",
          });
          return;
        }
      }
      featureDiscovery.markSeen(SEEN_ID);
      dismissed = true;
      toasts.info(m.epic_handsoff_applied(), { key: "epic-handsoff-applied" });
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

  /* Canonical .gbtn recipe from /design-system. Scoped-duplicated because Svelte
     scopes styles per-component and there is no global .gbtn in app.css — without
     it the Apply/Dismiss buttons render as bare unstyled text. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  @media (max-width: 768px) {
    .gbtn {
      min-height: 40px;
      padding: 2px 14px;
    }
  }
</style>
