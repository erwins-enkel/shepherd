<script lang="ts">
  import { getDiff, getDiffAnnotations } from "$lib/api";
  import { pollWhileVisible } from "$lib/visibility";
  import { diffTotals } from "$lib/diff";
  import { diffView } from "$lib/diff-view.svelte";
  import { fileSignature } from "$lib/pierre-diff";
  import { SvelteMap } from "svelte/reactivity";
  import type { DiffResult, DiffAgentAnnotation } from "$lib/types";
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

  // Per-line annotations (#1699), fetched SEPARATELY from the diff (see loadAnnotations) so the
  // heavier transcript-parse/anchoring can never block or break the diff. Agent notes → per-file
  // Pierre annotations; review findings → per-file banner (path) or panel banner (path "").
  // Stable SvelteMaps (already reactive → no $state wrap); mutated in place, never reassigned.
  const agentByPath = new SvelteMap<string, DiffAgentAnnotation[]>();
  const reviewByPath = new SvelteMap<string, string[]>();
  let generalFindings = $state<string[]>([]);

  let alive = true;
  // Content signature of the currently-shown diff (join of per-file signatures). When it changes
  // across a poll the agent-anchored line numbers have shifted, so the persisted line annotations
  // would mis-anchor — we clear them and re-fetch (see load()).
  let lastDiffSig: string | undefined;

  // Diff fetch — the 15s poll (forceAnnotations=false) and initial/manual load (true) all call this.
  // When the diff CONTENT changes, agent notes anchored to the old line numbers are dropped
  // immediately (prevent mis-anchoring) and re-fetched. `forceAnnotations` additionally re-fetches
  // on an unchanged diff (manual refresh) so new critic findings surface without a content change.
  function load(forceAnnotations = false) {
    const id = sessionId; // the session this request is for
    getDiff(id)
      .then((r) => {
        if (!alive || id !== sessionId) return; // dropped or session switched
        result = r;
        loaded = true;
        failed = false;
        const sig = r.files.map(fileSignature).join(",");
        if (sig !== lastDiffSig) {
          lastDiffSig = sig;
          agentByPath.clear(); // line numbers shifted → old anchors are stale; drop before re-fetch
          loadAnnotations();
        } else if (forceAnnotations) {
          loadAnnotations();
        }
      })
      .catch(() => {
        if (!alive || id !== sessionId) return;
        failed = true;
        loaded = true;
      });
  }

  // Annotations fetch — separate from the poll (best-effort chrome). Called on initial load and on
  // manual refresh ONLY, never by the 15s poll. Failure degrades to no annotations (diff unaffected).
  function loadAnnotations() {
    const id = sessionId;
    getDiffAnnotations(id)
      .then(({ notes }) => {
        if (!alive || id !== sessionId) return;
        // Repopulate the stable reactive maps in place (clear + set) — never reassign the ref.
        agentByPath.clear();
        reviewByPath.clear();
        const general: string[] = [];
        for (const n of notes) {
          if (n.kind === "agent" && n.lineNumber != null && n.side) {
            (agentByPath.get(n.path) ?? agentByPath.set(n.path, []).get(n.path)!).push({
              side: n.side,
              lineNumber: n.lineNumber,
              metadata: { text: n.text, tool: n.tool ?? "" },
            });
          } else if (n.kind === "review") {
            if (n.path === "") general.push(n.text);
            else
              (reviewByPath.get(n.path) ?? reviewByPath.set(n.path, []).get(n.path)!).push(n.text);
          }
        }
        generalFindings = general;
      })
      .catch(() => {
        if (!alive || id !== sessionId) return; // keep the diff; just no annotations
      });
  }

  // Diff + annotations (initial load and manual refresh). `load(true)` re-fetches annotations even
  // when the diff content is unchanged, so the button also refreshes critic findings.
  function refresh() {
    load(true);
  }

  // fetch on session change + poll every 15s while this panel is mounted (tab active)
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    sessionId;
    result = null;
    loaded = false;
    failed = false;
    activePath = undefined;
    agentByPath.clear();
    reviewByPath.clear();
    generalFindings = [];
    lastDiffSig = undefined;
    alive = true;
    refresh();
    // Poll the diff only; load() re-fetches annotations itself when the diff content changes.
    const stop = pollWhileVisible(() => load(), 15000);
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
    <button class="refresh" type="button" onclick={refresh} aria-label={m.diff_refresh()}>↻</button>
  </div>

  {#if !loaded}
    <p class="msg">{m.common_loading()}</p>
  {:else if failed}
    <p class="msg">{m.diff_error()}</p>
  {:else if result && result.files.length}
    {#if generalFindings.length}
      <!-- Panel-level review banner (#1699): non-file-specific critic findings (e.g. the headline
           "does not satisfy the task" verdict) that can't attach to a file. Text is verbatim data
           rendered via {text} interpolation (auto-escaped) — never {@html}. -->
      <div class="review-banner review-banner-panel" role="note">
        <span class="review-chip">{m.viewport_diff_annotation_review()}</span>
        <ul class="review-list">
          {#each generalFindings as finding, i (i)}
            <li>{finding}</li>
          {/each}
        </ul>
      </div>
    {/if}
    <div class="content">
      <DiffFileSidebar files={result.files} {activePath} onselect={handleSelect} />
      <DiffFileStack
        files={result.files}
        diffStyle={diffView.resolved}
        agentAnnotations={agentByPath}
        reviewFindings={reviewByPath}
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
  /* Proportional cap, no px floor: the panel lives in the desktop grid's 1fr
     region (min ~469px at a 769px viewport, where the 768px chip-strip breakpoint
     hasn't engaged), so a fixed floor would eat >1/3 there. 30% keeps the diff
     stack at ≥70% (> 2/3); capped so wide panels don't waste rail width. */
  .content > :global(.sidebar) {
    flex: 0 0 min(30%, 320px);
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

  /* Review banner (#1699) — critic findings. Amber (attention) accent per the semantic-hue rule.
     The panel variant sits above the file stack for non-file-specific findings. */
  .review-banner {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 6px 10px;
    background: var(--color-inset);
    border-bottom: 1px solid var(--color-line);
    border-left: 2px solid var(--color-amber);
    font-size: var(--fs-meta);
    color: var(--color-ink);
    flex-shrink: 0;
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
</style>
