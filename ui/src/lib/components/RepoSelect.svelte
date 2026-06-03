<script lang="ts">
  import type { RepoEntry } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import EmojiPicker from "./EmojiPicker.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";

  let {
    repos,
    value,
    onchange,
    onclone,
  }: { repos: RepoEntry[]; value: string; onchange: (path: string) => void; onclone?: () => void } =
    $props();

  let open = $state(false);
  let filter = $state("");
  let root = $state<HTMLElement | null>(null);
  let filterInput = $state<HTMLInputElement | null>(null);

  // repo path whose emoji picker is currently open (null = none)
  let pickerFor = $state<string | null>(null);

  function setIcon(path: string, emoji: string | null) {
    projectIcons.set(path, emoji).catch(() => {});
    pickerFor = null;
  }

  const selected = $derived(repos.find((r) => r.path === value) ?? null);
  const shown = $derived(
    repos.filter((r) => (r.name + " " + r.display).toLowerCase().includes(filter.toLowerCase())),
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
    pickerFor = null;
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
        pickerFor = null;
        filter = "";
      }
    }
    function onClick(e: MouseEvent) {
      if (open && root && !root.contains(e.target as Node)) {
        open = false;
        pickerFor = null;
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
  <button
    type="button"
    class="rs-trigger"
    onclick={toggle}
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    {#if selected}
      <span class="rs-emoji" aria-hidden="true">{projectIcons.iconFor(selected.path) ?? "▣"}</span>
      <b>{selected.name}</b>
      <span class="dim">{selected.display}</span>
    {:else}
      <span class="placeholder">{m.reposelect_placeholder()}</span>
    {/if}
    <span class="chevron" class:open>{open ? "▲" : "▼"}</span>
  </button>

  {#if open}
    <div class="rs-panel" role="listbox">
      <input
        bind:this={filterInput}
        bind:value={filter}
        class="rs-filter"
        placeholder={m.reposelect_filter_placeholder()}
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
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") pick(r.path);
            }}
          >
            <button
              type="button"
              class="rs-emoji-btn"
              title={m.reposelect_set_icon()}
              aria-label={m.reposelect_set_icon()}
              onclick={(e) => {
                e.stopPropagation();
                pickerFor = pickerFor === r.path ? null : r.path;
              }}
            >
              {projectIcons.iconFor(r.path) ?? "▣"}
            </button>
            <b>{r.name}</b>
            <span class="dim">{r.display}</span>
          </li>
        {/each}
        {#if shown.length === 0}
          <li class="rs-empty">{m.reposelect_no_matches()}</li>
        {/if}
      </ul>
      {#if onclone}
        <button
          type="button"
          class="rs-clone-row"
          onclick={() => {
            open = false;
            filter = "";
            onclone?.();
          }}
        >
          {m.clonerepo_trigger()}
        </button>
      {/if}
      {#if pickerFor !== null}
        <div class="rs-picker">
          <EmojiPicker
            value={projectIcons.iconFor(pickerFor)}
            onpick={(emoji) => setIcon(pickerFor!, emoji)}
            onclose={() => (pickerFor = null)}
          />
        </div>
      {/if}
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
    overflow: hidden;
  }

  .rs-trigger:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  /* keyboard focus only — flat inset ring in the action color, no outer glow.
     :focus-visible keeps mouse clicks from showing the ring. */
  .rs-trigger:focus-visible {
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .rs-trigger b {
    font-weight: 600;
    flex-shrink: 0;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rs-trigger .dim {
    color: var(--color-muted);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
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
    border-color: var(--color-line-bright);
  }

  .rs-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 220px;
    overflow-y: auto;
    overflow-x: hidden;
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
    overflow: hidden;
  }

  .rs-row b {
    flex-shrink: 0;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rs-row:last-child {
    border-bottom: 0;
  }

  .rs-row:hover {
    background: var(--color-hover);
  }

  .rs-row.active {
    background: color-mix(in srgb, var(--color-amber) 8%, var(--color-panel));
  }

  .rs-row .dim {
    color: var(--color-muted);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .rs-empty {
    padding: 10px;
    color: var(--color-muted);
    font-size: 12px;
    font-style: italic;
    text-align: center;
  }

  .rs-clone-row {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 7px 10px;
    cursor: pointer;
    border: 0;
    border-top: 1px solid var(--color-line);
    background: transparent;
    font: inherit;
    font-size: 13px;
    color: var(--color-amber);
    text-align: left;
  }

  .rs-clone-row:hover {
    background: var(--color-hover);
  }

  .rs-emoji {
    flex-shrink: 0;
    font-size: 13px;
    line-height: 1;
  }
  .rs-emoji-btn {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    font-size: 14px;
    line-height: 1;
    padding: 1px 3px;
    cursor: pointer;
    color: var(--color-amber);
  }
  .rs-emoji-btn:hover {
    border-color: var(--color-amber);
    background: var(--color-hover);
  }
  .rs-picker {
    position: absolute;
    z-index: 60;
    left: 8px;
    margin-top: 4px;
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
