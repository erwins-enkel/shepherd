<script lang="ts">
  import type { VisualBlock } from "#lib/types.js";
  import type { PlanOutline } from "#lib/plan-outline.js";
  import { m } from "#lib/paraglide/messages.js";
  import { relativeTimeAgo } from "#lib/format.js";
  import { getLocale } from "#lib/i18n.js";
  import { clock } from "#lib/now.svelte.js";
  import MarkdownBody from "#lib/components/MarkdownBody.svelte";
  import VisualReview from "#lib/components/VisualReview.svelte";

  let {
    outline,
    bytes,
    agent,
    asOf,
    blocks,
    answerCtx,
    unreviewed,
    edited,
    emptyLabel,
  }: {
    outline: PlanOutline;
    /** Size of the plan text, for the meta line. */
    bytes: number;
    /** The planning agent's CLI label. */
    agent: string;
    /** When the reviewed snapshot was taken (gate.updatedAt); null for the live draft. */
    asOf: number | null;
    blocks: VisualBlock[];
    answerCtx?: { sessionId: string; locked: boolean };
    /** The text below is the live draft, not a reviewed snapshot. */
    unreviewed: boolean;
    /** #2224: the live plan has changed since the snapshot below was approved. */
    edited: boolean;
    emptyLabel: string;
  } = $props();

  const hasPlan = $derived(outline.title !== null || outline.sections.length > 0);
  const meta = $derived(
    [
      m.planpanel_meta_by({ agent }),
      asOf === null
        ? null
        : m.planpanel_meta_asof({ ago: relativeTimeAgo(asOf, clock.current, getLocale()) }),
      new Intl.NumberFormat(getLocale(), {
        style: "unit",
        unit: "kilobyte",
        maximumFractionDigits: 1,
      }).format(bytes / 1024),
    ]
      .filter(Boolean)
      .join(" · "),
  );
</script>

<div class="plan-doc">
  {#if unreviewed}
    <p class="note" role="status">{m.planpanel_draft_unreviewed()}</p>
  {/if}
  {#if edited}
    <p class="note edited-note" role="status">{m.planpanel_edited_note()}</p>
  {/if}
  {#if hasPlan}
    <header class="doc-head">
      <span class="micro">{m.planpanel_doc_label()}</span>
      {#if outline.title}<h2 class="doc-title">{outline.title}</h2>{/if}
      <p class="doc-meta">{meta}</p>
    </header>
  {/if}
  {#if blocks.length > 0}
    <div class="plan-blocks" data-anchor="blocks">
      <span class="micro plan-blocks-caption">{m.planpanel_proposed_caption()}</span>
      <VisualReview {blocks} {answerCtx} />
    </div>
  {/if}
  {#if hasPlan}
    {#each outline.sections as section, i (i)}
      <section class="part" data-anchor={`part-${i}`}>
        {#if section.title}<h3 class="part-title">{section.title}</h3>{/if}
        {#if section.body}<MarkdownBody source={section.body} />{/if}
      </section>
    {/each}
  {:else}
    <p class="empty">{emptyLabel}</p>
  {/if}
</div>

<style>
  .plan-doc {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 26px;
  }
  .note {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  /* #2224: says the text below is the approved snapshot, not the live file. */
  .edited-note {
    color: var(--color-amber);
  }
  .doc-head {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .doc-title {
    margin: 0;
    max-width: 40ch;
    font-size: var(--fs-xl);
    font-weight: 600;
    line-height: 1.35;
    color: var(--color-ink-bright);
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  .doc-meta {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .plan-blocks {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--color-line);
    scroll-margin-top: 8px;
  }
  .empty {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-base);
  }
  .part {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 12px;
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

  /* Typesetting of the plan Markdown: running text on a readable measure, tables and code blocks
     framed and scrolling inside themselves so the sheet never swings sideways. */
  .part :global(.md-body) {
    line-height: 1.6;
  }
  .part :global(.md-body :is(p, ul, ol, blockquote, h3, h4, h5, h6)) {
    max-width: 74ch;
  }
  /* The global reset drops list markers; a plan's lists need them back. */
  .part :global(.md-body ul) {
    list-style: disc;
  }
  .part :global(.md-body ol) {
    list-style: decimal;
  }
  .part :global(:is(h3, h4)) {
    scroll-margin-top: 8px;
  }
  .part :global(li + li) {
    margin-top: 6px;
  }
  .part :global(.md-body > ol) {
    list-style-type: decimal-leading-zero;
    padding-left: 30px;
  }
  .part :global(.md-body > ol > li) {
    scroll-margin-top: 8px;
  }
  .part :global(.md-body > ol > li::marker) {
    color: var(--color-amber);
  }
  .part :global(table) {
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .part :global(th) {
    font-size: var(--fs-micro);
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  /* Cells keep whole words: a table wider than the column scrolls inside its frame instead of
     breaking words letter by letter. */
  .part :global(:is(th, td)) {
    min-width: 12ch;
    padding: 6px 10px;
    vertical-align: top;
    overflow-wrap: normal;
  }
  /* GFM task lists: an inert box, ticked when done. */
  .part :global(input[type="checkbox"]) {
    appearance: none;
    display: inline-grid;
    place-content: center;
    width: 13px;
    height: 13px;
    margin: 0 8px 0 0;
    vertical-align: -2px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: var(--color-inset);
  }
  .part :global(input[type="checkbox"]::before) {
    content: "";
    width: 7px;
    height: 7px;
    background: var(--color-ink-bright);
    clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
    transform: scale(0);
  }
  .part :global(input[type="checkbox"]:checked::before) {
    transform: scale(1);
  }
</style>
