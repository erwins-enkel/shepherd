<script lang="ts">
  import { fly } from "svelte/transition";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import type { Learning } from "$lib/types";
  import { basename, groupByRepo } from "./learnings-drawer";

  let {
    items,
    onapprove,
    ondismiss,
    ondistill,
    onclose,
  }: {
    items: Learning[];
    onapprove: (id: string, rule: string) => void;
    ondismiss: (id: string) => void;
    ondistill: (repoPath: string) => void;
    onclose: () => void;
  } = $props();

  let drafts = $state<Record<string, string>>({});
  const draft = (l: Learning) => drafts[l.id] ?? l.rule;

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const slide = { x: 440, duration: reduceMotion ? 0 : 220, opacity: 1 };

  const groups = $derived(groupByRepo(items));
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

  {#if items.length === 0}
    <p class="empty">{m.learnings_empty()}</p>
  {:else}
    {#each groups as [repoPath, rules] (repoPath)}
      <section class="group">
        <div class="ghead">
          <span class="repo">{basename(repoPath)}</span>
          <button
            class="distill"
            onclick={() => ondistill(repoPath)}
            aria-label={m.learnings_distill_aria({ repo: basename(repoPath) })}
          >
            {m.learnings_distill()}
          </button>
        </div>
        {#each rules as l (l.id)}
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
    font-size: 12px;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .close {
    background: none;
    border: none;
    color: var(--color-muted);
    cursor: pointer;
    font-size: 14px;
  }
  .empty {
    color: var(--color-muted);
    font-size: 13px;
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
    font-size: 12px;
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .distill {
    font-size: 11px;
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
    font-size: 13px;
  }
  .why {
    font-size: 12px;
    color: var(--color-muted);
    line-height: 1.4;
  }
  .why span {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 10px;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .evi {
    font-size: 11px;
    color: var(--color-muted);
  }
  .spacer {
    flex: 1;
  }
  .dismiss,
  .approve {
    font-size: 12px;
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
</style>
