<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { isMacPlatform } from "$lib/platform";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

  let { compact, oncommandbar }: { compact: boolean; oncommandbar: () => void } = $props();

  let isMac = $state(false);
  onMount(() => {
    isMac = isMacPlatform();
  });
</script>

<!-- a11y note: the label + kbd hint use the top bar's existing sub-16px control scale
     (--fs-base / --fs-micro), consistent with the clock, tallies, and update/whatsnew
     badge labels around them; the tap target is 44×44 on coarse pointers. -->
<button
  type="button"
  class="search"
  class:compact
  aria-label={m.topbar_search_aria()}
  onclick={oncommandbar}
  use:coachTarget={"topbar-search"}
>
  <svg
    class="search-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </svg>
  {#if !compact}
    <span class="search-label">{m.topbar_search()}</span>
    <kbd class="kbd" aria-hidden="true">{isMac ? "⌘K" : "Ctrl K"}</kbd>
  {/if}
</button>

<style>
  .search {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: var(--topbar-ctl-h);
    padding: 0 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-muted);
    border-radius: 2px;
    cursor: pointer;
    font: inherit;
    flex-shrink: 0;
    width: 180px;
    max-width: 180px;
  }
  .search:hover,
  .search:focus-visible {
    border-color: var(--color-line-bright);
    color: var(--color-ink);
  }
  .search-icon {
    width: var(--fs-lg);
    height: var(--fs-lg);
    display: block;
    flex-shrink: 0;
  }
  .search-label {
    font-size: var(--fs-base);
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kbd {
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    padding: 1px 5px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    font-family: inherit;
    line-height: 1.4;
    flex-shrink: 0;
  }
  .search.compact {
    width: auto;
    max-width: none;
    justify-content: center;
    min-width: 44px;
    padding: 0 10px;
  }

  @media (pointer: coarse) {
    .search {
      min-height: 44px;
      min-width: 44px;
    }
    .kbd {
      display: none;
    }
  }
</style>
