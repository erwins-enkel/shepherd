<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import type { Snippet } from "svelte";
  import type { SettingsSectionId, SettingsSectionNav } from "$lib/settings-search";
  import { m } from "$lib/paraglide/messages";

  // Layout + navigation chrome for the redesigned Settings dialog (handoff
  // 5a/5b): header, the 176px nav rail with search and live footer, and the
  // content pane on desktop; the full-screen section list with drill-in detail
  // on mobile. Owns NO settings state — the parent supplies section metadata
  // and renders the actual panels through `children`, which stays mounted
  // across desktop/mobile and list/detail switches (drafts survive).
  let {
    sections,
    active = $bindable(),
    query = $bindable(),
    mobileList = $bindable(true),
    version,
    live = false,
    onclose,
    banner,
    children,
  }: {
    sections: SettingsSectionNav[];
    active: SettingsSectionId;
    query: string;
    /** Mobile route: true = section list, false = drill-in detail. */
    mobileList?: boolean;
    version: string;
    live?: boolean;
    onclose?: () => void;
    /** Optional update-CTA banners pinned between header and body. */
    banner?: Snippet;
    children: Snippet;
  } = $props();

  const mobile = new MediaQuery("(max-width: 768px)");

  let searchEl = $state<HTMLInputElement | null>(null);
  let paneEl = $state<HTMLDivElement | null>(null);
  let navEls = $state<HTMLButtonElement[]>([]);
  // Per-section scroll positions — switching back to a section restores where
  // the user left it (handoff: "state … per-section").
  const scrollPos: Partial<Record<SettingsSectionId, number>> = {};

  const q = $derived(query.trim());
  const activeMeta = $derived(sections.find((s) => s.id === active) ?? sections[0]);
  // While searching on mobile, the list filters down to sections with matches;
  // the desktop rail always shows every section (badges mark the matches).
  const listed = $derived(
    mobile.current && q ? sections.filter((s) => s.matchCount > 0) : sections,
  );
  const showList = $derived(mobile.current && mobileList);

  function pick(id: SettingsSectionId) {
    if (id !== active) {
      active = id;
      requestAnimationFrame(() => {
        if (paneEl) paneEl.scrollTop = scrollPos[id] ?? 0;
      });
    }
    mobileList = false;
  }

  function onNavKey(e: KeyboardEvent, i: number) {
    if (mobile.current) return;
    let next: number;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % listed.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft")
      next = (i - 1 + listed.length) % listed.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = listed.length - 1;
    else return;
    e.preventDefault();
    pick(listed[next].id);
    navEls[next]?.focus();
  }

  // `/` focuses search from anywhere in the dialog (unless already typing).
  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== "/" || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();
    searchEl?.focus();
  }

  // Esc with a query clears it (preventDefault stops a11yDialog's close);
  // Esc on an empty field falls through and closes the dialog as usual.
  // Attached in the CAPTURE phase: Svelte delegates plain onkeydown to the
  // root, which would run AFTER a11yDialog's native node listener — the
  // dialog would close before this handler ever saw the event.
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Escape" && query !== "") {
      e.preventDefault();
      query = "";
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<header class="shead">
  {#if mobile.current && !mobileList}
    <button
      type="button"
      class="back"
      onclick={() => (mobileList = true)}
      aria-label={m.settings_back_aria()}>‹</button
    >
    <span class="htitle">{activeMeta.label}</span>
  {:else}
    <span class="htitle">{m.settings_title()}</span>
  {/if}
  <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
    >✕</button
  >
</header>

{#if banner}{@render banner()}{/if}

<div class="body">
  <nav class="rail" class:as-list={showList} hidden={mobile.current && !mobileList}>
    <div class="search">
      <span class="sglyph" aria-hidden="true">⌕</span>
      <input
        bind:this={searchEl}
        bind:value={query}
        type="text"
        placeholder={mobile.current
          ? m.settings_search_placeholder_mobile()
          : m.settings_search_placeholder()}
        aria-label={m.settings_search_aria()}
        onkeydowncapture={onSearchKey}
      />
      {#if !q}<kbd class="skbd" aria-hidden="true">/</kbd>{/if}
    </div>
    <div
      class="items"
      role={mobile.current ? undefined : "tablist"}
      aria-orientation={mobile.current ? undefined : "vertical"}
      aria-label={mobile.current ? undefined : m.settings_tabs_aria()}
    >
      {#each listed as s, i (s.id)}
        <button
          type="button"
          role={mobile.current ? undefined : "tab"}
          id="settings-tab-{s.id}"
          class="item"
          class:on={!mobile.current && active === s.id}
          class:alert={s.alertCount > 0}
          aria-selected={mobile.current ? undefined : active === s.id}
          aria-controls={mobile.current ? undefined : `settings-panel-${s.id}`}
          tabindex={mobile.current ? undefined : active === s.id ? 0 : -1}
          bind:this={navEls[i]}
          onclick={() => pick(s.id)}
          onkeydown={(e) => onNavKey(e, i)}
        >
          <span class="glyph" class:red={s.id === "diagnose" && s.alertCount > 0} aria-hidden="true"
            >{s.glyph}</span
          >
          <span class="ilabel">{s.label}</span>
          {#if q && s.matchCount > 0}
            <span class="mcount">{s.matchCount}</span>
          {:else if s.alertCount > 0}
            {#if mobile.current}
              <span class="ichip">
                {s.alertCount === 1
                  ? m.settings_diag_issue_one()
                  : m.settings_diag_issues({ count: s.alertCount })}
              </span>
            {:else}
              <span class="idot" aria-hidden="true"></span>
            {/if}
          {:else if mobile.current && s.summary}
            <span class="isummary">{s.summary}</span>
          {/if}
          {#if mobile.current}<span class="ichev" aria-hidden="true">›</span>{/if}
        </button>
      {/each}
    </div>
    <div class="rfoot">
      <span class="rver"
        >v{version} ·
        <span class="rlive" class:on={live}
          >● {live ? m.settings_live() : m.settings_offline()}</span
        ></span
      >
      <span class="rhint">{m.settings_apply_hint()}</span>
    </div>
  </nav>

  <div class="pane" hidden={showList}>
    <div class="phead">
      <span class="ptitle">{activeMeta.label}</span>
      {#if q}
        <span class="pmatches">
          {activeMeta.matchCount === 1
            ? m.settings_search_match_one({ query: q })
            : m.settings_search_matches({ count: activeMeta.matchCount, query: q })}
        </span>
      {/if}
      <span class="phint">{m.settings_apply_hint()}</span>
    </div>
    <div
      class="pbody"
      bind:this={paneEl}
      onscroll={() => {
        if (paneEl) scrollPos[active] = paneEl.scrollTop;
      }}
    >
      {@render children()}
    </div>
  </div>
</div>

<style>
  .shead {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .htitle {
    font-size: var(--fs-meta);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-ink);
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .x:hover {
    color: var(--color-ink-bright);
  }
  .x:focus-visible,
  .back:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .back {
    background: transparent;
    border: 0;
    padding: 0;
    min-width: 24px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-lg);
    cursor: pointer;
  }
  .body {
    display: flex;
    align-items: stretch;
    flex: 1;
    min-height: 0;
  }
  .rail:not([hidden]) {
    display: flex;
  }
  .rail {
    width: 176px;
    flex-shrink: 0;
    border-right: 1px solid var(--color-line);
    background: var(--color-panel-2);
    padding: 10px 0 8px;
    flex-direction: column;
    min-height: 0;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0 10px 10px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 6px 8px;
    border-radius: 2px;
    cursor: text;
  }
  .search:focus-within {
    border-color: var(--color-line-bright);
  }
  .search input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 0;
    outline: none;
    padding: 0;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    caret-color: var(--color-amber);
  }
  .search input::placeholder {
    color: var(--color-faint);
  }
  .sglyph {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .skbd {
    font-family: inherit;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 0 4px;
  }
  .items {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: transparent;
    border: 0;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    cursor: pointer;
    text-align: left;
  }
  .item:hover {
    background: var(--color-hover);
    color: var(--color-ink);
  }
  .item.on {
    color: var(--color-ink-bright);
    background: var(--color-sel);
    box-shadow: inset 2px 0 0 var(--color-amber);
  }
  .item:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: -2px;
  }
  .glyph {
    width: 14px;
    text-align: center;
    flex-shrink: 0;
  }
  .glyph.red {
    color: var(--color-red);
  }
  .ilabel {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mcount {
    font-size: var(--fs-micro);
    color: var(--color-amber);
    font-variant-numeric: tabular-nums;
  }
  .idot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-red);
    flex-shrink: 0;
  }
  .isummary,
  .ichip,
  .ichev {
    display: none;
  }
  .rfoot {
    margin-top: auto;
    padding: 10px 14px;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
    display: flex;
    align-items: center;
  }
  .rlive {
    color: var(--color-faint);
  }
  .rlive.on {
    color: var(--color-green);
  }
  .rhint {
    display: none;
  }
  .pane:not([hidden]) {
    display: flex;
  }
  .pane {
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .phead {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 12px 18px 10px;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .ptitle {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .pmatches {
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
  .phint {
    margin-left: auto;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    letter-spacing: 0.08em;
  }
  .pbody {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 6px 18px 18px;
  }

  @media (max-width: 768px) {
    .shead {
      padding: 14px 16px 12px;
    }
    .htitle {
      font-size: var(--fs-base);
    }
    .x {
      font-size: var(--fs-lg);
    }
    .rail {
      width: 100%;
      border-right: 0;
      background: transparent;
      padding: 12px 0 0;
    }
    .search {
      margin: 0 16px 4px;
      padding: 11px 12px;
    }
    .search input {
      font-size: var(--fs-lg);
    }
    .sglyph {
      font-size: var(--fs-base);
    }
    .skbd {
      display: none;
    }
    .items {
      padding: 8px 0;
    }
    .item {
      min-height: 52px;
      padding: 0 20px;
      border-bottom: 1px solid var(--color-line);
      font-size: var(--fs-lg);
      letter-spacing: normal;
      text-transform: none;
      color: var(--color-ink);
      gap: 12px;
    }
    .item.alert {
      color: var(--color-ink-bright);
    }
    .glyph {
      width: 18px;
      color: var(--color-muted);
    }
    .isummary {
      display: inline;
      font-size: var(--fs-meta);
      color: var(--color-faint);
      font-variant-numeric: tabular-nums;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 45%;
    }
    .ichip {
      display: inline;
      font-size: var(--fs-meta);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--color-red);
      border: 1px solid var(--color-red);
      padding: 1px 8px;
      border-radius: 6px;
      white-space: nowrap;
    }
    .ichev {
      display: inline;
      color: var(--color-faint);
      font-size: var(--fs-base);
    }
    .mcount {
      font-size: var(--fs-meta);
    }
    .rfoot {
      border-top: 1px solid var(--color-line);
      padding: 14px 20px;
      font-size: var(--fs-meta);
    }
    .rhint {
      display: inline;
      margin-left: auto;
    }
    .phead {
      display: none;
    }
    .pbody {
      padding: 4px 20px 16px;
    }
  }

  @media (pointer: coarse) {
    .x,
    .back {
      min-height: 44px;
      min-width: 44px;
    }
    .item {
      min-height: 44px;
    }
  }
</style>
