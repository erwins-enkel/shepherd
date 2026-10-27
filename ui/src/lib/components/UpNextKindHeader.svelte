<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";

  // The super-header over one kind of Up Next work: "Pull requests · waiting on you · N". With
  // onfold it is the whole block's fold toggle, naming ticked rows the fold hides like a band does.
  let {
    title,
    sub,
    count,
    open = true,
    hidden = 0,
    onfold,
  }: {
    title: string;
    sub: string;
    count: number;
    open?: boolean;
    /** Ticked rows the folded block hides. */
    hidden?: number;
    onfold?: () => void;
  } = $props();
</script>

{#snippet body()}
  <b>{title}</b><span>{sub}</span>
  {#if hidden > 0}
    <span class="un-section-hidden">{m.upnext_selected_count({ count: hidden })}</span>
  {/if}
  <span class="un-kind-count">{count}</span>
{/snippet}

{#if onfold}
  <button type="button" class="un-kind un-kind-fold" aria-expanded={open} onclick={onfold}>
    <span class="un-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
    {@render body()}
  </button>
{:else}
  <div class="un-kind">{@render body()}</div>
{/if}

<style>
  .un-kind {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 14px 14px 7px;
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .un-kind b {
    color: var(--color-ink-bright);
  }
  .un-kind-fold {
    margin: 0;
    width: 100%;
    border: 0;
    background: none;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
  }
  .un-kind-fold:hover b {
    color: var(--color-ink);
  }
  .un-kind-fold:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }
  .un-chevron {
    flex: none;
    width: 1ch;
    letter-spacing: 0;
  }
  .un-section-hidden {
    letter-spacing: 0.04em;
    text-transform: none;
    color: var(--color-amber);
  }
  .un-kind-count {
    margin-left: auto;
    letter-spacing: 0;
  }
</style>
