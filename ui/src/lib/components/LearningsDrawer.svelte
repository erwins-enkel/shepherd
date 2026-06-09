<script lang="ts">
  import { fly } from "svelte/transition";
  import type { Action } from "svelte/action";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import type { Learning, RepoInjectable, SignalKind } from "$lib/types";
  import {
    basename,
    mergeRepoGroups,
    injectionBadge,
    injectedCount,
    showIneffective,
    evidenceSources,
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
    onapprove,
    ondismiss,
    ondistill,
    onpromote,
    onclose,
  }: {
    items: Learning[];
    injectable: RepoInjectable[];
    onapprove: (id: string, rule: string) => void;
    ondismiss: (id: string) => void;
    ondistill: (repoPath: string) => void;
    onpromote: (id: string) => void;
    onclose: () => void;
  } = $props();

  let drafts = $state<Record<string, string>>({});
  const draft = (l: Learning) => drafts[l.id] ?? l.rule;

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // Matches the drawer width so the fly-in starts fully off-screen.
  const slide = { x: 520, duration: reduceMotion ? 0 : 220, opacity: 1 };

  const groups = $derived(mergeRepoGroups(items, injectable));
  // Empty only when there's nothing to curate in either view.
  const empty = $derived(groups.length === 0);
</script>

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
    <button class="close" onclick={() => onclose()} aria-label={m.learnings_close_aria()}>✕</button>
  </header>

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
    {#if aboutOpen}
      <div class="about-body" id="learnings-about">
        <p>{m.learnings_about_lead()} <strong>{m.learnings_about_scope()}</strong></p>
        <p>{m.learnings_about_flow()}</p>
      </div>
    {/if}
  </section>

  {#if empty}
    <p class="empty">{m.learnings_empty()}</p>
  {:else}
    {#each groups as group (group.repoPath)}
      <section class="group">
        <div class="ghead">
          <span class="repo">{basename(group.repoPath)}</span>
          <button
            class="distill"
            onclick={() => ondistill(group.repoPath)}
            aria-label={m.learnings_distill_aria({ repo: basename(group.repoPath) })}
          >
            {m.learnings_distill()}
          </button>
        </div>

        {#each group.proposed as l (l.id)}
          <article class="rule">
            <textarea
              class="text"
              rows="2"
              use:autosize={draft(l)}
              value={draft(l)}
              oninput={(e) => (drafts = { ...drafts, [l.id]: e.currentTarget.value })}
              aria-label={m.learnings_rule_aria()}
            ></textarea>
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

        {#if group.injectable && group.injectable.rules.length > 0}
          {@const inj = group.injectable}
          <div class="injected">
            <div class="ihead">
              <span class="ititle">{m.learnings_injected_section()}</span>
              <span class="meter">
                {m.learnings_budget_meter({
                  used: inj.usedChars,
                  budget: inj.budgetChars,
                  injected: injectedCount(inj),
                  total: inj.rules.length,
                })}
              </span>
            </div>
            {#each inj.rules as r (r.id)}
              {@const badge = injectionBadge(r, inj.enabled)}
              <article class="irule">
                <p class="itext">{r.rule}</p>
                <div class="ifoot">
                  <span class="chip" class:promoted={r.status === "promoted"}>
                    {r.status === "promoted"
                      ? m.learnings_status_promoted()
                      : m.learnings_status_active()}
                  </span>
                  {#if badge === "injected"}
                    <span class="badge ok">✓ {m.learnings_injected_badge()}</span>
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
                  <span class="spacer"></span>
                  {#if r.status === "active"}
                    <button class="dismiss" onclick={() => ondismiss(r.id)}>
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
                    <a
                      class="prlink"
                      href={r.promotedPrUrl}
                      target="_blank"
                      rel="noopener external"
                    >
                      {m.learnings_promoted_pr()}
                    </a>
                  {/if}
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
    padding: 14px;
    overflow-y: auto;
    z-index: 50;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
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
  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ghead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--color-line);
    padding-bottom: 4px;
  }
  .repo {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    font-weight: 600;
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
    gap: 6px;
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
</style>
