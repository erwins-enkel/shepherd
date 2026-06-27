<script lang="ts">
  import { getScratchpadListing, scratchpadDownloadUrl } from "$lib/api";
  import type { ScratchListing } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  // Read-only browser of the session's scratchpad subtree (#1164). Click a directory to descend,
  // click a file to download it. Server enforces containment to the scratchpad root.
  let { sessionId }: { sessionId: string } = $props();

  let listing = $state<ScratchListing | null>(null);
  let loading = $state(false);
  let error = $state(false);

  async function browse(path: string) {
    loading = true;
    error = false;
    try {
      listing = await getScratchpadListing(sessionId, path || undefined);
    } catch {
      error = true;
    } finally {
      loading = false;
    }
  }

  // (Re)load the root whenever the viewed session changes. Keyed on the id value so it only
  // re-runs on an actual unit switch, not on session-object churn.
  $effect(() => {
    const id = sessionId;
    listing = null;
    error = false;
    void browse("");
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    id;
  });

  // Breadcrumb segments from the current relative path; the first crumb is the scratchpad root.
  const crumbs = $derived.by(() => {
    const segs = listing?.path ? listing.path.split("/") : [];
    const out: { label: string; path: string }[] = [{ label: m.files_root_crumb(), path: "" }];
    let acc = "";
    for (const s of segs) {
      acc = acc ? `${acc}/${s}` : s;
      out.push({ label: s, path: acc });
    }
    return out;
  });
</script>

<div class="files">
  <nav class="crumbs" aria-label={m.files_breadcrumb_aria()}>
    {#each crumbs as c, i (c.path)}
      {#if i > 0}<span class="crumb-sep" aria-hidden="true">/</span>{/if}
      {#if i === crumbs.length - 1}
        <span class="crumb current" aria-current="page">{c.label}</span>
      {:else}
        <button type="button" class="crumb" onclick={() => browse(c.path)}>{c.label}</button>
      {/if}
    {/each}
  </nav>

  <div class="list">
    {#if loading && !listing}
      <div class="placeholder">{m.common_loading()}</div>
    {:else if error}
      <div class="placeholder err">{m.files_load_error()}</div>
    {:else if listing && listing.entries.length === 0}
      <div class="placeholder">{m.files_empty()}</div>
    {:else if listing}
      {#each listing.entries as e (e.path)}
        {#if e.type === "dir"}
          <button type="button" class="row" onclick={() => browse(e.path)}>
            <span class="ico" aria-hidden="true">▸</span>
            <span class="nm">{e.name}</span>
            <span class="chev" aria-hidden="true">›</span>
          </button>
        {:else}
          <!-- eslint-disable svelte/no-navigation-without-resolve -- server API download endpoint, not an app route -->
          <a
            class="row file"
            href={scratchpadDownloadUrl(sessionId, e.path)}
            download={e.name}
            aria-label={m.files_download_aria({ name: e.name })}
          >
            <span class="ico" aria-hidden="true">▢</span>
            <span class="nm">{e.name}</span>
            <span class="dl" aria-hidden="true">↓</span>
          </a>
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
        {/if}
      {/each}
    {/if}
  </div>
</div>

<style>
  .files {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    overflow-y: auto;
    height: 100%;
  }
  .crumbs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }
  .crumb {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    padding: 2px 3px;
    cursor: pointer;
  }
  .crumb:hover:not(.current) {
    color: var(--color-ink-bright);
  }
  .crumb.current {
    color: var(--color-ink-bright);
    cursor: default;
  }
  .crumb-sep {
    color: var(--color-faint);
  }
  .list {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    display: flex;
    flex-direction: column;
  }
  .placeholder {
    padding: 14px 12px;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
  }
  .placeholder.err {
    color: var(--color-red);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    text-align: left;
    text-decoration: none;
    padding: 8px 11px;
    cursor: pointer;
  }
  .row:last-child {
    border-bottom: 0;
  }
  .row:hover {
    background: var(--color-panel);
  }
  .ico {
    color: var(--color-muted);
    flex-shrink: 0;
  }
  .row.file .ico {
    color: var(--color-faint);
  }
  .nm {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev,
  .dl {
    color: var(--color-faint);
    flex-shrink: 0;
  }
  .row.file:hover .dl {
    color: var(--color-ink-bright);
  }

  @media (max-width: 768px) {
    .row {
      min-height: 44px;
    }
  }
</style>
