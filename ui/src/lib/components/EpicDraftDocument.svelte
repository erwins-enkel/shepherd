<script lang="ts">
  import type { EpicDraft, EpicDraftChild } from "#lib/types.js";
  import type { MarkdownSection } from "#lib/epic-draft-outline.js";
  import { m } from "#lib/paraglide/messages.js";
  import EpicDraftChildRow from "#lib/components/EpicDraftChildRow.svelte";
  import MarkdownBody from "#lib/components/MarkdownBody.svelte";

  let {
    draft,
    sections,
    waves,
    awaiting,
    onjump,
  }: {
    draft: EpicDraft;
    /** draft.parent.body split at its headings (splitMarkdownSections). */
    sections: MarkdownSection[];
    /** Wave per child key (childWaves). */
    waves: Map<string, number>;
    awaiting: boolean;
    /** Scroll the draft to the element with this `data-anchor`. */
    onjump: (anchor: string) => void;
  } = $props();

  const children = $derived(draft.children);
  const positionByKey = $derived(new Map(children.map((c, i) => [c.key, i + 1])));
  function blockersOf(child: EpicDraftChild): { key: string; label: string }[] {
    return child.blockedBy.flatMap((k) => {
      const blocker = children.find((c) => c.key === k);
      return blocker ? [{ key: k, label: `${positionByKey.get(k)} · ${blocker.title}` }] : [];
    });
  }
</script>

<div class="doc">
  {#if awaiting}
    <p class="hint">{m.epicdraft_awaiting_hint()}</p>
  {/if}

  <!-- Parent -->
  <section class="parent">
    <span class="section-label">{m.epicdraft_parent_label()}</span>
    <h4 class="parent-title">{draft.parent.title}</h4>
    {#each sections as s, i (i)}
      <section class="part" data-anchor={`part-${i}`}>
        {#if s.title}<h5 class="part-title">{s.title}</h5>{/if}
        {#if s.body}<div class="parent-body"><MarkdownBody source={s.body} /></div>{/if}
      </section>
    {/each}
    {#if draft.parent.acceptanceCriteria.length || draft.parent.nonGoals.length}
      <div class="crit-grid">
        {#if draft.parent.acceptanceCriteria.length}
          <div class="part" data-anchor="acceptance">
            <h5 class="part-title">{m.epicdraft_acceptance_label()}</h5>
            <ul class="crit">
              {#each draft.parent.acceptanceCriteria as c, i (i)}<li>{c}</li>{/each}
            </ul>
          </div>
        {/if}
        {#if draft.parent.nonGoals.length}
          <div class="part" data-anchor="nongoals">
            <h5 class="part-title">{m.epicdraft_nongoals_label()}</h5>
            <ul class="crit">
              {#each draft.parent.nonGoals as g, i (i)}<li>{g}</li>{/each}
            </ul>
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- Children (dependency DAG as an ordered list: wave per row, blockers as jump links) -->
  <section class="children part" data-anchor="children">
    <h5 class="part-title">{m.epicdraft_children_label({ count: children.length })}</h5>
    <ol class="list">
      {#each children as child, i (child.key)}
        <EpicDraftChildRow
          {child}
          index={i}
          wave={waves.get(child.key) ?? 1}
          materializedNumber={draft.materializedChildren[child.key] ?? null}
          blockers={blockersOf(child)}
          onjump={(key) => onjump(`child-${key}`)}
        />
      {/each}
    </ol>
  </section>
</div>

<style>
  .doc {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 22px;
  }
  @container (min-width: 880px) {
    .doc {
      padding: 4px 24px 24px 0;
    }
  }

  .hint {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid color-mix(in oklab, var(--color-amber) 30%, transparent);
    border-radius: 3px;
    background: color-mix(in oklab, var(--color-amber) 10%, transparent);
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    line-height: 1.5;
  }

  .parent {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .part {
    display: flex;
    flex-direction: column;
    gap: 8px;
    scroll-margin-top: 8px;
  }
  .part-title {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    font-size: var(--fs-meta);
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .part-title::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--color-line);
  }
  .crit-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
    gap: 16px 32px;
  }
  .section-label {
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .parent-title {
    margin: 0;
    max-width: 60ch;
    font-size: var(--fs-lg);
    line-height: 1.4;
    color: var(--color-ink-bright);
    font-weight: 600;
    text-wrap: balance;
  }
  .parent-body {
    max-width: 74ch;
    font-size: var(--fs-base);
    line-height: 1.55;
  }
  /* The agent writes decisions as `- **Label:** text` bullets: give them markers and air. */
  .parent-body :global(ul) {
    list-style: disc;
  }
  .parent-body :global(ol) {
    list-style: decimal;
  }
  .parent-body :global(li + li) {
    margin-top: 8px;
  }
  .crit {
    margin: 0;
    max-width: 74ch;
    padding-left: 18px;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.5;
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
  }
</style>
