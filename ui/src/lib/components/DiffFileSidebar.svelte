<script lang="ts">
  // File rail for the multi-file diff tab: one selectable row per changed file.
  // Wide: a vertical list. Narrow (<=768px): the same rows collapse to a
  // horizontally-scrollable chip strip (CSS-only; one markup). Purely a
  // files -> rows mapping + selection callback — no business logic.
  import type { DiffFile } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    files,
    activePath,
    onselect,
  }: {
    files: DiffFile[];
    activePath?: string;
    onselect: (path: string) => void;
  } = $props();

  // Status glyph + colour convention, copied from DiffFileBlock.svelte.
  const STATUS_GLYPH: Record<DiffFile["status"], string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
  };

  const label = (file: DiffFile) =>
    file.oldPath && file.status === "renamed" ? `${file.oldPath} → ${file.path}` : file.path;
</script>

<nav class="sidebar" aria-label={m.diff_files_label()}>
  <div class="head">
    <span>{m.diff_files_label()}</span>
    <span class="count">{files.length}</span>
  </div>
  <!-- horizontal chip strip on narrow: opt out of the mobile page-swipe -->
  <ul class="rail" data-swipe-ignore>
    {#each files as file (file.path)}
      <li>
        <button
          type="button"
          class="row"
          class:active={file.path === activePath}
          aria-current={file.path === activePath ? "true" : undefined}
          title={label(file)}
          onclick={() => onselect(file.path)}
        >
          <span class="glyph status-{file.status}" aria-hidden="true">
            {STATUS_GLYPH[file.status]}
          </span>
          <span class="path">{label(file)}</span>
          <span class="counts">
            <span class="add">+{file.additions}</span>
            <span class="del">−{file.deletions}</span>
          </span>
        </button>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--color-panel);
    border-right: 1px solid var(--color-line);
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
    padding: 6px 10px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-line);
  }
  .count {
    font-variant-numeric: tabular-nums;
    color: var(--color-faint);
  }
  .rail {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    min-height: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 10px;
    background: transparent;
    border: 0;
    border-left: 2px solid transparent;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
    text-align: left;
  }
  .row:hover {
    background: var(--color-hover);
  }
  .row.active {
    background: var(--color-sel);
    border-left-color: var(--color-blue);
  }
  .glyph {
    flex-shrink: 0;
    width: 1em;
    text-align: center;
    font-weight: 600;
  }
  .status-added {
    color: var(--color-green);
  }
  .status-deleted {
    color: var(--color-red);
  }
  .status-renamed,
  .status-modified {
    color: var(--color-amber);
  }
  .path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .counts {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .counts .add {
    color: var(--color-green);
  }
  .counts .del {
    color: var(--color-red);
    margin-left: 6px;
  }

  /* Narrow: collapse the vertical list to a horizontal chip strip. */
  @media (max-width: 768px) {
    .sidebar {
      border-right: 0;
      border-bottom: 1px solid var(--color-line);
    }
    .rail {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 6px 10px;
    }
    .row {
      width: auto;
      max-width: 60vw;
      padding: 4px 8px;
      border: 1px solid var(--color-line);
      border-radius: 999px;
    }
    .row.active {
      border-color: var(--color-blue);
      border-left-color: var(--color-blue);
    }
    .counts {
      display: none;
    }
  }
</style>
