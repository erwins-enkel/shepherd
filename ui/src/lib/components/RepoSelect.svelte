<script lang="ts">
  import type { RepoEntry } from "$lib/types";

  let {
    repos,
    value,
    onchange,
  }: { repos: RepoEntry[]; value: string; onchange: (path: string) => void } = $props();

  let open = $state(false);
  let filter = $state("");
  let root = $state<HTMLElement | null>(null);
  let filterInput = $state<HTMLInputElement | null>(null);

  const selected = $derived(repos.find((r) => r.path === value) ?? null);
  const shown = $derived(
    repos.filter((r) =>
      (r.name + " " + r.display).toLowerCase().includes(filter.toLowerCase()),
    ),
  );

  function toggle() {
    open = !open;
    if (open) {
      filter = "";
    }
  }

  function pick(path: string) {
    onchange(path);
    open = false;
    filter = "";
  }

  $effect(() => {
    if (open && filterInput) {
      filterInput.focus();
    }
  });

  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape" && open) {
        open = false;
        filter = "";
      }
    }
    function onClick(e: MouseEvent) {
      if (open && root && !root.contains(e.target as Node)) {
        open = false;
        filter = "";
      }
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("click", onClick, true);
    };
  });
</script>

<div class="rs-root" bind:this={root}>
  <button type="button" class="rs-trigger" onclick={toggle} aria-haspopup="listbox" aria-expanded={open}>
    {#if selected}
      <b>{selected.name}</b>
      <span class="dim">{selected.display}</span>
    {:else}
      <span class="placeholder">select a repo…</span>
    {/if}
    <span class="chevron" class:open>{open ? "▲" : "▼"}</span>
  </button>

  {#if open}
    <div class="rs-panel" role="listbox">
      <input
        bind:this={filterInput}
        bind:value={filter}
        class="rs-filter"
        placeholder="filter…"
        type="text"
        autocomplete="off"
        spellcheck="false"
      />
      <ul class="rs-list">
        {#each shown as r (r.path)}
          <li
            class="rs-row"
            class:active={r.path === value}
            role="option"
            aria-selected={r.path === value}
            tabindex="-1"
            onclick={() => pick(r.path)}
            onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") pick(r.path); }}
          >
            <b>{r.name}</b>
            <span class="dim">{r.display}</span>
          </li>
        {/each}
        {#if shown.length === 0}
          <li class="rs-empty">no matches</li>
        {/if}
      </ul>
    </div>
  {/if}
</div>

<style>
  .rs-root {
    position: relative;
    width: 100%;
  }

  .rs-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: 13px;
    padding: 8px 10px;
    border-radius: 2px;
    cursor: pointer;
    text-align: left;
  }

  .rs-trigger:focus {
    outline: none;
    border-color: var(--color-amber);
  }

  .rs-trigger b {
    font-weight: 600;
  }

  .rs-trigger .dim {
    color: var(--color-muted);
    font-size: 11.5px;
  }

  .rs-trigger .placeholder {
    color: var(--color-muted);
    font-style: italic;
  }

  .chevron {
    margin-left: auto;
    color: var(--color-muted);
    font-size: 10px;
  }

  .rs-panel {
    position: absolute;
    z-index: 50;
    top: calc(100% + 3px);
    left: 0;
    right: 0;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
  }

  .rs-filter {
    background: var(--color-inset);
    border: 0;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: 12px;
    padding: 7px 10px;
    border-radius: 0;
    flex-shrink: 0;
  }

  .rs-filter:focus {
    outline: none;
    border-color: var(--color-amber);
  }

  .rs-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 220px;
    overflow-y: auto;
  }

  .rs-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    cursor: pointer;
    border-bottom: 1px solid var(--color-line);
    font-size: 13px;
    color: var(--color-ink-bright);
  }

  .rs-row:last-child {
    border-bottom: 0;
  }

  .rs-row:hover {
    background: #0c1110;
  }

  .rs-row.active {
    background: color-mix(in srgb, var(--color-amber) 8%, var(--color-panel));
  }

  .rs-row .dim {
    color: var(--color-muted);
    font-size: 11.5px;
  }

  .rs-empty {
    padding: 10px;
    color: var(--color-muted);
    font-size: 12px;
    font-style: italic;
    text-align: center;
  }

  @media (max-width: 768px) {
    .rs-trigger {
      min-height: 44px;
    }
    .rs-filter {
      font-size: 16px; /* prevents iOS zoom-on-focus */
    }
    .rs-row {
      min-height: 44px;
    }
  }
</style>
