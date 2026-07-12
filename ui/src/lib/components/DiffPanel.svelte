<script lang="ts">
  import { getDiff } from "$lib/api";
  import { pollWhileVisible } from "$lib/visibility";
  import { diffTotals } from "$lib/diff";
  import { diffView } from "$lib/diff-view.svelte";
  import type { DiffResult } from "$lib/types";
  import DiffFileSidebar from "$lib/components/DiffFileSidebar.svelte";
  import DiffFileStack from "$lib/components/DiffFileStack.svelte";
  import { m } from "$lib/paraglide/messages";

  let { sessionId }: { sessionId: string } = $props();

  let result = $state<DiffResult | null>(null);
  let loaded = $state(false);
  let failed = $state(false);
  // Currently-highlighted file (sidebar). Set on select + as the stack scrolls.
  let activePath = $state<string | undefined>(undefined);
  // Stack instance handle — we only call its exported scrollToPath.
  let stackRef = $state<{ scrollToPath: (path: string) => Promise<void> }>();

  let alive = true;
  function load() {
    const id = sessionId; // the session this request is for
    getDiff(id)
      .then((r) => {
        if (!alive || id !== sessionId) return; // dropped or session switched
        result = r;
        loaded = true;
        failed = false;
      })
      .catch(() => {
        if (!alive || id !== sessionId) return;
        failed = true;
        loaded = true;
      });
  }

  // fetch on session change + poll every 15s while this panel is mounted (tab active)
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    sessionId;
    result = null;
    loaded = false;
    failed = false;
    activePath = undefined;
    alive = true;
    load();
    const stop = pollWhileVisible(load, 15000); // skip hidden-tab ticks; refresh on return
    return () => {
      alive = false;
      stop();
    };
  });

  // Track viewport width so `diffView.narrow`/`.resolved` stay live (forces unified
  // on narrow). Construction only seeds the initial value; init() wires the listener.
  $effect(() => diffView.init());

  const totals = $derived(
    result ? diffTotals(result.files) : { files: 0, additions: 0, deletions: 0 },
  );

  // Highlight immediately (responsive), then scroll the target into view.
  async function handleSelect(path: string) {
    activePath = path;
    await stackRef?.scrollToPath(path);
  }
</script>

<div class="diff">
  <div class="bar">
    {#if result}
      <span class="summary">
        {totals.files} files <span class="add">+{totals.additions}</span>
        <span class="del">−{totals.deletions}</span>
      </span>
      {#if result.fetchFailed}
        <span class="stale" title={m.diff_stale({ base: result.base })}>⚠ {result.baseRef}</span>
      {/if}
    {/if}
    <div class="spacer"></div>
    {#if result && result.files.length && !diffView.narrow}
      <div class="seg-row" role="group" aria-label={m.diff_view_label()}>
        <button
          type="button"
          class="seg-btn"
          class:seg-active={diffView.pref === "split"}
          aria-pressed={diffView.pref === "split"}
          onclick={() => diffView.set("split")}
        >
          {m.diff_view_split()}
        </button>
        <button
          type="button"
          class="seg-btn"
          class:seg-active={diffView.pref === "unified"}
          aria-pressed={diffView.pref === "unified"}
          onclick={() => diffView.set("unified")}
        >
          {m.diff_view_unified()}
        </button>
      </div>
    {/if}
    <button class="refresh" type="button" onclick={load} aria-label={m.diff_refresh()}>↻</button>
  </div>

  {#if !loaded}
    <p class="msg">{m.common_loading()}</p>
  {:else if failed}
    <p class="msg">{m.diff_error()}</p>
  {:else if result && result.files.length}
    <div class="content">
      <DiffFileSidebar files={result.files} {activePath} onselect={handleSelect} />
      <DiffFileStack
        files={result.files}
        diffStyle={diffView.resolved}
        onvisible={(p) => (activePath = p)}
        bind:this={stackRef}
      />
    </div>
  {:else}
    <p class="msg">{m.diff_empty({ base: result?.baseRef ?? "" })}</p>
  {/if}
</div>

<style>
  .diff {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-head);
    font-size: var(--fs-meta);
    flex-shrink: 0;
  }
  .summary {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }
  .summary .add {
    color: var(--color-green);
  }
  .summary .del {
    color: var(--color-red);
  }
  .stale {
    color: var(--color-amber);
    font-size: var(--fs-meta);
  }
  .spacer {
    flex: 1;
  }

  /* Split/unified toggle — the segmented-control recipe (/design-system),
     compact for the bar. Active = --color-amber + inset. */
  .seg-row {
    display: flex;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .seg-btn {
    min-height: 24px;
    border: 0;
    border-right: 1px solid var(--color-line);
    background: none;
    font-family: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
    padding: 2px 10px;
    color: var(--color-muted);
    white-space: nowrap;
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
  /* Coarse pointers (touch): meet the 44px tap-target floor regardless of width —
     the toggle is hidden by viewport width (narrow), not by pointer type, so a wide
     touchscreen would otherwise render it at the compact desktop height. */
  @media (pointer: coarse) {
    .seg-btn {
      min-height: 44px;
      padding: 0 10px;
    }
  }

  .refresh {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-base);
    padding: 1px 8px;
    cursor: pointer;
  }
  .refresh:hover {
    background: var(--color-hover);
  }

  /* Two-pane body: sidebar rail + scrollable stack. The stack (not the page) owns
     scrolling — the content wrapper is height-constrained so the stack's own
     overflow + IntersectionObserver lazy render work. */
  .content {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  /* Sidebar root is <nav class="sidebar">; stack root is <div class="stack">.
     Both stretch to the content height (default align-items). */
  .content > :global(.sidebar) {
    flex: 0 0 220px;
  }
  .content > :global(.stack) {
    flex: 1;
    min-height: 0;
  }

  /* Narrow: stack the panes vertically — sidebar (its chip strip) above, stack
     below, full width. */
  @media (max-width: 768px) {
    .content {
      flex-direction: column;
    }
    .content > :global(.sidebar) {
      flex: 0 0 auto;
    }
  }

  .msg {
    color: var(--color-muted);
    margin: 0;
    padding: 8px 10px;
    font-size: var(--fs-base);
  }
</style>
