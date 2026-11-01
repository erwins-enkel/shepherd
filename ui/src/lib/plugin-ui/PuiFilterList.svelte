<script lang="ts">
  // Shared shell for the plugin-ui list nodes (`multi-select`, searchable `select`,
  // `action-list`): an inline ledger with a filter once the list is long enough to need one.
  // Inline rather than a popover so it can't clip inside the scrolling Settings panel. Row
  // labels and meta are verbatim plugin DATA; the host keeps the plugin's order until a query
  // ranks the matches.
  import { m } from "#lib/paraglide/messages.js";
  import { searchRepos } from "#lib/repo-search.js";
  import { noAutofill } from "./autofill";

  export interface FilterListRow {
    value: string;
    label: string;
    meta?: string;
  }

  /** A filter on a handful of rows is noise. */
  const FILTER_FROM_ROWS = 8;

  let {
    rows,
    label,
    mono = false,
    multiple = false,
    checks = false,
    status = "",
    isOn,
    busyValue = null,
    onactivate,
  }: {
    rows: FilterListRow[];
    /** Accessible name of the list and its filter. */
    label: string;
    /** Set row labels in the machine font (repo names and other identifiers). */
    mono?: boolean;
    multiple?: boolean;
    /** Draw a checkbox on each row. */
    checks?: boolean;
    /** Short live readout beside the filter, e.g. the picked count. */
    status?: string;
    isOn: (value: string) => boolean;
    busyValue?: string | null;
    onactivate: (value: string) => void;
  } = $props();

  const uid = $props.id();
  const guard = noAutofill();

  let filter = $state("");
  let activeIdx = $state(0);
  let listEl = $state<HTMLUListElement | null>(null);

  const filterable = $derived(rows.length >= FILTER_FROM_ROWS);
  const shown = $derived(
    searchRepos(filterable ? filter : "", rows, (r) => ({ name: r.label, aliases: [r.value] })),
  );
  const activeId = $derived(shown.length > 0 ? `${uid}-opt-${activeIdx}` : undefined);

  // A republish can shrink the list while the cursor sits past its new end.
  $effect(() => {
    if (activeIdx > shown.length - 1) activeIdx = Math.max(0, shown.length - 1);
  });

  function move(next: number) {
    activeIdx = Math.min(Math.max(next, 0), shown.length - 1);
    listEl?.querySelector(`[id="${uid}-opt-${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function activateCursor() {
    const row = shown[activeIdx];
    if (row) onactivate(row.value);
  }

  function onKey(e: KeyboardEvent) {
    // A focused row bubbles to the list, which handles the same keys.
    if (e.defaultPrevented) return;
    if (e.key === "ArrowDown") move(activeIdx + 1);
    else if (e.key === "ArrowUp") move(activeIdx - 1);
    else if (e.key === "Enter" || (e.key === " " && !filterable)) activateCursor();
    else return;
    e.preventDefault();
  }

  // Capture phase: a11yDialog listens natively on the Settings card, so a bubbling handler here
  // would run after the sheet had already closed. Same reason as SettingsShell's onSearchKey.
  function onFilterKeyCapture(e: KeyboardEvent) {
    if (e.key !== "Escape" || filter === "") return;
    e.preventDefault();
    filter = "";
    activeIdx = 0;
  }
</script>

<div class="pfl">
  {#if filterable || status}
    <div class="pfl-head">
      {#if filterable}
        <input
          {...guard}
          bind:value={filter}
          class="pfl-filter"
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck="false"
          placeholder={m.plugin_ui_list_filter()}
          aria-label={label}
          aria-expanded="true"
          aria-controls="{uid}-list"
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          oninput={() => (activeIdx = 0)}
          onkeydown={onKey}
          onkeydowncapture={onFilterKeyCapture}
        />
      {/if}
      <span class="pfl-status" class:push={!filterable} role="status">{status}</span>
    </div>
  {/if}
  <!-- Without a filter the list itself holds focus and drives the same virtual cursor. With
       one, the input keeps focus, so the list stays out of the tab order. -->
  <ul
    bind:this={listEl}
    id="{uid}-list"
    class="pfl-list"
    role="listbox"
    aria-label={label}
    aria-multiselectable={multiple}
    aria-activedescendant={filterable ? undefined : activeId}
    tabindex={filterable ? -1 : 0}
    onkeydown={filterable ? undefined : onKey}
  >
    {#each shown as row, i (row.value)}
      {@const on = isOn(row.value)}
      <!-- onpointerdown preventDefault keeps focus on the filter, so a tap doesn't retract the
           phone keyboard mid-gesture (as in RepoSelect). The list handles the keyboard. -->
      <li
        id="{uid}-opt-{i}"
        class="pfl-row"
        class:on
        class:cursor={i === activeIdx}
        role="option"
        aria-selected={on}
        aria-busy={row.value === busyValue}
        tabindex="-1"
        onpointerdown={(e) => e.preventDefault()}
        onclick={() => {
          activeIdx = i;
          onactivate(row.value);
        }}
        onkeydown={onKey}
      >
        {#if checks}
          <span class="pfl-box" class:on aria-hidden="true">
            {#if on}
              <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M1.5 5.2 4 7.7 8.5 2.5" />
              </svg>
            {/if}
          </span>
        {/if}
        <span class="pfl-label" class:pfl-mono={mono}>{row.label}</span>
        {#if row.meta}<span class="pfl-meta">{row.meta}</span>{/if}
      </li>
    {/each}
  </ul>
  <div class="pfl-empty" class:filled={shown.length === 0} role="status">
    {shown.length === 0 ? m.plugin_ui_list_no_matches() : ""}
  </div>
</div>

<style>
  .pfl {
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .pfl-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    border-bottom: 1px solid var(--color-line);
  }
  .pfl:focus-within .pfl-head {
    border-bottom-color: var(--color-line-bright);
  }
  /* width: 0 drops the input's intrinsic width, so the readout beside it isn't truncated
     while the filter sits on spare room. */
  .pfl-filter {
    flex: 1 1 8ch;
    width: 0;
    min-width: 8ch;
    background: transparent;
    border: 0;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
  }
  .pfl-filter::placeholder {
    color: var(--color-muted);
  }
  .pfl-filter:focus {
    outline: none;
  }
  .pfl-status {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    padding-right: 10px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pfl-status.push {
    margin-left: auto;
    padding-block: 6px;
  }
  .pfl-status:empty {
    display: none;
  }
  .pfl-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 240px;
    overflow-x: hidden;
    overflow-y: auto;
  }
  .pfl-list:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .pfl-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 6px 10px;
    border-top: 1px solid var(--color-line);
    color: var(--color-ink);
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .pfl-row:first-child {
    border-top: 0;
  }
  .pfl-row:hover {
    background: var(--color-hover);
  }
  /* The ledger's cursor line: a selection is not a status, so it never takes a status hue. */
  .pfl-row.on {
    background: var(--color-sel);
    border-top-color: var(--color-line-bright);
    color: var(--color-ink-bright);
  }
  .pfl-row[aria-busy="true"] {
    color: var(--color-muted);
    cursor: progress;
  }
  /* The keyboard cursor shows only while this list has focus: a resting amber ring on every
     panel would spend the action color on nothing. */
  .pfl:focus-within .pfl-row.cursor {
    outline: 1px solid var(--color-amber);
    outline-offset: -1px;
  }
  .pfl-box {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 14px;
    height: 14px;
    background: var(--color-panel-2);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-bg);
  }
  .pfl-box.on {
    background: var(--color-amber);
    border-color: var(--color-amber);
  }
  .pfl-box svg {
    width: 10px;
    height: 10px;
  }
  .pfl-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pfl-mono {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }
  .pfl-meta {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pfl-empty {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    text-align: center;
  }
  .pfl-empty.filled {
    padding: 10px;
  }
  @media (max-width: 768px), (max-height: 480px) and (pointer: coarse) {
    .pfl-row {
      min-height: 44px;
    }
    /* A long meta shouldn't squeeze a repo name to nothing at phone width. */
    .pfl-row:has(.pfl-meta) {
      flex-wrap: wrap;
      row-gap: 0;
    }
    .pfl-meta {
      flex-basis: 100%;
    }
    .pfl-row:has(.pfl-box) .pfl-meta {
      padding-left: 22px;
    }
  }
</style>
