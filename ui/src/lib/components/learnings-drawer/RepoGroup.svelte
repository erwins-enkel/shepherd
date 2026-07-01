<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { MergeSuggestion } from "$lib/types";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import {
    basename,
    repoAnchorId,
    unseenRetiredCount,
    isOverBudget,
    droppedCount,
    injectedCount,
    flaggedCount,
    visibleInjectableRules,
    splitDropped,
    retiredRules,
    retiredCount,
  } from "../learnings-drawer";
  import type { RepoGroup as RepoGroupData } from "../learnings-drawer";
  import type { LearningsCtx } from "./ctx";
  import InjectableRuleCard from "./InjectableRuleCard.svelte";
  import ProposedRuleCard from "./ProposedRuleCard.svelte";
  import MergeSuggestCard from "./MergeSuggestCard.svelte";
  import RetiredRuleCard from "./RetiredRuleCard.svelte";

  let {
    group,
    flaggedOnly,
    overBudgetOnly,
    intra,
    ctx,
  }: {
    group: RepoGroupData;
    flaggedOnly: boolean;
    overBudgetOnly: boolean;
    intra: MergeSuggestion[];
    ctx: LearningsCtx;
  } = $props();

  const repoIcon = $derived(projectIcons.iconFor(group.repoPath));
</script>

<!-- Change 4: group container with left-accent border + faint surface -->
<section class="group" id={repoAnchorId(group.repoPath)}>
  <!-- Change 4: sticky repo header -->
  <div class="ghead">
    <!-- Repo identity glyph + name, mirroring the session-card label
         (UnitRow): the configured project emoji when set, else the ▣
         marker — makes it clear at a glance which repo a card concerns. -->
    <span class="repo">
      <span class="repo-glyph" class:emoji={!!repoIcon} aria-hidden="true">{repoIcon ?? "▣"}</span
      >{basename(group.repoPath)}
    </span>
    <div class="actions">
      <button
        class="distill"
        onclick={() => ctx.onmergenow(group.repoPath)}
        aria-label={m.learnings_merge_now_aria({ repo: basename(group.repoPath) })}
      >
        {m.learnings_merge_now()}
      </button>
      <button
        class="distill"
        onclick={() => ctx.ondistill(group.repoPath)}
        aria-label={m.learnings_distill_aria({ repo: basename(group.repoPath) })}
      >
        {m.learnings_distill()}
      </button>
    </div>
  </div>

  {#if unseenRetiredCount(group.injectable) > 0}
    <div class="health-warn" role="status">
      <strong class="hw-title"
        >{m.learnings_auto_retired_banner({
          count: unseenRetiredCount(group.injectable),
        })}</strong
      >
      <button class="hw-review" type="button" onclick={() => ctx.onseenretired(group.repoPath)}>
        {m.learnings_auto_retired_review()}
      </button>
    </div>
  {/if}

  <!-- Change 7: hide proposals under either active lens -->
  {#each flaggedOnly || overBudgetOnly ? [] : group.proposed as l (l.id)}
    <ProposedRuleCard learning={l} {ctx} />
  {/each}

  <!-- Phase 4: intra-repo merge-group suggestions (hidden under the active lenses,
       same as proposals). One-click consolidation; survivor counters preserved. -->
  {#if !(flaggedOnly || overBudgetOnly) && intra.length > 0}
    <div class="merge-suggest">
      <span class="ms-title">{m.learnings_merge_heading()}</span>
      {#each intra as s (s.id)}
        <MergeSuggestCard suggestion={s} {ctx} />
      {/each}
    </div>
  {/if}

  {#if group.injectable && group.injectable.rules.length > 0}
    {@const inj = group.injectable}
    {@const lensActive = flaggedOnly || overBudgetOnly}
    <div class="injected">
      <div class="ihead">
        <span class="ititle">{m.learnings_injected_section()}</span>
        <!-- Change 5: conditional meter — dominant amber when over budget -->
        {#if isOverBudget(inj)}
          <span class="meter over">{m.learnings_budget_over({ dropped: droppedCount(inj) })}</span>
        {:else}
          <span class="meter">
            {m.learnings_budget_meter({
              injected: injectedCount(inj),
              total: inj.rules.length,
              used: inj.usedChars,
              budget: inj.budgetChars,
            })}
          </span>
        {/if}
        {#if flaggedCount(group.injectable) > 0}
          <button
            class="optimize-all"
            type="button"
            onclick={() => ctx.onoptimizeall(group.repoPath)}
          >
            {m.learnings_optimize_all({ count: flaggedCount(group.injectable) })}
          </button>
        {/if}
      </div>
      <!-- Change 6: dropped-first rendering via component + splitDropped -->
      {#if lensActive}
        {#each visibleInjectableRules(inj, { flaggedOnly, overBudgetOnly }) as r (r.id)}
          <InjectableRuleCard rule={r} enabled={inj.enabled} {ctx} />
        {/each}
      {:else}
        {@const split = splitDropped(inj)}
        {#if split.dropped.length > 0}
          <p class="not-injected-label">{m.learnings_not_injected_label()}</p>
          {#each split.dropped as r (r.id)}<InjectableRuleCard
              rule={r}
              enabled={inj.enabled}
              {ctx}
            />{/each}
        {/if}
        {#each split.injected as r (r.id)}<InjectableRuleCard
            rule={r}
            enabled={inj.enabled}
            {ctx}
          />{/each}
      {/if}
    </div>
  {/if}

  {#if retiredCount(group.injectable) > 0}
    <div class="retired-section">
      <div class="retired-head">
        <span class="retired-title"
          >{m.learnings_retired_heading({ count: retiredCount(group.injectable) })}</span
        >
      </div>
      {#each retiredRules(group.injectable) as r (r.id)}
        <RetiredRuleCard rule={r} {ctx} />
      {/each}
    </div>
  {/if}
</section>

<style>
  /* Change 4: group container with left-accent border + faint surface */
  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-left: 2px solid var(--color-line-bright);
    background: var(--color-head);
    /* no top padding: the header (.ghead, always the first child) owns the
       group's top spacing via its own padding-top, so the resting header gap
       matches the pinned one instead of stacking on a group pad */
    padding: 0 8px 6px;
  }
  /* Change 4: sticky repo header — opaque background so scrolled content doesn't bleed */
  .ghead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--color-line);
    /* single source of the header's top space (group drops its top padding): an
       opaque buffer so scrolling content disappears cleanly under the pinned
       header's upper edge, identical at rest and when pinned at top:0 */
    padding-top: 8px;
    padding-bottom: 4px;
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--color-head);
  }
  .repo {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  /* Repo marker before the name — muted ▣ matches the session-card glyph; a
     configured project emoji renders at its own (slightly larger) size. */
  .repo-glyph {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    flex-shrink: 0;
  }
  .repo-glyph.emoji {
    font-size: var(--fs-base);
  }
  /* action buttons + their info affordance grouped to the header's right edge,
     so the "i" hugs the buttons instead of being flung out by space-between */
  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .distill {
    font-size: var(--fs-meta);
    background: none;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 3px 8px;
    cursor: pointer;
  }
  /* distiller-stalled persistent warning banner (auto-retired variant) */
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
  .hw-review {
    align-self: flex-start;
    font-size: var(--fs-meta);
    background: none;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    padding: 3px 8px;
    cursor: pointer;
    margin-top: 4px;
  }
  /* ── injected house rules ────────────────────────────────────────────── */
  .injected {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 2px;
  }
  .ihead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .ititle {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-muted);
  }
  .meter {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  /* Change 5: over-budget meter variant — dominant amber headline */
  .meter.over {
    color: var(--color-amber);
    font-weight: 600;
  }
  /* Per-repo "Optimize all flagged" — token-outlined small action, mirrors .optimize (amber, not green). */
  .optimize-all {
    margin-left: auto;
    font-size: var(--fs-meta);
    background: none;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    padding: 3px 8px;
    cursor: pointer;
  }
  /* Change 6: "Not injected — over budget" sub-label */
  .not-injected-label {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-amber);
    margin: 4px 0 2px;
  }
  .retired-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 2px;
    border-top: 1px solid var(--color-line);
    padding-top: 6px;
  }
  .retired-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .retired-title {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-muted);
  }
  /* Phase 4: intra-repo merge-group suggestion cards */
  .merge-suggest {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 2px;
  }
  .ms-title {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-muted);
  }
</style>
