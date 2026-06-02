<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { dialog } from "$lib/a11yDialog";
  import { searchEmoji, isSingleEmoji } from "$lib/emoji";

  let {
    value,
    onpick,
    onclose,
  }: {
    value: string | null;
    onpick: (emoji: string | null) => void;
    onclose: () => void;
  } = $props();

  let query = $state("");
  let custom = $state("");
  let searchInput = $state<HTMLInputElement | null>(null);

  const shown = $derived(searchEmoji(query));
  const customOk = $derived(isSingleEmoji(custom));

  $effect(() => {
    searchInput?.focus();
  });

  function commitCustom() {
    if (customOk) {
      onpick(custom.trim());
      custom = "";
    }
  }
</script>

<div class="ep" role="dialog" aria-label={m.reposelect_set_icon()} use:dialog={{ onclose }}>
  <input
    bind:this={searchInput}
    bind:value={query}
    class="ep-search"
    placeholder={m.emojipicker_search()}
    type="text"
    autocomplete="off"
    spellcheck="false"
  />
  <div class="ep-grid">
    {#each shown as e (e.char)}
      <button
        type="button"
        class="ep-cell"
        class:on={e.char === value}
        title={e.keywords}
        onclick={() => onpick(e.char)}
      >
        {e.char}
      </button>
    {/each}
  </div>
  <div class="ep-foot">
    <input
      bind:value={custom}
      class="ep-custom"
      class:bad={custom.length > 0 && !customOk}
      placeholder={m.emojipicker_custom()}
      type="text"
      autocomplete="off"
      onkeydown={(e) => {
        if (e.key === "Enter") commitCustom();
      }}
    />
    <button type="button" class="ep-clear" onclick={() => onpick(null)}>
      {m.emojipicker_clear()}
    </button>
  </div>
</div>

<style>
  .ep {
    background: var(--color-panel-2);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
    padding: 8px;
    width: 240px;
  }
  .ep-search {
    width: 100%;
    box-sizing: border-box;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 2px;
  }
  .ep-search:focus {
    outline: none;
    border-color: var(--color-amber);
  }
  .ep-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
    margin-top: 7px;
    max-height: 180px;
    overflow-y: auto;
  }
  .ep-cell {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    background: transparent;
    border: 0;
    border-radius: 2px;
    cursor: pointer;
    padding: 0;
  }
  .ep-cell:hover {
    background: var(--color-hover);
  }
  .ep-cell.on {
    outline: 1.5px solid var(--color-line-bright);
    background: var(--color-sel);
  }
  .ep-foot {
    display: flex;
    gap: 6px;
    margin-top: 7px;
  }
  .ep-custom {
    flex: 1;
    min-width: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: 16px; /* prevents iOS zoom-on-focus; also fits emoji */
    padding: 4px 7px;
    border-radius: 2px;
  }
  .ep-custom.bad {
    border-color: var(--color-line-bright);
  }
  .ep-clear {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font: inherit;
    font-size: 11px;
    padding: 0 8px;
    border-radius: 2px;
    cursor: pointer;
  }
  .ep-clear:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-amber);
  }
</style>
