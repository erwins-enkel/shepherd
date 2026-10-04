<script lang="ts">
  import type { EpicDraftChild } from "$lib/types";
  import type { MarkdownSection } from "$lib/epic-draft-outline";
  import { m } from "$lib/paraglide/messages";

  let {
    sections,
    hasAcceptance,
    hasNonGoals,
    children,
    waves,
    seen,
    showOutcome,
    onjump,
  }: {
    sections: MarkdownSection[];
    hasAcceptance: boolean;
    hasNonGoals: boolean;
    children: EpicDraftChild[];
    /** Wave per child key (childWaves): wave-1 children can start right after approval. */
    waves: Map<string, number>;
    /** Children the operator has had on screen (the modal's seen marks). */
    seen: ReadonlySet<string>;
    /** Show what approving creates — only while the draft awaits review. */
    showOutcome: boolean;
    /** Scroll the draft to the element with this `data-anchor`. */
    onjump: (anchor: string) => void;
  } = $props();

  const dependencyCount = $derived(children.reduce((n, c) => n + c.blockedBy.length, 0));
  const readyNow = $derived(
    children.flatMap((c, i) => (waves.get(c.key) === 1 ? [i + 1] : [])).join(", "),
  );
</script>

<nav class="toc" aria-label={m.epicdraft_toc_label()}>
  <span class="toc-label">{m.epicdraft_toc_label()}</span>
  {#each sections as s, i (i)}
    <button type="button" class="toc-item" onclick={() => onjump(`part-${i}`)}
      >{s.title ?? m.epicdraft_toc_overview()}</button
    >
  {/each}
  {#if hasAcceptance}
    <button type="button" class="toc-item" onclick={() => onjump("acceptance")}
      >{m.epicdraft_acceptance_label()}</button
    >
  {/if}
  {#if hasNonGoals}
    <button type="button" class="toc-item" onclick={() => onjump("nongoals")}
      >{m.epicdraft_nongoals_label()}</button
    >
  {/if}
  <button type="button" class="toc-item" onclick={() => onjump("children")}
    >{m.epicdraft_children_label({ count: children.length })}</button
  >
  <ol class="toc-children">
    {#each children as child, i (child.key)}
      <li>
        <button type="button" class="toc-child" onclick={() => onjump(`child-${child.key}`)}>
          <span class="toc-num">{i + 1}</span>
          <span class="toc-child-title">{child.title}</span>
          {#if seen.has(child.key)}
            <svg class="toc-seen" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 6.5 L5 9 L10 3" />
            </svg>
          {/if}
        </button>
      </li>
    {/each}
  </ol>
  {#if showOutcome}
    <dl class="outcome">
      <dt class="toc-label">{m.epicdraft_outcome_label()}</dt>
      <dd>
        <span>{m.epicdraft_outcome_issues()}</span><span>{children.length + 1}</span>
      </dd>
      <dd>
        <span>{m.epicdraft_outcome_deps()}</span><span>{dependencyCount}</span>
      </dd>
      <dd>
        <span>{m.epicdraft_outcome_ready()}</span><span>{readyNow}</span>
      </dd>
    </dl>
  {/if}
</nav>

<style>
  /* Table of contents: only where there is room beside the draft. It sticks while the draft
     scrolls and scrolls itself when a long epic outgrows it. */
  .toc {
    display: none;
  }
  @container (min-width: 880px) {
    .toc {
      position: sticky;
      top: 0;
      display: flex;
      max-height: calc(90dvh - 180px);
      flex-direction: column;
      gap: 2px;
      overflow-y: auto;
      padding: 4px 12px 8px 0;
      border-right: 1px solid var(--color-line);
    }
  }
  .toc-label {
    padding: 0 8px 6px;
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .toc-item,
  .toc-child {
    width: 100%;
    background: none;
    border: 0;
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .toc-item {
    min-height: 32px;
    padding: 4px 8px;
    font-size: var(--fs-base);
  }
  .toc-item:hover,
  .toc-item:focus-visible,
  .toc-child:hover,
  .toc-child:focus-visible {
    background: var(--color-hover);
    color: var(--color-ink-bright);
  }
  .toc-children {
    margin: 0 0 8px;
    padding: 0;
    list-style: none;
  }
  .toc-child {
    display: grid;
    grid-template-columns: 1.6em minmax(0, 1fr) 12px;
    gap: 6px;
    align-items: center;
    min-height: 28px;
    padding: 2px 8px 2px 14px;
    font-size: var(--fs-meta);
  }
  .toc-num {
    color: var(--color-muted);
  }
  .toc-child-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toc-seen {
    fill: none;
    stroke: var(--color-muted);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .outcome {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: auto 0 0;
    padding: 12px 0 0;
    border-top: 1px solid var(--color-line);
  }
  .outcome .toc-label {
    padding: 0 8px 4px;
  }
  .outcome dd {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin: 0;
    padding: 0 8px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .outcome dd span:last-child {
    color: var(--color-ink-bright);
    text-align: right;
  }
</style>
