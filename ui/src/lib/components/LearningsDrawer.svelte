<script lang="ts">
  import { fly } from "svelte/transition";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import type { InjectableRule, Learning, RepoInjectable, MergeSuggestion } from "$lib/types";
  import { learnings } from "$lib/learnings.svelte";
  import {
    repoAnchorId,
    mergeRepoGroups,
    flaggedCount,
    totalFlagged,
    sortGroupsForTriage,
    isOverBudget,
    droppedCount,
    reposNeedingAttention,
  } from "./learnings-drawer";
  import type { LearningsCtx } from "./learnings-drawer/ctx";
  import TriageBand from "./learnings-drawer/TriageBand.svelte";
  import RecurrenceBand from "./learnings-drawer/RecurrenceBand.svelte";
  import RepoGroup from "./learnings-drawer/RepoGroup.svelte";

  // "What is this?" explainer at the top of the drawer. Default open so a first-time
  // user gets the plain-language explanation; collapsing is remembered (localStorage)
  // so it stays out of the way once read. SSR-safe: the stored flag is only read after
  // mount, matching the SteerBar coachmark pattern.
  const ABOUT_KEY = "shepherd:learnings-about-collapsed";
  let aboutOpen = $state(true);
  $effect(() => {
    try {
      if (localStorage.getItem(ABOUT_KEY) === "1") aboutOpen = false;
    } catch {
      // private mode / blocked storage: keep the explainer open rather than hide it
    }
  });
  function toggleAbout() {
    aboutOpen = !aboutOpen;
    try {
      localStorage.setItem(ABOUT_KEY, aboutOpen ? "0" : "1");
    } catch {
      // ignore: best-effort persistence
    }
  }

  let {
    items,
    injectable,
    mergeSuggestions = [],
    focusRepo = null,
    onapprove,
    ondismiss,
    ondistill,
    onpromote,
    onoptimize,
    onoptimizeall,
    onrestore,
    onreverttrial,
    onscope,
    onseenretired,
    onmerge,
    ondismissmerge,
    onpromoteglobal,
    onmergenow,
    onclose,
  }: {
    items: Learning[];
    injectable: RepoInjectable[];
    mergeSuggestions?: MergeSuggestion[];
    focusRepo?: string | null;
    onapprove: (id: string, rule: string) => void;
    ondismiss: (id: string) => void;
    ondistill: (repoPath: string) => void;
    onpromote: (id: string) => void;
    onoptimize: (id: string) => void;
    onoptimizeall: (repoPath: string) => void;
    onrestore: (id: string) => void;
    onreverttrial: (id: string, target: "proposed" | "dismissed") => void;
    onscope: (id: string, globs: string[]) => void;
    onseenretired: (repoPath: string) => void;
    onmerge: (suggestionId: string) => void;
    ondismissmerge: (suggestionId: string) => void;
    onpromoteglobal: (suggestionId: string) => void;
    onmergenow: (repoPath: string) => void;
    onclose: () => void;
  } = $props();

  // Phase 4 merge suggestions, split for rendering: cross-repo recurrence at the top
  // (repo-agnostic), intra-repo consolidation cards inside each repo's group.
  const crossSuggestions = $derived(mergeSuggestions.filter((s) => s.kind === "cross"));
  const intraFor = (repoPath: string): MergeSuggestion[] =>
    mergeSuggestions.filter((s) => s.kind === "intra" && s.repoPath === repoPath);

  // Glob-scope editing (#842): which injectable rule has its scope editor open, and the
  // comma-separated draft text. Saving splits on commas/whitespace into a glob array.
  let editingScope = $state<string | null>(null);
  let scopeDraft = $state("");
  function openScopeEditor(l: InjectableRule) {
    editingScope = l.id;
    scopeDraft = l.scopeGlobs.join(", ");
  }
  function saveScope(id: string) {
    const globs = scopeDraft
      .split(/[,\s]+/)
      .map((g) => g.trim())
      .filter(Boolean);
    onscope(id, globs);
    editingScope = null;
  }

  // Shared context bundle — built as $derived so children's reads of
  // editingScope/scopeDraft stay reactive (mirroring Herd.svelte:252 rowCtx pattern).
  const ctx = $derived<LearningsCtx>({
    onapprove,
    ondismiss,
    ondistill,
    onpromote,
    onoptimize,
    onoptimizeall,
    onrestore,
    onreverttrial,
    onseenretired,
    onmerge,
    ondismissmerge,
    onpromoteglobal,
    onmergenow,
    editingScope,
    scopeDraft,
    onScopeOpen: openScopeEditor,
    onScopeInput: (v: string) => (scopeDraft = v),
    onScopeSave: saveScope,
    onScopeCancel: () => (editingScope = null),
  });

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // Matches the drawer width so the fly-in starts fully off-screen.
  const slide = { x: 520, duration: reduceMotion ? 0 : 220, opacity: 1 };

  // Change 1: Use sortGroupsForTriage to order repos by triage priority.
  const groups = $derived(sortGroupsForTriage(mergeRepoGroups(items, injectable)));
  // Empty only when there's nothing to curate in either view.
  const empty = $derived(groups.length === 0);

  // Change 2: Two independent header filters — flaggedOnly + overBudgetOnly, union semantics.
  // "Not working" filter: show only repos/rules the distiller flagged. The toggle
  // only renders when something is flagged, and auto-resets so the view can't get
  // stuck on an empty filter once the last flagged rule is optimized/dismissed away.
  let flaggedOnly = $state(false);
  const totalFlaggedCount = $derived(totalFlagged(injectable));
  $effect(() => {
    if (totalFlaggedCount === 0) flaggedOnly = false;
  });

  let overBudgetOnly = $state(false);
  const totalOverBudget = $derived(injectable.reduce((n, r) => n + droppedCount(r), 0));
  $effect(() => {
    if (totalOverBudget === 0) overBudgetOnly = false;
  });

  const displayGroups = $derived(
    !flaggedOnly && !overBudgetOnly
      ? groups
      : groups.filter(
          (g) =>
            (flaggedOnly && flaggedCount(g.injectable) > 0) ||
            (overBudgetOnly && isOverBudget(g.injectable)),
        ),
  );

  // Change 3: Triage summary band — repos needing attention.
  const attention = $derived(reposNeedingAttention(groups));

  // Deep-link: when opened from a repo's status row, scroll that repo's section into
  // view. Runs once on mount (a frame later, so the fly-in has laid out the sections).
  $effect(() => {
    if (!focusRepo) return;
    const id = repoAnchorId(focusRepo);
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    });
  });

  // Triage chip handler: reset both lens filters so the target repo is guaranteed to
  // be in the DOM, then rAF-scroll to it (lens reset stays here; TriageBand emits onjump).
  function jumpToRepo(repoPath: string) {
    flaggedOnly = false;
    overBudgetOnly = false;
    requestAnimationFrame(() => {
      document.getElementById(repoAnchorId(repoPath))?.scrollIntoView({ block: "start" });
    });
  }
</script>

<div class="scrim" aria-hidden="true" onclick={() => onclose()}></div>

<div
  class="drawer"
  role="dialog"
  aria-modal="true"
  aria-label={m.learnings_title()}
  use:dialog={{ onclose }}
  transition:fly={slide}
>
  <header class="bar">
    <span class="title">{m.learnings_title()}</span>
    {#if totalFlaggedCount > 0}
      <!-- Change 2: stable-labeled press toggle (no label swap) -->
      <button
        class="filter-toggle"
        type="button"
        aria-pressed={flaggedOnly}
        onclick={() => (flaggedOnly = !flaggedOnly)}
      >
        {m.learnings_filter_flagged({ count: totalFlaggedCount })}
      </button>
    {/if}
    {#if totalOverBudget > 0}
      <!-- Change 2: over-budget toggle beside the not-working toggle -->
      <button
        class="filter-toggle"
        type="button"
        aria-pressed={overBudgetOnly}
        onclick={() => (overBudgetOnly = !overBudgetOnly)}
      >
        {m.learnings_filter_overbudget({ count: totalOverBudget })}
      </button>
    {/if}
    <button class="close" onclick={() => onclose()} aria-label={m.learnings_close_aria()}>✕</button>
  </header>

  {#if !learnings.health.ok}
    <div class="health-warn" role="status">
      <strong class="hw-title">{m.learnings_distiller_stalled_title()}</strong>
      <span class="hw-body"
        >{m.learnings_distiller_stalled_body({ count: learnings.health.consecutiveFailures })}</span
      >
    </div>
  {/if}

  {#if learnings.health.optimizer && !learnings.health.optimizer.ok}
    <div class="health-warn" role="status">
      <strong class="hw-title">{m.learnings_optimizer_stalled_title()}</strong>
      <span class="hw-body"
        >{m.learnings_optimizer_stalled_body({
          count: learnings.health.optimizer.consecutiveFailures,
        })}</span
      >
    </div>
  {/if}

  <section class="about">
    <button
      class="about-toggle"
      type="button"
      aria-expanded={aboutOpen}
      aria-controls="learnings-about"
      onclick={toggleAbout}
    >
      <span class="caret" class:open={aboutOpen} aria-hidden="true">▸</span>
      {m.learnings_about_toggle()}
    </button>
    <!-- kept mounted (toggled via hidden) so the toggle's aria-controls reference
         stays valid even when collapsed -->
    <div class="about-body" id="learnings-about" hidden={!aboutOpen}>
      <p>{m.learnings_about_lead()} <strong>{m.learnings_about_scope()}</strong></p>
      <p>{m.learnings_about_flow()}</p>
      <!-- Change 8: Budget explainer line -->
      <p>{m.learnings_about_budget()}</p>
    </div>
  </section>

  <!-- Change 3: Triage summary band — stable above group list, reflects ALL attention repos -->
  <TriageBand {attention} onjump={jumpToRepo} />

  <!-- Phase 4: cross-repo recurrence band — rules that recur across repos, suggested for the
       user-global CLAUDE.md. Promote (guarded, two-step) writes the rule there; or dismiss. -->
  <RecurrenceBand suggestions={crossSuggestions} {onpromoteglobal} {ondismissmerge} />

  {#if empty}
    <p class="empty">{m.learnings_empty()}</p>
  {:else}
    {#each displayGroups as group (group.repoPath)}
      <RepoGroup {group} {flaggedOnly} {overBudgetOnly} intra={intraFor(group.repoPath)} {ctx} />
    {/each}
  {/if}
</div>

<style>
  /* backdrop sits just below the panel; .scrim (app.css) supplies dim + blur */
  .scrim {
    z-index: 49;
  }
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    width: min(520px, 100vw);
    height: 100dvh;
    background: var(--color-panel);
    border-left: 1px solid var(--color-line-bright);
    display: flex;
    flex-direction: column;
    gap: 10px;
    /* No top padding: the sticky group header (.ghead) pins at top:0, so the
       scroll-container's own top padding would leave a band above it through
       which scrolling content bleeds. Top spacing is restored on .bar below. */
    padding: 0 14px 14px;
    overflow-y: auto;
    z-index: 50;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    /* restores the drawer's top breathing room (.bar is always the first child) */
    padding-top: 14px;
  }
  .title {
    letter-spacing: 0.14em;
    font-size: var(--fs-base);
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .close {
    background: none;
    border: none;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-lg);
  }
  /* Header filters — token-outlined like .distill; pressed state
     reads as the active (amber) lens. Both toggles share the same class. */
  .filter-toggle {
    margin-left: auto;
    font-size: var(--fs-meta);
    background: none;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 3px 8px;
    cursor: pointer;
  }
  .filter-toggle:hover {
    color: var(--color-ink-bright);
  }
  .filter-toggle[aria-pressed="true"] {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* distiller-stalled persistent warning banner */
  .health-warn {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    border: 1px solid var(--color-amber);
    background: color-mix(in srgb, var(--color-amber) 12%, var(--color-head));
    font-size: var(--fs-base);
  }
  .hw-title {
    color: var(--color-amber);
    font-weight: 600;
  }
  .hw-body {
    color: var(--color-ink-bright);
    line-height: 1.45;
  }
  /* "What is this?" explainer — collapsible, default open, state remembered. */
  .about {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .about-toggle {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .about-toggle:hover {
    color: var(--color-ink-bright);
  }
  .about-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-left: 1px solid var(--color-line);
    padding: 2px 0 2px 10px;
  }
  /* explicit display:flex would otherwise defeat the hidden attribute */
  .about-body[hidden] {
    display: none;
  }
  .about-body p {
    font-size: var(--fs-base);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .about-body strong {
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .empty {
    color: var(--color-muted);
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .caret {
    display: inline-block;
    transition: transform 0.12s ease;
  }
  .caret.open {
    transform: rotate(90deg);
  }
</style>
