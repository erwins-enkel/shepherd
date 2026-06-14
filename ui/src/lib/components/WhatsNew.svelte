<script lang="ts">
  import { fly } from "svelte/transition";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import { getLocale } from "$lib/i18n";
  import { releaseDates } from "$lib/build-info";
  import type { FeatureAnnouncement } from "$lib/feature-announcements";
  import GlossaryText from "$lib/components/GlossaryText.svelte";

  let {
    entries,
    ondismiss,
    onclose,
  }: {
    entries: FeatureAnnouncement[];
    ondismiss: () => void;
    onclose: () => void;
  } = $props();

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const slide = { x: 440, duration: reduceMotion ? 0 : 220, opacity: 1 };

  function dismiss() {
    ondismiss();
    onclose();
  }

  // Localized release date for an entry's `sinceVersion`, or "" if the version
  // isn't tagged yet (e.g. the in-development release) — then only the version
  // badge shows. Date is data formatted via Intl, so it needs no message key.
  function releaseDate(sinceVersion: string): string {
    const iso = releaseDates[sinceVersion];
    if (!iso) return "";
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat(getLocale() === "de" ? "de-DE" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(d);
  }

  // Entries arrive sorted newest release first (computeNewEntries); collapse
  // consecutive same-version entries into one release group so version + date
  // render once per release instead of repeating on every entry.
  type ReleaseGroup = { version: string; date: string; entries: FeatureAnnouncement[] };
  const groups = $derived.by(() => {
    const out: ReleaseGroup[] = [];
    for (const entry of entries) {
      const last = out[out.length - 1];
      if (last && last.version === entry.sinceVersion) {
        last.entries.push(entry);
      } else {
        out.push({
          version: entry.sinceVersion,
          date: releaseDate(entry.sinceVersion),
          entries: [entry],
        });
      }
    }
    return out;
  });
</script>

<div
  class="scrim"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="drawer"
    role="dialog"
    aria-modal="true"
    aria-label={m.whatsnew_title()}
    use:dialog={{ onclose }}
    transition:fly={slide}
  >
    <header class="bar">
      <span class="title">{m.whatsnew_title()}</span>
      <button class="close" onclick={() => onclose()} aria-label={m.common_close()}>✕</button>
    </header>

    {#if entries.length === 0}
      <p class="empty">{m.whatsnew_empty()}</p>
    {:else}
      <ul class="list">
        {#each groups as group (group.version)}
          <li class="group">
            <h3 class="ghead">
              <span class="gversion">v{group.version}</span>
              {#if group.date}
                <span class="gdate">{group.date}</span>
              {/if}
            </h3>
            <ul class="entries">
              {#each group.entries as entry (entry.id)}
                <li class="entry">
                  <h4 class="entry-title">
                    {(m as unknown as Record<string, () => string>)[entry.titleKey]()}
                  </h4>
                  <p class="entry-body">
                    <GlossaryText
                      text={(m as unknown as Record<string, () => string>)[entry.bodyKey]()}
                    />
                  </p>
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
    {/if}

    <footer class="foot">
      <button class="dismiss" onclick={dismiss}>{m.whatsnew_dismiss()}</button>
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    z-index: 50;
  }
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    width: min(440px, 100vw);
    height: 100dvh;
    background: var(--color-panel);
    border-left: 1px solid var(--color-line-bright);
    display: flex;
    flex-direction: column;
    gap: 10px;
    /* safe-area: keep header/footer clear of the Dynamic Island / home indicator */
    padding: calc(14px + env(safe-area-inset-top)) 14px calc(14px + env(safe-area-inset-bottom));
    /* the list is the single scroll container (header + footer stay pinned) */
    overflow: hidden;
    z-index: 51;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  .title {
    letter-spacing: 0.14em;
    font-size: var(--fs-base);
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .close {
    background: none;
    border: none;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-lg);
    /* ~44px touch target without shifting the visual layout */
    padding: 14px;
    margin: -14px;
  }
  .empty {
    color: var(--color-muted);
    font-size: var(--fs-base);
    line-height: 1.5;
    flex: 1;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 22px;
    flex: 1;
    overflow-y: auto;
  }
  .group {
    display: flex;
    flex-direction: column;
  }
  /* Release rail: version + date once per release, sticky while its entries
     scroll past so the operator always knows which release they're reading. */
  .ghead {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--color-panel);
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0;
    padding: 2px 0 6px;
    border-bottom: 1px solid var(--color-line-bright);
    font-size: var(--fs-meta);
    font-weight: 500;
    letter-spacing: 0.06em;
  }
  .gversion {
    color: var(--color-amber);
    font-variant-numeric: tabular-nums;
  }
  .gdate {
    color: var(--color-muted);
    font-weight: 400;
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .entry {
    padding: 12px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .entry + .entry {
    border-top: 1px solid var(--color-line);
  }
  .entry-title {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--color-ink-bright);
    letter-spacing: 0.02em;
    line-height: 1.3;
  }
  .entry-body {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    flex-shrink: 0;
    padding-top: 4px;
    border-top: 1px solid var(--color-line);
  }
  .dismiss {
    background: transparent;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    font-weight: 600;
    padding: 8px 16px;
    cursor: pointer;
    letter-spacing: 0.06em;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
    font-size: var(--fs-base);
  }
  .dismiss:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  /* phone steering is first-class: full-width, 44px primary action in thumb reach */
  @media (pointer: coarse) {
    .dismiss {
      width: 100%;
      min-height: 44px;
    }
  }
</style>
