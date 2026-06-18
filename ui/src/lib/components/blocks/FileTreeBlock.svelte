<script lang="ts">
  import type { VisualBlock, FileTreeEntry, FileTreeChange } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let { block }: { block: Extract<VisualBlock, { type: "file-tree" }> } = $props();

  // ── tree builder ────────────────────────────────────────────────────────────

  interface TreeLeaf {
    kind: "leaf";
    segment: string;
    entry: FileTreeEntry;
  }

  interface TreeDir {
    kind: "dir";
    segment: string;
    children: TreeNode[];
  }

  type TreeNode = TreeLeaf | TreeDir;

  function buildTree(entries: FileTreeEntry[]): TreeNode[] {
    // We build a nested structure keyed by path segments.
    // Each directory level is a Map from segment → TreeNode.
    type DirMap = Map<string, { dir?: DirMap; leaf?: FileTreeEntry }>;

    function insertEntry(map: DirMap, segments: string[], entry: FileTreeEntry): void {
      const [head, ...rest] = segments;
      if (rest.length === 0) {
        // leaf
        map.set(head, { ...map.get(head), leaf: entry });
      } else {
        const existing = map.get(head);
        const childMap: DirMap = existing?.dir ?? new Map();
        map.set(head, { ...existing, dir: childMap });
        insertEntry(childMap, rest, entry);
      }
    }

    function mapToNodes(map: DirMap): TreeNode[] {
      const nodes: TreeNode[] = [];
      for (const [segment, value] of map) {
        if (value.leaf) {
          nodes.push({ kind: "leaf", segment, entry: value.leaf });
        } else if (value.dir) {
          nodes.push({ kind: "dir", segment, children: mapToNodes(value.dir) });
        }
      }
      return nodes;
    }

    const root: DirMap = new Map();
    for (const entry of entries) {
      const segments = entry.path.split("/").filter(Boolean);
      if (segments.length > 0) insertEntry(root, segments, entry);
    }
    return mapToNodes(root);
  }

  const tree = $derived(buildTree(block.entries));

  // ── badge helpers ───────────────────────────────────────────────────────────

  const CHANGE_GLYPH: Record<FileTreeChange, string> = {
    added: "A",
    modified: "M",
    removed: "D",
    renamed: "R",
  };

  // Tokens mirroring DiffFileBlock status glyphs (.status-added/deleted/renamed/modified):
  // added→--color-green, modified→--color-amber, removed→--color-red, renamed→--color-amber
  const CHANGE_COLOR: Record<FileTreeChange, string> = {
    added: "var(--color-green)",
    modified: "var(--color-amber)",
    removed: "var(--color-red)",
    renamed: "var(--color-amber)",
  };

  function changeLabel(change: FileTreeChange): string {
    switch (change) {
      case "added":
        return m.vblock_filetree_added();
      case "modified":
        return m.vblock_filetree_modified();
      case "removed":
        return m.vblock_filetree_removed();
      case "renamed":
        return m.vblock_filetree_renamed();
    }
  }
</script>

<div class="ft-root">
  {#if block.title}
    <p class="ft-title">{block.title}</p>
  {/if}
  {#snippet node(nodes: TreeNode[], depth: number)}
    {#each nodes as n (n.segment)}
      {#if n.kind === "dir"}
        <div class="ft-row" style:padding-left="{depth * 12}px">
          <span class="ft-dir-icon" aria-hidden="true">▸</span>
          <span class="ft-segment">{n.segment}</span>
        </div>
        {@render node(n.children, depth + 1)}
      {:else}
        <div class="ft-row" style:padding-left="{depth * 12}px">
          <span
            class="ft-badge"
            style:color={CHANGE_COLOR[n.entry.change]}
            title={changeLabel(n.entry.change)}
            aria-label={changeLabel(n.entry.change)}>{CHANGE_GLYPH[n.entry.change]}</span
          >
          <span class="ft-segment">{n.segment}</span>
          {#if n.entry.note}
            <span class="ft-note">{n.entry.note}</span>
          {/if}
        </div>
      {/if}
    {/each}
  {/snippet}
  {@render node(tree, 0)}
</div>

<style>
  .ft-root {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .ft-title {
    margin: 0 0 4px 0;
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
    font-family: var(--font-sans, inherit);
  }
  .ft-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    line-height: 1.6;
  }
  .ft-dir-icon {
    color: var(--color-faint);
    flex-shrink: 0;
    width: 1em;
    text-align: center;
  }
  .ft-badge {
    flex-shrink: 0;
    width: 1em;
    text-align: center;
    font-weight: 600;
  }
  .ft-segment {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ft-note {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
