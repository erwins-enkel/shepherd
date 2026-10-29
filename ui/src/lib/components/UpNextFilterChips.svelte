<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";

  // Up Next's active default-filter rules (#3018), under the header: STANDARD, one chip per
  // rule, then how many issues they hide. The whole row opens the filter flyout.
  let {
    el = $bindable(),
    chips,
    hidden,
    onopen,
  }: {
    el?: HTMLButtonElement;
    chips: { key: string; text: string }[];
    hidden: number;
    onopen: () => void;
  } = $props();
</script>

<button
  bind:this={el}
  type="button"
  class="un-chips"
  aria-label={m.upnext_filter_chips_aria({
    rules: chips.map((c) => c.text).join(", "),
    count: hidden,
  })}
  onclick={onopen}
>
  <span class="un-chips-std" aria-hidden="true">{m.upnext_filter_standard()}</span>
  {#each chips as chip (chip.key)}
    <span class="un-chip" aria-hidden="true">{chip.text}</span>
  {/each}
  {#if hidden > 0}
    <span class="un-chips-hidden" aria-hidden="true"
      >{m.upnext_filter_hidden_count({ count: hidden })}</span
    >
  {/if}
</button>

<style>
  .un-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    width: 100%;
    padding: 6px 14px;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-micro);
    text-align: left;
    cursor: pointer;
  }
  .un-chips:hover {
    background: var(--color-hover);
  }
  .un-chips:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .un-chips-std {
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .un-chip {
    padding: 0 6px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
  }
  .un-chips-hidden {
    margin-left: auto;
    color: var(--color-amber);
  }
</style>
