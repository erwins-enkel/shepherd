<script lang="ts">
  // Lazy, scrollable stack of file diffs. Each file is a <section> anchor with a
  // reserved min-height (from estimateHeight) so the total scroll height stays
  // ~stable before Pierre hydrates. An IntersectionObserver mounts each file's
  // <PierreDiff> as it nears the viewport; already-rendered files stay mounted
  // (keeps scroll + Pierre state stable). Files with no usable patch (binary /
  // truncated / no textual change) render a small note card instead.
  //
  // The stack scrolls inside its own container (not the page). `scrollToPath` is
  // exported for the parent (DiffPanel) to call via `bind:this`; it is robust to
  // lazy heights — it force-renders the target, scrolls, then re-scrolls after
  // Pierre's async render settles to correct any estimate delta.
  import { tick } from "svelte";
  import { SvelteSet, SvelteMap } from "svelte/reactivity";
  import type { DiffFile, DiffAgentAnnotation } from "$lib/types";
  import { fileSignature, estimateHeight } from "$lib/pierre-diff";
  import { m } from "$lib/paraglide/messages";
  import PierreDiff from "./PierreDiff.svelte";

  let {
    files,
    diffStyle,
    agentAnnotations,
    reviewFindings,
    onvisible,
  }: {
    files: DiffFile[];
    diffStyle: "split" | "unified";
    // #1699: per-file agent annotations (→ Pierre) and review findings (→ per-file banner). Maps
    // default to empty so the component renders exactly as before when no annotations are supplied.
    agentAnnotations?: Map<string, DiffAgentAnnotation[]>;
    reviewFindings?: Map<string, string[]>;
    onvisible?: (path: string) => void;
  } = $props();

  const STATUS_GLYPH: Record<DiffFile["status"], string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
  };

  type Note = "binary" | "truncated" | "no-changes";

  // Which non-renderable note (if any) a file shows instead of a Pierre diff.
  function noteKind(file: DiffFile): Note | null {
    if (file.binary) return "binary";
    if (file.truncated) return "truncated";
    if (!file.patch || file.patch.trim() === "") return "no-changes";
    return null;
  }

  // Stable, id-safe DOM id derived from the path (for anchoring/testing).
  const sectionId = (path: string) => `df-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  const byPath = $derived(new Map(files.map((f) => [f.path, f])));

  // Paths whose PierreDiff has been mounted. SvelteSet so mutations are reactive.
  const rendered = new SvelteSet<string>();

  // path -> section element, for scroll targeting + observation. (A plain lookup,
  // never read reactively; SvelteMap satisfies the prefer-svelte-reactivity lint.)
  const sections = new SvelteMap<string, HTMLElement>();

  let scroller = $state<HTMLElement>();
  let observer: IntersectionObserver | undefined;
  let lastReported: string | undefined;

  function markRendered(path: string) {
    const file = byPath.get(path);
    if (file && noteKind(file) === null) rendered.add(path);
  }

  // Report the top-most currently-visible file up (sidebar highlight). Walks
  // files in order and picks the first whose bottom clears the scroller's top.
  function reportVisible() {
    if (!onvisible || !scroller) return;
    const top = scroller.getBoundingClientRect().top;
    for (const file of files) {
      const el = sections.get(file.path);
      if (!el) continue;
      if (el.getBoundingClientRect().bottom > top + 1) {
        if (file.path !== lastReported) {
          lastReported = file.path;
          onvisible(file.path);
        }
        return;
      }
    }
  }

  function onIntersect(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const path = (entry.target as HTMLElement).dataset.diffPath;
      if (path) markRendered(path);
    }
    reportVisible();
  }

  // Svelte action: register a section element + observe it. Handles sections that
  // mount after the observer exists (files prop change); sections that exist when
  // the observer is (re)created are picked up by the effect below.
  function registerSection(node: HTMLElement, path: string) {
    sections.set(path, node);
    observer?.observe(node);
    return {
      destroy() {
        observer?.unobserve(node);
        if (sections.get(path) === node) sections.delete(path);
      },
    };
  }

  // Own the IntersectionObserver; re-created if the scroller element changes.
  // Cleaned up on destroy (no listener/observer leak).
  $effect(() => {
    if (typeof IntersectionObserver === "undefined" || !scroller) return;
    const io = new IntersectionObserver(onIntersect, {
      root: scroller,
      rootMargin: "300px 0px",
      threshold: 0,
    });
    observer = io;
    for (const node of sections.values()) io.observe(node);
    return () => {
      io.disconnect();
      if (observer === io) observer = undefined;
    };
  });

  /** Scroll a file into view, force-rendering it first and correcting for the
   *  lazy-height estimate once Pierre's async render settles. Callable via
   *  `bind:this` from the parent (Svelte 5 instance-method export). */
  export async function scrollToPath(path: string): Promise<void> {
    markRendered(path); // force-render (no-op for note-card files)
    await tick(); // let the PierreDiff mount into the section
    sections.get(path)?.scrollIntoView({ block: "start" });
    // Pierre renders asynchronously (dynamic import + parse), so the section grows
    // past its estimate after mount — re-scroll on the next frames to correct.
    // AWAIT the double-rAF so the returned promise doesn't resolve until the
    // corrective scroll has fired (Task 5's DiffPanel awaits this for positioning).
    await tick();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          sections.get(path)?.scrollIntoView({ block: "start" });
          resolve();
        });
      });
    });
  }
</script>

<div class="stack" bind:this={scroller} data-swipe-ignore>
  {#each files as file (file.path)}
    {@const note = noteKind(file)}
    <section
      id={sectionId(file.path)}
      data-diff-path={file.path}
      use:registerSection={file.path}
      style={note === null && !rendered.has(file.path)
        ? `min-height:${estimateHeight(file)}px`
        : undefined}
    >
      <header class="fhead">
        <span class="glyph status-{file.status}" aria-hidden="true">
          {STATUS_GLYPH[file.status]}
        </span>
        <span class="path">
          {#if file.oldPath && file.status === "renamed"}{file.oldPath} →
          {/if}{file.path}
        </span>
        <span class="counts">
          <span class="add">+{file.additions}</span>
          <span class="del">−{file.deletions}</span>
        </span>
      </header>

      <!-- Per-file review banner (#1699). Placed in the ALWAYS-rendered part of the section (before
           the note/body branch), so it shows regardless of the IntersectionObserver lazy-mount
           (rendered) or noteKind (binary/truncated/no-changes) — a finding on an off-screen or
           note-card file still surfaces. Text is verbatim data via {text} (auto-escaped), no HTML. -->
      {#if reviewFindings?.get(file.path)?.length}
        <div class="review-banner" role="note">
          <span class="review-chip">{m.viewport_diff_annotation_review()}</span>
          <ul class="review-list">
            {#each reviewFindings.get(file.path) ?? [] as finding (finding)}
              <li>{finding}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if note !== null}
        <p class="note">
          {#if note === "binary"}{m.diff_note_binary()}
          {:else if note === "truncated"}{m.diff_note_truncated()}
          {:else}{m.diff_note_no_changes()}{/if}
        </p>
      {:else if rendered.has(file.path)}
        <div class="body" data-swipe-ignore>
          <PierreDiff
            patch={file.patch ?? ""}
            signature={fileSignature(file)}
            {diffStyle}
            lineAnnotations={agentAnnotations?.get(file.path) ?? []}
          />
        </div>
      {/if}
    </section>
  {/each}
</div>

<style>
  .stack {
    height: 100%;
    overflow-y: auto;
    min-height: 0;
    background: var(--color-inset);
  }
  section {
    border-bottom: 1px solid var(--color-line);
  }
  .fhead {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
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
    padding: 8px 12px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }

  /* Per-file review banner (#1699) — critic findings for this file. Amber (attention) accent per
     the semantic-hue rule; verbatim finding text via {text} interpolation, never {@html}. */
  .review-banner {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 6px 12px;
    background: var(--color-inset);
    border-bottom: 1px solid var(--color-line);
    border-left: 2px solid var(--color-amber);
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .review-chip {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-amber);
  }
  .review-list {
    margin: 0;
    padding-left: 1.1em;
    list-style: disc;
  }
  .review-list li {
    overflow-wrap: anywhere;
  }
  .body {
    padding: 4px 0;
    overflow-x: auto;
  }
</style>
