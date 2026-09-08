<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  let { block }: { block: Extract<VisualBlock, { type: "rich-text" }> } = $props();
  let rendered = $state("");

  /**
   * Tint the lines of a ```diff fence (#2194). The recap prompt asks for a "shape sketch" —
   * a before/after of a component tree, file layout or control flow — inside a rich-text
   * block, and an untinted one reads as a wall of monospace.
   *
   * Safety: this pass cannot reintroduce markup DOMPurify removed. It takes the sanitized DOM
   * *fragment* rather than the HTML string, and every node it adds is one it created itself and
   * filled via `textContent` — so a `<script>` inside a diff fence stays inert text. The result
   * is still serialized here and re-parsed by `{@html}` below, exactly as before this pass
   * existed; that round trip is unchanged, and it round-trips sanitized content either way.
   */
  function tintDiffFences(fragment: DocumentFragment): string {
    const host = document.createElement("div");
    host.append(fragment);
    for (const code of host.querySelectorAll("pre > code.language-diff")) {
      const lines = (code.textContent ?? "").split("\n");
      // A trailing newline from the fence would otherwise render as a blank tinted row.
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      code.textContent = "";
      for (const line of lines) {
        const span = document.createElement("span");
        span.className = `dl ${lineKind(line)}`;
        span.textContent = line;
        code.append(span, document.createTextNode("\n"));
      }
    }
    return host.innerHTML;
  }

  /** Classify one diff line by its leading marker. Unmarked lines stay context. */
  function lineKind(line: string): string {
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    if (line.startsWith("@@")) return "meta";
    return "ctx";
  }

  $effect(() => {
    const md = block.markdown;
    if (!md) {
      rendered = "";
      return;
    }
    let alive = true;
    Promise.all([import("marked"), import("dompurify")])
      .then(([{ marked }, { default: DOMPurify }]) => {
        if (alive)
          rendered = tintDiffFences(
            DOMPurify.sanitize(marked.parse(md, { async: false }) as string, {
              RETURN_DOM_FRAGMENT: true,
            }),
          );
      })
      .catch((err) => console.warn("RichTextBlock markdown render failed", err));
    return () => {
      alive = false;
    };
  });
</script>

{#if rendered}
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify above -->
  <div class="rt-md">{@html rendered}</div>
{/if}

<style>
  .rt-md {
    font-size: var(--fs-base);
    color: var(--color-ink);
    line-height: 1.5;
  }
  .rt-md :global(p) {
    margin: 0 0 8px 0;
  }
  .rt-md :global(ul),
  .rt-md :global(ol) {
    margin: 0 0 8px 0;
    padding-left: 18px;
  }
  .rt-md :global(a) {
    color: var(--color-amber);
  }
  .rt-md :global(code) {
    font-size: var(--fs-meta);
  }
  /* Fenced blocks — the shape sketch the recap prompt asks for lands here (#2194).
     Matches CodeBlock.svelte's surface so the two read as one language. */
  .rt-md :global(pre) {
    margin: 0 0 8px 0;
    padding: 6px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }
  .rt-md :global(pre code) {
    font-family: inherit;
    font-size: inherit;
  }
  .rt-md :global(pre code .dl) {
    display: inline-block;
    min-width: 100%;
  }
  /* Same tint recipe as DiffFileBlock's .line.add / .line.del, so a shape sketch and a real
     file diff read alike. */
  .rt-md :global(pre code .dl.add) {
    background: color-mix(in srgb, var(--color-green) 12%, transparent);
    color: var(--color-green);
  }
  .rt-md :global(pre code .dl.del) {
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
    color: var(--color-red);
  }
  .rt-md :global(pre code .dl.meta) {
    color: var(--color-muted);
  }
</style>
