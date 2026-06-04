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

  // Single source of truth for the grid width: drives both the arrow-key row
  // jump and the CSS column count (via the --ep-cols custom property below).
  const COLS = 7;

  let query = $state("");
  let custom = $state("");
  let active = $state(0);
  let searchInput = $state<HTMLInputElement | null>(null);
  let cells: HTMLButtonElement[] = [];

  const shown = $derived(searchEmoji(query));
  const customOk = $derived(isSingleEmoji(custom));

  $effect(() => {
    searchInput?.focus();
  });

  // Keep the keyboard cursor visible as it moves through the grid.
  $effect(() => {
    cells[active]?.scrollIntoView({ block: "nearest" });
  });

  function move(delta: number) {
    if (shown.length === 0) return;
    active = Math.min(Math.max(active + delta, 0), shown.length - 1);
  }

  function onSearchKey(e: KeyboardEvent) {
    const caret = searchInput?.selectionStart ?? 0;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(COLS);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-COLS);
        break;
      // ←/→ edit the text first; only steer the grid once the caret is at an edge.
      case "ArrowRight":
        if (caret >= query.length) {
          e.preventDefault();
          move(1);
        }
        break;
      case "ArrowLeft":
        if (caret <= 0) {
          e.preventDefault();
          move(-1);
        }
        break;
      case "Enter": {
        e.preventDefault();
        const pick = shown[active];
        if (pick) onpick(pick.char);
        break;
      }
    }
  }

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
    role="combobox"
    aria-expanded="true"
    aria-controls="ep-grid"
    aria-autocomplete="list"
    aria-activedescendant={shown.length ? `ep-cell-${active}` : undefined}
    autocomplete="off"
    spellcheck="false"
    oninput={() => (active = 0)}
    onkeydown={onSearchKey}
  />
  <div class="ep-grid" id="ep-grid" role="listbox" style="--ep-cols: {COLS}">
    {#each shown as e, i (e.char)}
      <button
        bind:this={cells[i]}
        id={`ep-cell-${i}`}
        type="button"
        class="ep-cell"
        class:on={e.char === value}
        class:active={i === active}
        role="option"
        aria-selected={i === active}
        tabindex={-1}
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
    font-size: var(--fs-base);
    padding: 6px 8px;
    border-radius: 2px;
  }
  .ep-search:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  .ep-grid {
    display: grid;
    /* Column count is set inline from the COLS constant (keeps JS row-jump in sync). */
    grid-template-columns: repeat(var(--ep-cols, 7), 1fr);
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
    font-size: var(--fs-lg);
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
  /* Keyboard cursor — defined after .on so it wins when a cell is both. */
  .ep-cell.active {
    background: var(--color-hover);
    outline: 1.5px solid var(--color-amber);
    outline-offset: -1.5px;
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
    font-size: var(--fs-lg); /* prevents iOS zoom-on-focus; also fits emoji */
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
    font-size: var(--fs-meta);
    padding: 0 8px;
    border-radius: 2px;
    cursor: pointer;
  }
  .ep-clear:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-amber);
  }
</style>
