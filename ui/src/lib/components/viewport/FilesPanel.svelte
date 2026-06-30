<script lang="ts">
  import {
    getScratchpadListing,
    scratchpadDownloadUrl,
    uploadScratchpadFile,
    ApiError,
  } from "$lib/api";
  import type { ScratchListing } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

  // Read/upload browser of the session's scratchpad subtree (#1164, #1258). Click a directory to
  // descend, click a file to download it. Upload via button or drag-and-drop into the current dir.
  let { sessionId }: { sessionId: string } = $props();

  let listing = $state<ScratchListing | null>(null);
  let loading = $state(false);
  let error = $state(false);

  type UploadStatus = {
    id: number;
    name: string;
    state: "uploading" | "done" | "failed" | "too_large";
  };
  let uploads = $state<UploadStatus[]>([]);
  let nextUploadId = 0;
  let dragOver = $state(false);

  let fileInput: HTMLInputElement;

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
    uploads = [];
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
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave(e: DragEvent) {
    // Ignore leave events triggered by crossing into a child element — only clear on a real exit.
    if (e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node)) return;
    dragOver = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (!listing) return; // still loading
    const files = e.dataTransfer?.files;
    if (files?.length) void uploadFiles(Array.from(files));
  }

  function openFilePicker() {
    fileInput.click();
  }
</script>

<div
  class="files"
  role="region"
  aria-label={m.files_list_aria()}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
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

    <!-- File list; the whole .files tab is the drop zone (see handlers above) -->
    <div class="list">
      {#if loading && !listing}
        <div class="placeholder">{m.common_loading()}</div>
      {:else if error}
        <div class="placeholder err">{m.files_load_error()}</div>
      {:else if listing && listing.entries.length === 0}
        <div class="placeholder empty-droppable">
          <span>{m.files_empty()}</span>
          <span class="drop-hint">{m.files_upload_drop_hint()}</span>
        </div>
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
    .upload-btn {
      min-height: 44px;
      padding: 8px 14px;
    }
  }
</style>
