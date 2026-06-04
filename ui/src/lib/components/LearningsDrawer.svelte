<script lang="ts">
  import { fly } from "svelte/transition";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import type { Learning, RepoInjectable } from "$lib/types";
  import {
    basename,
    mergeRepoGroups,
    injectionBadge,
    injectedCount,
    showIneffective,
  } from "./learnings-drawer";

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
  const slide = { x: 440, duration: reduceMotion ? 0 : 220, opacity: 1 };

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
              value={draft(l)}
              oninput={(e) => (drafts = { ...drafts, [l.id]: e.currentTarget.value })}
              aria-label={m.learnings_rule_aria()}
            ></textarea>
            {#if l.rationale}
              <p class="why"><span>{m.learnings_rationale_label()}:</span> {l.rationale}</p>
            {/if}
            <div class="foot">
              <span class="evi">{m.learnings_evidence({ count: l.evidenceCount })}</span>
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
    width: min(440px, 100vw);
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
    resize: vertical;
    background: var(--color-inset);
    color: var(--color-ink-bright);
    border: 1px solid var(--color-line);
    padding: 6px;
    font: inherit;
    font-size: var(--fs-base);
  }
  .why {
    font-size: var(--fs-base);
    color: var(--color-muted);
    line-height: 1.4;
  }
  .why span {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--fs-micro);
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
    line-height: 1.4;
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
