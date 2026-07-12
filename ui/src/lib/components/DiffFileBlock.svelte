<script lang="ts">
  import type { DiffFile } from "$lib/types";
  import { theme, type Resolved } from "$lib/theme.svelte";

  let { file }: { file: DiffFile } = $props();

  let open = $state(false);
  // per-line highlighted HTML for the whole file, in render order (null until loaded)
  let html = $state<string[] | null>(null);
  // which resolved theme `html` was rendered for — a theme switch invalidates it
  // (Shiki emits concrete foreground hexes, so dark-tuned HTML is illegible on light)
  let htmlTheme = $state<Resolved | null>(null);

  const STATUS_GLYPH: Record<DiffFile["status"], string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
  };

  const flatLines = $derived((file.hunks ?? []).flatMap((h) => h.lines));

  // lazily highlight the first time this file is expanded (one Shiki call per
  // file). The highlighter (and Shiki) is dynamically imported here so it stays
  // off the first-paint critical path — only pulled in on user expand.
  // Re-runs on theme switch (resolved is read up front as a dependency) so stale
  // dark-colored lines never linger on a light surface, and vice versa.
  $effect(() => {
    const resolved = theme.resolved;
    if (!open || file.binary || file.truncated || flatLines.length === 0) return;
    if (html && htmlTheme === resolved) return;
    let alive = true;
    import("$lib/highlight")
      .then(({ highlightLines }) =>
        highlightLines(
          flatLines.map((l) => l.content),
          file.path,
          resolved,
        ),
      )
      .then((h) => {
        if (alive) {
          html = h;
          htmlTheme = resolved;
        }
      })
      .catch((err) => {
        // Highlighting is progressive enhancement — fall back to the plain diff,
        // but surface the failure so a broken Shiki load isn't silent.
        console.warn("diff syntax highlighting failed", err);
      });
    return () => {
      alive = false;
    };
  });

  // pair each line with its highlighted HTML by global index (null until highlighted)
  const hunksView = $derived.by(() => {
    let i = 0;
    return (file.hunks ?? []).map((h) => ({
      header: h.header,
      lines: h.lines.map((line) => {
        const lineHtml = html ? (html[i] ?? null) : null;
        i++;
        return { line, lineHtml };
      }),
    }));
  });

  const mark = (kind: string) => (kind === "add" ? "+" : kind === "del" ? "−" : " ");
</script>

<div class="file">
  <button class="file-head" type="button" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="chev" class:open aria-hidden="true">▸</span>
    <span class="glyph status-{file.status}">{STATUS_GLYPH[file.status]}</span>
    <span class="path">
      {#if file.oldPath && file.status === "renamed"}{file.oldPath} →
      {/if}{file.path}
    </span>
    <span class="counts">
      <span class="add">+{file.additions}</span>
      <span class="del">−{file.deletions}</span>
    </span>
  </button>

  {#if open}
    {#if file.binary}
      <p class="note">binary file</p>
    {:else if file.truncated}
      <p class="note">large file — view in terminal</p>
    {:else if flatLines.length === 0}
      <p class="note">no textual changes</p>
    {:else}
      <!-- long diff lines scroll horizontally (overflow-x); opt out of the mobile
           page-swipe so a sideways drag scrolls the code instead of paging agents -->
      <div class="hunks" data-swipe-ignore>
        {#each hunksView as hunk (hunk.header)}
          <div class="hunk-head">{hunk.header}</div>
          {#each hunk.lines as item (item.line.kind + (item.line.oldNo ?? "") + (item.line.newNo ?? "") + item.line.content)}
            <div class="line {item.line.kind}">
              <span class="ln">{item.line.oldNo ?? ""}</span>
              <span class="ln">{item.line.newNo ?? ""}</span>
              <span class="mark">{mark(item.line.kind)}</span>
              {#if item.lineHtml}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by Shiki (escapeHtml + tokenizer) -->
                <span class="code">{@html item.lineHtml}</span>
              {:else}
                <span class="code">{item.line.content}</span>
              {/if}
            </div>
          {/each}
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .file {
    border: 1px solid var(--color-line);
    border-radius: 2px;
    margin-bottom: 6px;
    background: var(--color-panel);
    overflow: hidden;
  }
  .file-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    background: var(--color-head);
    border: 0;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
    text-align: left;
  }
  .file-head:hover {
    background: var(--color-hover);
  }
  .chev {
    color: var(--color-muted);
    transition: transform 0.12s;
    flex-shrink: 0;
  }
  .chev.open {
    transform: rotate(90deg);
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
  .note {
    margin: 0;
    padding: 6px 10px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .hunks {
    overflow-x: auto;
    font-size: var(--fs-meta);
    line-height: 1.5;
  }
  .hunk-head {
    color: var(--color-muted);
    background: var(--color-inset);
    padding: 1px 8px;
    white-space: pre;
  }
  .line {
    display: flex;
    white-space: pre;
  }
  .line.add {
    background: color-mix(in srgb, var(--color-green) 12%, transparent);
  }
  .line.del {
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
  }
  .ln {
    flex-shrink: 0;
    width: 4ch;
    text-align: right;
    padding-right: 6px;
    color: var(--color-faint);
    user-select: none;
  }
  .mark {
    flex-shrink: 0;
    width: 1.5ch;
    text-align: center;
    user-select: none;
    color: var(--color-muted);
  }
  .code {
    white-space: pre;
  }
</style>
