<script lang="ts">
  import {
    getScratchpadListing,
    scratchpadDownloadUrl,
    uploadScratchpadFile,
    getWorktreeListing,
    worktreeDownloadUrl,
    ApiError,
  } from "$lib/api";
  import type { ScratchEntry, ScratchListing } from "$lib/types";
  import { ATTACHMENTS_DIR } from "$lib/session-files";
  import { m } from "$lib/paraglide/messages";
  import { relativeAge } from "$lib/format";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import InfoTip from "$lib/components/InfoTip.svelte";
  import { untrack } from "svelte";

  // Read/upload browser of the session's scratchpad subtree (#1164, #1258). Click a directory to
  // descend, click a file to download it. Upload via button or drag-and-drop into the current dir.
  let { sessionId }: { sessionId: string } = $props();

  let source = $state<"scratchpad" | "worktree">("scratchpad");
  const readOnly = $derived(source === "worktree");

  let listing = $state<ScratchListing | null>(null);
  let loading = $state(false);
  let error = $state(false);

  // The synthetic Attachments overlay (#1717) is a read-only view of the worktree's uploads dir.
  // `uploadDisabled` gates ONLY the upload affordances (button + drag/drop) — NOT the label/aria
  // derivations, which stay keyed on `source` so the scratchpad Attachments folder keeps its
  // scratchpad strings (reusing `readOnly` here would mislabel it with Worktree text).
  const withinAttachments = $derived(
    (listing?.path ?? "") === ATTACHMENTS_DIR ||
      (listing?.path ?? "").startsWith(`${ATTACHMENTS_DIR}/`),
  );
  const uploadDisabled = $derived(readOnly || withinAttachments);

  // Row/breadcrumb label for the synthetic Attachments folder is localized; every real entry
  // renders its own name verbatim (names are data, not app chrome).
  const displayName = (e: ScratchEntry) => (e.attachments ? m.files_attachments_folder() : e.name);

  // Sort state for the two clickable columns. Default = dirs-first + name-ascending (the
  // server's own order). `now` anchors the relative-age labels; refreshed on each load so
  // ages don't drift while the panel sits open. Sorting is client-side over the one loaded
  // directory — no refetch.
  let sortKey = $state<"name" | "created">("name");
  let sortDir = $state<"asc" | "desc">("asc");
  let now = $state(Date.now());

  function resetSort() {
    sortKey = "name";
    sortDir = "asc";
  }

  function toggleSort(key: "name" | "created") {
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = key === "created" ? "desc" : "asc"; // creation date defaults to newest-first
    }
  }

  // Sort state is announced through the header button's aria-label (the rows are interactive
  // <a>/<button> elements, so a real ARIA grid with row/cell roles would strip their semantics;
  // aria-sort without that grid context is ignored by AT anyway). When a column is active the
  // label also states the current direction.
  const sortLabel = (key: "name" | "created") => {
    const base = key === "name" ? m.files_sort_name_aria() : m.files_sort_created_aria();
    if (sortKey !== key) return base;
    const dir = sortDir === "asc" ? m.files_sort_dir_asc() : m.files_sort_dir_desc();
    return m.files_sort_active({ label: base, dir });
  };

  const hasCreated = (e: ScratchEntry): e is ScratchEntry & { createdMs: number } =>
    e.createdMs != null && Number.isFinite(e.createdMs);

  const byName = (a: ScratchEntry, b: ScratchEntry, dir: "asc" | "desc") => {
    const r = a.name.localeCompare(b.name);
    return dir === "asc" ? r : -r;
  };

  // Missing `createdMs` sorts last regardless of direction; equal dates fall back to name (unflipped).
  const byCreated = (a: ScratchEntry, b: ScratchEntry, dir: "asc" | "desc") => {
    const am = !hasCreated(a);
    const bm = !hasCreated(b);
    if (am !== bm) return am ? 1 : -1;
    if (!am && !bm) {
      const d = a.createdMs! - b.createdMs!;
      if (d !== 0) return dir === "asc" ? d : -d;
    }
    return a.name.localeCompare(b.name);
  };

  // Directories always group above files; the active column orders within each group.
  const sortedEntries = $derived.by(() => {
    const es = listing?.entries ?? [];
    return [...es].sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return sortKey === "created" ? byCreated(a, b, sortDir) : byName(a, b, sortDir);
    });
  });

  type UploadStatus = {
    id: number;
    name: string;
    state: "uploading" | "done" | "failed" | "too_large";
  };
  let uploads = $state<UploadStatus[]>([]);
  let nextUploadId = 0;
  let dragOver = $state(false);

  let fileInput = $state<HTMLInputElement>();

  async function browse(path: string) {
    loading = true;
    error = false;
    try {
      listing =
        source === "worktree"
          ? await getWorktreeListing(sessionId, path || undefined)
          : await getScratchpadListing(sessionId, path || undefined);
      now = Date.now(); // anchor relative-age labels to load time
    } catch {
      error = true;
    } finally {
      loading = false;
    }
  }

  function switchSource(s: "scratchpad" | "worktree") {
    if (s === source) return;
    source = s;
    uploads = []; // upload statuses belong to the scratchpad session
    listing = null; // avoid a stale-source listing flashing under the new source's labels/hrefs
    resetSort(); // each source starts at the default sort
    void browse(""); // reset to root and reload from the new source
  }

  const downloadUrl = (p: string) =>
    source === "worktree" ? worktreeDownloadUrl(sessionId, p) : scratchpadDownloadUrl(sessionId, p);

  // (Re)load the root whenever the viewed session changes. Keyed on the id value so it only
  // re-runs on an actual unit switch, not on session-object churn. The reset/reload itself is
  // wrapped in `untrack` so reading `source` inside `browse()` doesn't make this effect
  // (wrongly) re-fire whenever the user flips the source switch — it must only key off sessionId.
  $effect(() => {
    const id = sessionId;
    untrack(() => {
      source = "scratchpad";
      listing = null;
      error = false;
      uploads = [];
      resetSort();
      void browse("");
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    id;
  });

  const rootCrumbLabel = $derived(readOnly ? m.files_worktree_root_crumb() : m.files_root_crumb());
  const breadcrumbAria = $derived(
    readOnly ? m.files_worktree_breadcrumb_aria() : m.files_breadcrumb_aria(),
  );
  const listAria = $derived(readOnly ? m.files_worktree_list_aria() : m.files_list_aria());
  const emptyText = $derived(readOnly ? m.files_worktree_empty() : m.files_empty());
  const loadErrorText = $derived(readOnly ? m.files_worktree_load_error() : m.files_load_error());

  // Breadcrumb segments from the current relative path; the first crumb is the source root.
  const crumbs = $derived.by(() => {
    const segs = listing?.path ? listing.path.split("/") : [];
    const out: { label: string; path: string }[] = [{ label: rootCrumbLabel, path: "" }];
    let acc = "";
    for (const s of segs) {
      acc = acc ? `${acc}/${s}` : s;
      // Localize the top-level reserved Attachments segment (scratchpad source only); every other
      // crumb is a real path segment rendered verbatim.
      const label =
        source === "scratchpad" && acc === ATTACHMENTS_DIR ? m.files_attachments_folder() : s;
      out.push({ label, path: acc });
    }
    return out;
  });

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    const dirPath = listing?.path || undefined;

    // Add each file to the status list as "uploading"; assign stable unique ids
    const newUploads: UploadStatus[] = files.map((f) => ({
      id: nextUploadId++,
      name: f.name,
      state: "uploading",
    }));
    uploads = [...uploads, ...newUploads];

    await Promise.all(
      newUploads.map(async (entry, idx) => {
        const uid = entry.id;
        const file = files[idx];
        try {
          await uploadScratchpadFile(sessionId, file, dirPath);
          uploads = uploads.map((u) => (u.id === uid ? { ...u, state: "done" } : u));
        } catch (e) {
          const isTooLarge = e instanceof ApiError && e.status === 413;
          uploads = uploads.map((u) =>
            u.id === uid ? { ...u, state: isTooLarge ? "too_large" : "failed" } : u,
          );
        }
      }),
    );

    // Refresh listing once all uploads have settled
    void browse(listing?.path ?? "");
  }

  function handleFileInput(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files?.length) {
      void uploadFiles(Array.from(input.files));
      input.value = "";
    }
  }

  function handleDragOver(e: DragEvent) {
    if (uploadDisabled) return;
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave(e: DragEvent) {
    if (uploadDisabled) return;
    // Ignore leave events triggered by crossing into a child element — only clear on a real exit.
    if (e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node)) return;
    dragOver = false;
  }

  function handleDrop(e: DragEvent) {
    if (uploadDisabled) return;
    e.preventDefault();
    dragOver = false;
    if (!listing) return; // still loading
    const files = e.dataTransfer?.files;
    if (files?.length) void uploadFiles(Array.from(files));
  }

  function openFilePicker() {
    fileInput?.click();
  }
</script>

<div
  class="files"
  role="region"
  aria-label={listAria}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <div class="seg-row">
    <div class="seg-tabs" role="group" aria-label={m.files_source_switch_aria()}>
      <button
        type="button"
        class="seg-btn"
        class:seg-active={source === "scratchpad"}
        aria-pressed={source === "scratchpad"}
        onclick={() => switchSource("scratchpad")}>{m.files_source_scratchpad()}</button
      >
      <button
        type="button"
        class="seg-btn"
        class:seg-active={source === "worktree"}
        aria-pressed={source === "worktree"}
        onclick={() => switchSource("worktree")}>{m.files_source_worktree()}</button
      >
    </div>
    <div class="seg-tip">
      <InfoTip
        text={m.files_source_difference_tip()}
        label={m.newtask_info_aria({ topic: m.files_source_switch_aria() })}
        prominent={true}
      />
    </div>
  </div>
  {#if dragOver}
    <!-- Whole-tab drop overlay; sits over (not inside) the scroll wrapper so it always covers the
         visible area, and pointer-events:none keeps drag/drop events reaching .files -->
    <div class="drop-overlay" aria-hidden="true">
      <span class="drop-overlay-hint">{m.files_upload_drop_hint()}</span>
    </div>
  {/if}
  <!-- Scroll wrapper; .files itself stays non-scrolling so the overlay anchors to the viewport -->
  <div class="files-scroll">
    <div class="toolbar">
      <nav class="crumbs" aria-label={breadcrumbAria}>
        {#each crumbs as c, i (c.path)}
          {#if i > 0}<span class="crumb-sep" aria-hidden="true">/</span>{/if}
          {#if i === crumbs.length - 1}
            <span class="crumb current" aria-current="page">{c.label}</span>
          {:else}
            <button type="button" class="crumb" onclick={() => browse(c.path)}>{c.label}</button>
          {/if}
        {/each}
      </nav>
      {#if !uploadDisabled}
        <button
          type="button"
          class="gbtn upload-btn"
          aria-label={m.files_upload_aria()}
          disabled={listing === null}
          onclick={openFilePicker}
          use:coachTarget={"scratchpad-upload"}>{m.files_upload_button()}</button
        >
        <!-- Hidden real input; triggered by the upload button -->
        <input
          bind:this={fileInput}
          type="file"
          multiple
          class="sr-only"
          aria-hidden="true"
          tabindex="-1"
          onchange={handleFileInput}
        />
      {/if}
    </div>

    <!-- Upload status lines -->
    {#each uploads as u (u.id)}
      {#if u.state === "uploading"}
        <div class="upload-status">{m.files_uploading({ name: u.name })}</div>
      {:else if u.state === "too_large"}
        <div class="upload-status err">{m.files_upload_too_large({ name: u.name })}</div>
      {:else if u.state === "failed"}
        <div class="upload-status err">{m.files_upload_failed({ name: u.name })}</div>
      {:else if u.state === "done"}
        <div class="upload-status ok">{m.files_upload_done({ name: u.name })}</div>
      {/if}
    {/each}

    <!-- Created cell shared by every row type; guards a missing/non-finite createdMs (stat
         failure / older payload) so it never renders "NaNs". -->
    {#snippet createdCell(e: ScratchEntry)}
      {@const c = hasCreated(e) ? e.createdMs : null}
      {#if c !== null}
        <span class="created" title={new Date(c).toLocaleString()}>{relativeAge(c, now)}</span>
      {:else}
        <span
          class="created empty"
          title={m.files_created_unknown()}
          aria-label={m.files_created_unknown()}>—</span
        >
      {/if}
    {/snippet}

    <!-- File list; the whole .files tab is the drop zone (see handlers above) -->
    <div class="list">
      {#if loading && !listing}
        <div class="placeholder">{m.common_loading()}</div>
      {:else if error}
        <div class="placeholder err">{loadErrorText}</div>
      {:else if listing && listing.entries.length === 0}
        <div class="placeholder empty-droppable">
          <span>{emptyText}</span>
          {#if !uploadDisabled}
            <span class="drop-hint">{m.files_upload_drop_hint()}</span>
          {/if}
        </div>
      {:else if listing}
        <div class="list-head">
          <span class="hcell" aria-hidden="true"></span>
          <span class="hcell">
            <button
              type="button"
              class="col-btn"
              aria-label={sortLabel("name")}
              onclick={() => toggleSort("name")}
            >
              {m.files_col_name()}{#if sortKey === "name"}<span class="arrow" aria-hidden="true"
                  >{sortDir === "asc" ? "▲" : "▼"}</span
                >{/if}
            </button>
          </span>
          <span class="hcell hcreated">
            <button
              type="button"
              class="col-btn"
              aria-label={sortLabel("created")}
              onclick={() => toggleSort("created")}
            >
              {m.files_col_created()}{#if sortKey === "created"}<span
                  class="arrow"
                  aria-hidden="true">{sortDir === "asc" ? "▲" : "▼"}</span
                >{/if}
            </button>
          </span>
          <span class="hcell" aria-hidden="true"></span>
        </div>
        {#each sortedEntries as e (e.path)}
          {#if e.linkOutside}
            <div class="row link-outside" aria-disabled="true" title={m.files_link_outside_title()}>
              <span class="ico" aria-hidden="true">↗</span>
              <span class="nm">{displayName(e)}</span>
              {@render createdCell(e)}
              <span class="trail" aria-hidden="true"></span>
            </div>
          {:else if e.type === "dir"}
            <button type="button" class="row" onclick={() => browse(e.path)}>
              <span class="ico" aria-hidden="true">▸</span>
              <span class="nm">{displayName(e)}</span>
              {@render createdCell(e)}
              <span class="chev trail" aria-hidden="true">›</span>
            </button>
          {:else}
            <!-- eslint-disable svelte/no-navigation-without-resolve -- server API download endpoint, not an app route -->
            <a
              class="row file"
              href={downloadUrl(e.path)}
              download={e.name}
              aria-label={m.files_download_aria({ name: e.name })}
            >
              <span class="ico" aria-hidden="true">▢</span>
              <span class="nm">{e.name}</span>
              {@render createdCell(e)}
              <span class="dl trail" aria-hidden="true">↓</span>
            </a>
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
          {/if}
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .files {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .files-scroll {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .seg-row {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .seg-tabs {
    display: flex;
    flex: 1;
    min-width: 0;
  }
  .seg-tip {
    flex: 0 0 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-left: 1px solid var(--color-line);
    background: var(--color-inset);
  }
  .seg-btn {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    border: 0;
    border-right: 1px solid var(--color-line);
    background: none;
    font-family: inherit;
    font-size: var(--fs-base);
    cursor: pointer;
    padding: 0 2px;
    color: var(--color-muted);
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .seg-btn:last-child {
    border-right: 0;
  }
  .seg-btn:hover {
    color: var(--color-ink);
  }
  .seg-btn.seg-active {
    color: var(--color-amber);
    background: var(--color-inset);
    box-shadow: inset 0 -2px 0 var(--color-amber);
  }
  .seg-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .drop-overlay {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 6px;
    border: 2px dashed var(--color-blue);
    border-radius: 4px;
    background: color-mix(in srgb, var(--color-blue) 10%, var(--color-inset));
  }
  .drop-overlay-hint {
    color: var(--color-blue);
    font-family: var(--font-mono);
    font-size: var(--fs-lg);
    letter-spacing: 0.04em;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .crumbs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    flex: 1;
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
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .upload-btn {
    font-size: var(--fs-meta);
    padding: 4px 10px;
    min-height: 28px;
    flex-shrink: 0;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .upload-status {
    padding: 5px 12px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    letter-spacing: 0.04em;
  }
  .upload-status.err {
    color: var(--color-red);
  }
  .upload-status.ok {
    color: var(--color-muted);
  }
  .list {
    /* Shared 4-track row grid: leading icon | name (flex) | created (fixed, right-aligned) |
       trailing affordance (chevron / download / empty for linkOutside). Fixed created + trailing
       widths keep the header labels aligned over the row cells. */
    --files-cols: 1.1rem minmax(0, 1fr) 4.75rem 1.1rem;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    display: flex;
    flex-direction: column;
  }
  .list-head {
    display: grid;
    grid-template-columns: var(--files-cols);
    align-items: center;
    gap: 9px;
    padding: 6px 11px;
    border-bottom: 1px solid var(--color-line);
  }
  .hcell {
    min-width: 0;
  }
  .hcreated {
    justify-self: end;
  }
  .col-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: 0;
    padding: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
    color: var(--color-muted);
    cursor: pointer;
  }
  .col-btn:hover {
    color: var(--color-ink-bright);
  }
  .col-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 1px var(--color-amber);
    border-radius: 2px;
  }
  .arrow {
    color: var(--color-amber);
    font-size: 0.85em;
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
  .empty-droppable {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .drop-hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    font-style: italic;
  }
  .row {
    display: grid;
    grid-template-columns: var(--files-cols);
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
  .row.link-outside {
    color: var(--color-faint);
    cursor: default;
  }
  .row.link-outside .ico {
    color: var(--color-faint);
  }
  .row.link-outside:hover {
    background: transparent;
  }
  .nm {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .created {
    justify-self: end;
    color: var(--color-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .created.empty {
    color: var(--color-faint);
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
    .col-btn {
      min-height: 44px;
    }
    .upload-btn {
      min-height: 44px;
      padding: 8px 14px;
    }
  }
</style>
