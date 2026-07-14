<script lang="ts">
  // The clickable "ⓘ" that toggles a row's long-form explanation. Extracted from
  // AutomationSettings so the hide-info-tips guard lives here rather than adding a branch to
  // that already-dense template (it sits 1 under the Tier-1 <template> complexity bar).
  //
  // Pairs with AutomationDetail, which renders the block this button reveals. `open` is owned
  // by the parent so only one explanation is expanded at a time — the panel is a narrow
  // popover, and a single open detail keeps it readable.
  import { m } from "$lib/paraglide/messages";
  import { infoTips } from "$lib/info-tips.svelte";

  let {
    id,
    name,
    open,
    ontoggle,
  }: { id: string; name: string; open: boolean; ontoggle: () => void } = $props();
</script>

{#if !infoTips.hidden}
  <button
    class={["info", { open }]}
    type="button"
    aria-expanded={open}
    aria-controls="auto-detail-{id}"
    aria-label={m.automation_info_aria({ name })}
    onclick={ontoggle}
  >
    <span aria-hidden="true">i</span>
  </button>
{/if}

<style>
  /* clickable "ⓘ" — small circular affordance that toggles the long explanation */
  .info {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    padding: 0;
    border: 1px solid var(--color-line);
    border-radius: 50%;
    background: transparent;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    font-style: italic;
    line-height: 1;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  .info:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-faint);
  }
  .info.open {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
</style>
