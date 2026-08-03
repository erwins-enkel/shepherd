<script lang="ts">
  // The full key card (`?`). Generated entirely from the registry — every row,
  // every group, in registry order. Nothing here is hand-maintained; adding a
  // shortcut to $lib/keymap/newTask.ts adds it to this card.
  //
  // It is a blocking surface (focus trap + aria-modal), so per .claude/rules/ui-design-system.md it
  // carries the canonical dim+blur backdrop rather than floating bare — the
  // static design reference shows it without one, but every other Shepherd
  // modal dims what it covers and this is no different.

  import { dialog } from "$lib/a11yDialog";
  import { chordLabel } from "$lib/keymap/chord";
  import { keymapByZone, zoneLabel } from "$lib/keymap/newTask";
  import type { NewTaskKeymapCtx } from "$lib/keymap/types";
  import { m } from "$lib/paraglide/messages";

  let { ctx, onclose }: { ctx: NewTaskKeymapCtx; onclose: () => void } = $props();

  const groups = $derived(keymapByZone());

  function keys(entry: (typeof groups)[number]["entries"][number]): string {
    return (
      entry.literal?.(ctx.isMac) ?? entry.chords.map((c) => chordLabel(c, ctx.isMac)).join(" ")
    );
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim ks-scrim" onclick={onclose}></div>
<div
  class="ks panel"
  role="dialog"
  aria-modal="true"
  aria-label={m.keymap_sheet_aria()}
  use:dialog={{ onclose }}
>
  <div class="ks-head">
    <span class="ks-title">{m.keymap_sheet_title()}</span>
    <span class="ks-ctx">{m.keymap_sheet_context()}</span>
    <span class="ks-esc">{m.keymap_sheet_dismiss()}</span>
  </div>
  <div class="ks-body">
    {#each groups as group (group.zone)}
      <div class="ks-group">
        <span class="ks-zone">{zoneLabel(group.zone)}</span>
        {#each group.entries as entry (entry.id)}
          <div class="ks-row" class:dim={!entry.enabled(ctx)}>
            <span class="ks-keys">{keys(entry)}</span>
            <span class="ks-desc">{entry.label()}</span>
          </div>
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .ks-scrim {
    /* Above New Task's own overlay (z-index 20). */
    z-index: 40;
  }
  .ks {
    position: fixed;
    z-index: 41;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, 92vw);
    max-height: 86vh;
    overflow-y: auto;
    box-sizing: border-box;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    box-shadow: 0 24px 60px -30px #000;
  }
  .ks-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-head);
  }
  .ks-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .ks-ctx,
  .ks-esc {
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
  .ks-esc {
    margin-left: auto;
  }
  .ks-body {
    padding: 14px 16px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px 24px;
  }
  .ks-group {
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-width: 0;
  }
  .ks-zone {
    font-size: calc(9px * var(--ui-scale));
    letter-spacing: 0.18em;
    color: var(--color-faint);
  }
  .ks-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  /* Same contract as a muted keycap: a shortcut that can't fire right now is
     dimmed, never dropped — the card is the canonical inventory. */
  .ks-row.dim {
    opacity: 0.5;
  }
  .ks-keys {
    flex-shrink: 0;
    min-width: 74px;
    text-align: right;
    font-size: var(--fs-micro);
    color: var(--color-amber);
    font-variant-numeric: tabular-nums;
  }
  .ks-desc {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    min-width: 0;
  }

  /* One column once two no longer fit — the card is content, not a fixed grid. */
  @media (max-width: 560px) {
    .ks-body {
      grid-template-columns: 1fr;
    }
  }
</style>
