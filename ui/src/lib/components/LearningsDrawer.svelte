<script lang="ts">
  import { fly } from "svelte/transition";
  import type { Action } from "svelte/action";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import type {
    InjectableRule,
    Learning,
    RepoInjectable,
    MergeSuggestion,
    SignalKind,
  } from "$lib/types";
  import { learnings } from "$lib/learnings.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import {
    basename,
    repoAnchorId,
    mergeRepoGroups,
    injectionBadge,
    injectedCount,
    showIneffective,
    flaggedCount,
    totalFlagged,
    evidenceSources,
    sortGroupsForTriage,
    isOverBudget,
    droppedCount,
    splitDropped,
    reposNeedingAttention,
    visibleInjectableRules,
    retiredRules,
    retiredCount,
    unseenRetiredCount,
    helpRate,
  } from "./learnings-drawer";

  // Human label for an evidence source kind. Mirrors the server SignalKind set;
  // keeps the i18n call in the component (the helper stays locale-agnostic).
  const kindLabel = (k: SignalKind): string =>
    k === "reply"
      ? m.learnings_kind_reply()
      : k === "critic"
        ? m.learnings_kind_critic()
        : k === "block"
          ? m.learnings_kind_block()
          : m.learnings_kind_stall();

  // Grow a rule textarea to fit its content so the full rule is always readable —
  // no inner scroll, no clipping. Re-measures on every input and, via `update`,
  // whenever the bound value changes programmatically (e.g. a poll refresh
  // replacing the rule text while no local draft exists).
  const autosize: Action<HTMLTextAreaElement, string> = (el) => {
    let raf = 0;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    // scrollHeight is unreliable mid fly-in / before the new value is flushed
    // to the DOM; settle one frame later.
    const fitNextFrame = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    };
    fit();
    fitNextFrame();
    el.addEventListener("input", fit);
    return {
      update: fitNextFrame,
      destroy() {
        cancelAnimationFrame(raf);
        el.removeEventListener("input", fit);
      },
    };
  };

  // Which rules have their evidence-source list expanded, keyed by learning id.
  let expanded = $state<Record<string, boolean>>({});

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

  // Cross-repo card pending the inline two-step confirm before a global CLAUDE.md write (#872).
  let confirmingGlobalId = $state<string | null>(null);

  let drafts = $state<Record<string, string>>({});
  const draft = (l: Learning) => drafts[l.id] ?? l.rule;

  // Glob-scope editing (#842): which injectable rule has its scope editor open, and the
  // comma-separated draft text. Saving splits on commas/whitespace into a glob array.
  let editingScope = $state<string | null>(null);
  let scopeDraft = $state("");
  function openScopeEditor(l: Learning & { scopeGlobs: string[] }) {
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
  {#if attention.length > 0}
    <section class="triage" aria-label={m.learnings_triage_heading()}>
      <span class="triage-label">{m.learnings_triage_heading()}</span>
      <div class="triage-chips">
        {#each attention as a (a.repoPath)}
          <button
            class="triage-chip"
            type="button"
            aria-label={m.learnings_triage_jump_aria({ repo: basename(a.repoPath) })}
            onclick={() => {
              // Clear both lens filters so the target repo is guaranteed to be in the DOM,
              // then scroll on the next frame after Svelte has updated displayGroups.
              flaggedOnly = false;
              overBudgetOnly = false;
              requestAnimationFrame(() => {
                document
                  .getElementById(repoAnchorId(a.repoPath))
                  ?.scrollIntoView({ block: "start" });
              });
            }}
          >
            <span class="tc-repo">{basename(a.repoPath)}</span>
            {#if a.droppedCount > 0}<span class="tc-over"
                >{m.learnings_triage_over({ count: a.droppedCount })}</span
              >{/if}
            {#if a.flaggedCount > 0}<span class="tc-flagged"
                >{m.learnings_triage_flagged({ count: a.flaggedCount })}</span
              >{/if}
          </button>
        {/each}
      </div>
    </section>
  {/if}

  <!-- Phase 4: cross-repo recurrence band — rules that recur across repos, suggested for the
       user-global CLAUDE.md. Promote (guarded, two-step) writes the rule there; or dismiss. -->
  {#if crossSuggestions.length > 0}
    <section class="recur" aria-label={m.learnings_recur_heading()}>
      <span class="recur-title">{m.learnings_recur_heading()}</span>
      <p class="recur-lead">{m.learnings_recur_lead()}</p>
      {#each crossSuggestions as s (s.id)}
        <article class="recur-card">
          <p class="recur-rule">{s.mergedRule}</p>
          <p class="recur-repos">
            {m.learnings_recur_repos({
              count: s.repoPaths?.length ?? 0,
              repos: (s.repoPaths ?? []).map(basename).join(", "),
            })}
          </p>
          {#if confirmingGlobalId === s.id}
            <p class="recur-confirm">{m.learnings_recur_promote_confirm()}</p>
            <div class="recur-foot">
              <button class="ms-dismiss" type="button" onclick={() => (confirmingGlobalId = null)}>
                {m.common_cancel()}
              </button>
              <button
                class="ms-apply"
                type="button"
                onclick={() => {
                  onpromoteglobal(s.id);
                  confirmingGlobalId = null;
                }}
              >
                {m.learnings_recur_promote_action()}
              </button>
            </div>
          {:else}
            <div class="recur-foot">
              <button
                class="ms-dismiss"
                type="button"
                onclick={() => ondismissmerge(s.id)}
                aria-label={m.learnings_recur_dismiss_aria()}
              >
                {m.learnings_dismiss()}
              </button>
              <button
                class="ms-apply"
                type="button"
                onclick={() => (confirmingGlobalId = s.id)}
                aria-label={m.learnings_recur_promote_aria()}
              >
                {m.learnings_recur_promote()}
              </button>
            </div>
          {/if}
        </article>
      {/each}
    </section>
  {/if}

  <!-- Change 6: Injectable-rule snippet — single source, no copy-paste.
       Accepts the repo's enabled flag so the badge reflects injection state correctly. -->
  {#snippet irule(r: InjectableRule, enabled: boolean)}
    {@const badge = injectionBadge(r, enabled)}
    <article class="irule">
      <p class="itext">{r.rule}</p>
      <div class="ifoot">
        <span class="chip" class:promoted={r.status === "promoted"}>
          {r.status === "promoted" ? m.learnings_status_promoted() : m.learnings_status_active()}
        </span>
        {#if badge === "injected"}
          <span class="badge ok">✓ {m.learnings_injected_badge()}</span>
        {:else if badge === "scoped"}
          <span class="badge scoped" title={m.learnings_scoped_title()}>
            ◎ {m.learnings_scoped_badge()}
          </span>
        {:else if badge === "over-budget"}
          <span class="badge warn" title={m.learnings_overbudget_title()}>
            ⊘ {m.learnings_overbudget_badge()}
          </span>
        {:else}
          <span class="badge off">⊘ {m.learnings_injection_disabled_badge()}</span>
        {/if}
        {#if showIneffective(r)}
          <span class="badge bad" title={m.learnings_ineffective_title()}>
            ⚠ {m.learnings_ineffective_badge({ count: r.ineffectiveCount })}
          </span>
        {/if}
        {#if helpRate(r) !== null}
          {@const hr = helpRate(r)!}
          <span class="help-rate"
            >{m.learnings_help_rate({ helped: hr.helped, pulls: hr.pulls })}</span
          >
        {/if}
        <span class="spacer"></span>
        <div class="iactions">
          {#if showIneffective(r)}
            <button
              class="optimize"
              type="button"
              onclick={() => onoptimize(r.id)}
              aria-label={m.learnings_optimize_aria()}
            >
              {m.learnings_optimize()}
            </button>
          {/if}
          {#if r.status === "active"}
            <!-- Change 9: de-emphasised Dismiss with margin-left gap from Promote -->
            <button class="dismiss dismiss-muted" onclick={() => ondismiss(r.id)}>
              {m.learnings_dismiss()}
            </button>
            <button
              class="promote"
              onclick={() => onpromote(r.id)}
              aria-label={m.learnings_promote_aria()}
            >
              {m.learnings_promote()}
            </button>
          {:else if r.status === "promoted" && r.promotedPrUrl}
            <a class="prlink" href={r.promotedPrUrl} target="_blank" rel="noopener external">
              {m.learnings_promoted_pr()}
            </a>
          {/if}
        </div>
      </div>
      <!-- #842: glob scope — which files this rule applies to (empty = always). -->
      <div class="iscope">
        {#if editingScope === r.id}
          <input
            class="scope-input"
            type="text"
            bind:value={scopeDraft}
            placeholder={m.learnings_scope_placeholder()}
            aria-label={m.learnings_scope_input_aria()}
          />
          <button class="scope-save" type="button" onclick={() => saveScope(r.id)}>
            {m.common_save()}
          </button>
          <button class="scope-cancel" type="button" onclick={() => (editingScope = null)}>
            {m.common_cancel()}
          </button>
        {:else}
          <span class="scope-label">{m.learnings_scope_label()}</span>
          {#if r.scopeGlobs.length > 0}
            {#each r.scopeGlobs as g (g)}<code class="scope-glob">{g}</code>{/each}
          {:else}
            <span class="scope-always">{m.learnings_scope_always()}</span>
          {/if}
          <button class="scope-edit" type="button" onclick={() => openScopeEditor(r)}>
            {m.learnings_scope_edit()}
          </button>
        {/if}
      </div>
    </article>
  {/snippet}

  {#if empty}
    <p class="empty">{m.learnings_empty()}</p>
  {:else}
    {#each displayGroups as group (group.repoPath)}
      <!-- Change 4: group container with left-accent border + faint surface -->
      {@const repoIcon = projectIcons.iconFor(group.repoPath)}
      <section class="group" id={repoAnchorId(group.repoPath)}>
        <!-- Change 4: sticky repo header -->
        <div class="ghead">
          <!-- Repo identity glyph + name, mirroring the session-card label
               (UnitRow): the configured project emoji when set, else the ▣
               marker — makes it clear at a glance which repo a card concerns. -->
          <span class="repo">
            <span class="repo-glyph" class:emoji={!!repoIcon} aria-hidden="true"
              >{repoIcon ?? "▣"}</span
            >{basename(group.repoPath)}
          </span>
          <button
            class="distill"
            onclick={() => onmergenow(group.repoPath)}
            aria-label={m.learnings_merge_now_aria({ repo: basename(group.repoPath) })}
          >
            {m.learnings_merge_now()}
          </button>
          <button
            class="distill"
            onclick={() => ondistill(group.repoPath)}
            aria-label={m.learnings_distill_aria({ repo: basename(group.repoPath) })}
          >
            {m.learnings_distill()}
          </button>
        </div>

        {#if unseenRetiredCount(group.injectable) > 0}
          <div class="health-warn" role="status">
            <strong class="hw-title"
              >{m.learnings_auto_retired_banner({
                count: unseenRetiredCount(group.injectable),
              })}</strong
            >
            <button class="hw-review" type="button" onclick={() => onseenretired(group.repoPath)}>
              {m.learnings_auto_retired_review()}
            </button>
          </div>
        {/if}

        <!-- Change 7: hide proposals under either active lens -->
        {#each flaggedOnly || overBudgetOnly ? [] : group.proposed as l (l.id)}
          <article class="rule">
            <textarea
              class="text"
              rows="2"
              data-1p-ignore
              use:autosize={draft(l)}
              value={draft(l)}
              oninput={(e) => (drafts = { ...drafts, [l.id]: e.currentTarget.value })}
              aria-label={m.learnings_rule_aria()}></textarea>
            {#if l.rationale}
              <p class="why"><span>{m.learnings_rationale_label()}:</span> {l.rationale}</p>
            {/if}
            <div class="evidence" title={m.learnings_evidence_help()}>
              <span class="evi">{m.learnings_evidence({ count: l.evidenceCount })}</span>
              {#each evidenceSources(l) as src (src.kind)}
                <span class="src">{src.count}× {kindLabel(src.kind)}</span>
              {/each}
              <!-- render whenever the payload carries provenance (even an empty,
                   fully-pruned list): the toggle is the focusable route to the
                   help text for keyboard/touch users -->
              {#if l.evidenceDetail}
                <button
                  class="sources-toggle"
                  type="button"
                  title={m.learnings_evidence_help()}
                  aria-expanded={!!expanded[l.id]}
                  aria-controls="sources-{l.id}"
                  aria-label={m.learnings_sources_toggle_aria()}
                  onclick={() => (expanded = { ...expanded, [l.id]: !expanded[l.id] })}
                >
                  {m.learnings_sources_toggle()}
                  <span class="caret" class:open={expanded[l.id]} aria-hidden="true">▸</span>
                </button>
              {/if}
            </div>
            {#if expanded[l.id] && l.evidenceDetail}
              <!-- disclosed region the toggle's aria-controls points at; carries a
                   visible copy of the provenance explanation, reachable for
                   keyboard/touch users who can't hover the title tooltip -->
              <div class="sources-region" id="sources-{l.id}">
                <p class="shelp">{m.learnings_evidence_help()}</p>
                {#if l.evidenceDetail.length > 0}
                  <ul class="sources">
                    {#each l.evidenceDetail as ev (ev.id)}
                      <li class="source">
                        <span class="src">{kindLabel(ev.kind)}</span>
                        <span class="desig">{ev.desig ?? m.learnings_source_unknown()}</span>
                        <span class="excerpt">{ev.excerpt}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
            <div class="foot">
              <span class="spacer"></span>
              <button class="dismiss" onclick={() => ondismiss(l.id)}
                >{m.learnings_dismiss()}</button
              >
              <button class="approve" onclick={() => onapprove(l.id, draft(l))}>
                {m.learnings_approve()}
              </button>
            </div>
          </article>
        {/each}

        <!-- Phase 4: intra-repo merge-group suggestions (hidden under the active lenses,
             same as proposals). One-click consolidation; survivor counters preserved. -->
        {#if !(flaggedOnly || overBudgetOnly) && intraFor(group.repoPath).length > 0}
          <div class="merge-suggest">
            <span class="ms-title">{m.learnings_merge_heading()}</span>
            {#each intraFor(group.repoPath) as s (s.id)}
              <article class="ms-card">
                <ul class="ms-members">
                  {#each s.members ?? [] as mem (mem.id)}
                    <li class="ms-member">{mem.rule}</li>
                  {/each}
                </ul>
                <p class="ms-result">
                  <span class="ms-result-label">{m.learnings_merge_result_label()}</span>
                  {s.mergedRule}
                </p>
                <div class="ms-foot">
                  <button class="ms-dismiss" type="button" onclick={() => ondismissmerge(s.id)}>
                    {m.learnings_dismiss()}
                  </button>
                  <button class="ms-apply" type="button" onclick={() => onmerge(s.id)}>
                    {m.learnings_merge_apply()}
                  </button>
                </div>
              </article>
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
                <span class="meter over"
                  >{m.learnings_budget_over({ dropped: droppedCount(inj) })}</span
                >
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
                  onclick={() => onoptimizeall(group.repoPath)}
                >
                  {m.learnings_optimize_all({ count: flaggedCount(group.injectable) })}
                </button>
              {/if}
            </div>
            <!-- Change 6: dropped-first rendering via snippet + splitDropped -->
            {#if lensActive}
              {#each visibleInjectableRules(inj, { flaggedOnly, overBudgetOnly }) as r (r.id)}
                {@render irule(r, inj.enabled)}
              {/each}
            {:else}
              {@const split = splitDropped(inj)}
              {#if split.dropped.length > 0}
                <p class="not-injected-label">{m.learnings_not_injected_label()}</p>
                {#each split.dropped as r (r.id)}{@render irule(r, inj.enabled)}{/each}
              {/if}
              {#each split.injected as r (r.id)}{@render irule(r, inj.enabled)}{/each}
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
              <article class="retired-rule">
                <p class="retired-text">{r.rule}</p>
                <p class="retired-reason">
                  {m.learnings_retired_reason({
                    helped: r.helpfulCount,
                    pulls: r.injectedCount,
                    flagged: r.ineffectiveCount,
                  })}
                </p>
                <div class="retired-foot">
                  <span class="spacer"></span>
                  <button
                    class="restore"
                    type="button"
                    aria-label={m.learnings_restore_aria()}
                    onclick={() => onrestore(r.id)}
                  >
                    {m.learnings_restore()}
                  </button>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </section>
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
  /* Change 3: Triage summary band */
  .triage {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    background: var(--color-head);
  }
  .triage-label {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-muted);
  }
  .triage-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .triage-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: 1px solid var(--color-line-bright);
    padding: 3px 8px;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
  }
  .triage-chip:hover {
    border-color: var(--color-ink-bright);
  }
  .tc-repo {
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .tc-over,
  .tc-flagged {
    color: var(--color-amber);
    font-size: var(--fs-meta);
  }
  .empty {
    color: var(--color-muted);
    font-size: var(--fs-base);
    line-height: 1.5;
  }
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
  .distill {
    font-size: var(--fs-meta);
    background: none;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 3px 8px;
    cursor: pointer;
  }
  .rule {
    border: 1px solid var(--color-line);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .text {
    width: 100%;
    /* height is driven by the autosize action so the full rule always shows */
    resize: none;
    overflow: hidden;
    background: var(--color-inset);
    color: var(--color-ink-bright);
    border: 1px solid var(--color-line);
    padding: 8px 10px;
    font: inherit;
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .why {
    font-size: var(--fs-base);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .why span {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--fs-micro);
  }
  /* Evidence provenance — its own row so the source breakdown has room to wrap.
     Hover the row for the help tooltip explaining what a signal is. */
  .evidence {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 6px;
    cursor: help;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .evi {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .src {
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    padding: 1px 6px;
    white-space: nowrap;
  }
  .sources-toggle {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .sources-toggle:hover {
    color: var(--color-ink-bright);
  }
  .caret {
    display: inline-block;
    transition: transform 0.12s ease;
  }
  .caret.open {
    transform: rotate(90deg);
  }
  /* Evidence provenance: the actual signals this rule was distilled from. */
  .sources-region {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .shelp {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .sources {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .source {
    display: grid;
    grid-template-columns: auto auto 1fr;
    align-items: baseline;
    gap: 6px;
    font-size: var(--fs-base);
    line-height: 1.4;
  }
  .desig {
    color: var(--color-ink-bright);
    font-weight: 600;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .excerpt {
    color: var(--color-muted);
    min-width: 0;
  }
  .spacer {
    flex: 1;
  }
  .dismiss,
  .approve {
    font-size: var(--fs-base);
    padding: 5px 12px;
    cursor: pointer;
    border: 1px solid var(--color-line-bright);
    background: none;
    color: var(--color-muted);
  }
  .approve {
    border-color: var(--color-green);
    color: var(--color-green);
  }
  .promote {
    font-size: var(--fs-base);
    padding: 5px 12px;
    cursor: pointer;
    border: 1px solid var(--color-green);
    background: none;
    color: var(--color-green);
  }
  .prlink {
    font-size: var(--fs-base);
    color: var(--color-green);
    text-decoration: none;
  }
  /* Per-rule "Optimize" — headline action for a flagged rule, styled primary-ish
     like .promote but in the amber "needs attention" hue that flags the rule. */
  .optimize {
    font-size: var(--fs-base);
    padding: 5px 12px;
    cursor: pointer;
    border: 1px solid var(--color-amber);
    background: none;
    color: var(--color-amber);
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
  .irule {
    border: 1px solid var(--color-line);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .itext {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    line-height: 1.5;
  }
  .ifoot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  /* Action group stays together as one flex item so it wraps as a unit
     (never fragmenting Optimize/Dismiss/Promote across lines) when the
     badge row runs out of room in the narrow drawer. */
  .iactions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* Change 9: de-emphasised Dismiss on active rules — muted + gap from Promote */
  .dismiss-muted {
    color: var(--color-muted);
    border-color: var(--color-line);
    margin-right: 4px;
  }
  .chip {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
  }
  .chip.promoted {
    border-color: var(--color-green);
    color: var(--color-green);
  }
  .badge {
    font-size: var(--fs-meta);
    padding: 2px 6px;
    border: 1px solid var(--color-line);
  }
  .badge.ok {
    border-color: var(--color-green);
    color: var(--color-green);
  }
  .badge.warn {
    border-color: var(--color-amber);
    color: var(--color-amber);
    cursor: help;
  }
  .badge.bad {
    border-color: var(--color-red, var(--color-amber));
    color: var(--color-red, var(--color-amber));
    cursor: help;
  }
  .badge.off {
    color: var(--color-muted);
  }
  .badge.scoped {
    border-color: var(--color-blue);
    color: var(--color-blue);
    cursor: help;
  }
  .iscope {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .scope-label {
    color: var(--color-muted);
  }
  .scope-glob {
    padding: 1px 5px;
    border: 1px solid var(--color-line-bright);
    color: var(--color-blue);
    background: color-mix(in srgb, var(--color-blue) 10%, var(--color-head));
  }
  .scope-always {
    color: var(--color-muted);
    font-style: italic;
  }
  .scope-edit,
  .scope-save,
  .scope-cancel {
    font-size: var(--fs-meta);
    background: none;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 2px 7px;
    cursor: pointer;
  }
  .scope-edit:hover,
  .scope-save:hover,
  .scope-cancel:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink-bright);
  }
  .scope-input {
    flex: 1 1 12rem;
    min-width: 0;
    font-size: var(--fs-meta);
    padding: 2px 6px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink-bright);
  }
  .help-rate {
    font-size: var(--fs-micro);
    color: var(--color-muted);
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
  .retired-rule {
    border: 1px solid var(--color-line);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    opacity: 0.7;
  }
  .retired-text {
    font-size: var(--fs-base);
    color: var(--status-done);
    line-height: 1.5;
  }
  .retired-reason {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
  }
  .retired-foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .restore {
    font-size: var(--fs-base);
    padding: 4px 10px;
    cursor: pointer;
    border: 1px solid var(--color-line-bright);
    background: none;
    color: var(--color-muted);
  }
  .restore:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink-bright);
  }

  /* Phase 4: cross-repo recurrence band (top-level, repo-agnostic) */
  .recur {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    background: var(--color-head);
  }
  .recur-title {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-muted);
  }
  .recur-lead {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
  }
  .recur-card,
  .ms-card {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .recur-rule {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    line-height: 1.5;
  }
  .recur-repos {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
  }
  .recur-confirm {
    font-size: var(--fs-meta);
    color: var(--color-amber);
    line-height: 1.45;
  }
  .recur-foot,
  .ms-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
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
  .ms-members {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .ms-member {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
    padding-left: 12px;
    position: relative;
  }
  .ms-member::before {
    content: "•";
    position: absolute;
    left: 2px;
    color: var(--color-line-bright);
  }
  .ms-result {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    line-height: 1.5;
  }
  .ms-result-label {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  /* Merge = actionable consolidation → green (matches .promote) */
  .ms-apply {
    font-size: var(--fs-base);
    padding: 4px 12px;
    cursor: pointer;
    border: 1px solid var(--color-green);
    background: none;
    color: var(--color-green);
  }
  .ms-dismiss {
    font-size: var(--fs-base);
    padding: 4px 10px;
    cursor: pointer;
    border: 1px solid var(--color-line-bright);
    background: none;
    color: var(--color-muted);
  }
  .ms-dismiss:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink-bright);
  }
</style>
