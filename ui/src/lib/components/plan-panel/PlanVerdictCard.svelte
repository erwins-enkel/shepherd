<script lang="ts">
  import type { PlanGate, PlanSummaryCode } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { relativeTimeAgo } from "#lib/format.js";
  import { getLocale } from "#lib/i18n.js";
  import { clock } from "#lib/now.svelte.js";
  import MarkdownBody from "#lib/components/MarkdownBody.svelte";

  let {
    gate,
    reviewer,
    notes,
    rationale,
    tone,
  }: {
    gate: PlanGate;
    /** The reviewer's CLI label, or null when it could not be resolved. */
    reviewer: string | null;
    /** Non-blocking suggestion items split out of the write-up (splitReviewerNotes). */
    notes: string[];
    /** The reviewer's write-up without those items. */
    rationale: string;
    tone: "ready" | "changes" | "error" | "muted";
  } = $props();

  const decision = $derived(
    gate.decision === "approved"
      ? m.planpanel_verdict_approved()
      : gate.decision === "changes_requested"
        ? m.planpanel_verdict_changes()
        : m.planpanel_verdict_error(),
  );
  // An approval resets the rework streak to 0 server-side, so the round only means something on a
  // gate that has not cleared.
  const meta = $derived(
    [
      reviewer,
      gate.approved ? null : m.planpanel_verdict_round({ round: gate.round, cap: gate.cap }),
      relativeTimeAgo(gate.updatedAt, clock.current, getLocale()),
    ]
      .filter(Boolean)
      .join(" · "),
  );
  const summary = $derived(gate.summaryCode ? summaryForCode(gate.summaryCode) : gate.summary);
  const notesSource = $derived(notes.map((n, i) => `${i + 1}. ${n}`).join("\n"));

  /** Server-authored gate summaries travel as a sentinel CODE and are localized here, so no English
   *  is ever baked into the row. An unknown code (older UI, newer server) falls back to the generic
   *  no-verdict copy rather than rendering nothing. */
  function summaryForCode(code: PlanSummaryCode): string {
    // #2111: the reviewer never launched — its agent binary does not start inside the membrane.
    if (code === "membrane-launch") return m.planpanel_membrane_launch();
    return m.planpanel_no_verdict();
  }
</script>

<!-- The decision basis comes first: blocking findings lead, then the non-blocking notes, with the
     full write-up folded underneath. -->
<section class="verdict {tone}" data-anchor="verdict" aria-label={m.planpanel_verdict()}>
  <div class="vhead">
    <span class="vtitle">{m.planpanel_verdict_head({ decision })}</span>
    <span class="vmeta">{meta}</span>
  </div>
  {#if summary}
    <p class="summary">{summary}</p>
  {/if}
  {#if gate.findings.length > 0 || notes.length > 0}
    <div class="vcols">
      {#if gate.findings.length > 0}
        <div class="vcol">
          <span class="vlabel findings-head">{m.planpanel_findings_blocking()}</span>
          <ol class="findings">
            {#each gate.findings as f, i (i)}
              <li>{f}</li>
            {/each}
          </ol>
        </div>
      {/if}
      {#if notes.length > 0}
        <div class="vcol notes">
          <span class="vlabel">{m.planpanel_notes_head()}</span>
          <MarkdownBody source={notesSource} />
        </div>
      {/if}
    </div>
  {/if}
  {#if rationale.trim()}
    <details class="rationale">
      <summary>{m.planpanel_verdict_full()}</summary>
      <div class="rationale-body"><MarkdownBody source={rationale} /></div>
    </details>
  {/if}
</section>

<style>
  .verdict {
    --tone: var(--color-muted);
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px 18px;
    border: 1px solid color-mix(in oklab, var(--tone) 30%, var(--color-line));
    border-radius: 3px;
    background: color-mix(in oklab, var(--tone) 5%, var(--color-panel));
    scroll-margin-top: 8px;
  }
  .verdict.ready {
    --tone: var(--color-green);
  }
  .verdict.changes {
    --tone: var(--color-amber);
  }
  .verdict.error {
    --tone: var(--color-red);
  }
  .vhead {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
  }
  .vtitle {
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--tone);
  }
  .vmeta {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .summary {
    margin: 0;
    max-width: 64ch;
    font-size: var(--fs-lg);
    line-height: 1.45;
    color: var(--color-ink-bright);
    text-wrap: balance;
  }
  .vcols {
    display: grid;
    gap: 16px 28px;
  }
  @container (min-width: 880px) {
    .vcols {
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }
  }
  .vcol {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 8px;
  }
  .vlabel {
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .findings-head {
    color: var(--color-amber);
  }
  .findings,
  .notes :global(ol) {
    list-style: decimal;
  }
  .findings {
    margin: 0;
    max-width: 74ch;
    padding-left: 22px;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .findings li + li {
    margin-top: 6px;
  }
  .findings li::marker,
  .notes :global(li::marker) {
    color: var(--color-amber);
  }
  .rationale {
    border-top: 1px solid var(--color-line);
    padding-top: 10px;
  }
  .rationale summary {
    padding: 6px 0;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    color: var(--color-muted);
    cursor: pointer;
  }
  .rationale summary:hover,
  .rationale summary:focus-visible {
    color: var(--color-ink-bright);
  }
  .rationale-body {
    max-width: 74ch;
    padding-top: 8px;
  }
</style>
