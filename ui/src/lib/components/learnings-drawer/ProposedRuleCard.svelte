<script lang="ts">
  import type { Action } from "svelte/action";
  import { untrack } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import type { Learning, SignalKind } from "$lib/types";
  import { evidenceSources } from "../learnings-drawer";
  import type { LearningsCtx } from "./ctx";

  let {
    learning,
    ctx,
  }: {
    learning: Learning;
    ctx: LearningsCtx;
  } = $props();

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

  // Per-card local state (independent, no shared invariant).
  // Snapshot learning.rule once at mount so the draft diverges from any prop refresh.
  // untrack signals intentional one-time capture of the reactive prop value.
  let draft = $state(untrack(() => learning.rule));
  let expanded = $state(false);
</script>

<article class="rule">
  <textarea
    class="text"
    rows="2"
    data-1p-ignore
    use:autosize={draft}
    value={draft}
    oninput={(e) => (draft = e.currentTarget.value)}
    aria-label={m.learnings_rule_aria()}></textarea>
  {#if learning.rationale}
    <p class="why"><span>{m.learnings_rationale_label()}:</span> {learning.rationale}</p>
  {/if}
  <div class="evidence" title={m.learnings_evidence_help()}>
    <span class="evi">{m.learnings_evidence({ count: learning.evidenceCount })}</span>
    {#each evidenceSources(learning) as src (src.kind)}
      <span class="src">{src.count}× {kindLabel(src.kind)}</span>
    {/each}
    <!-- render whenever the payload carries provenance (even an empty,
         fully-pruned list): the toggle is the focusable route to the
         help text for keyboard/touch users -->
    {#if learning.evidenceDetail}
      <button
        class="sources-toggle"
        type="button"
        title={m.learnings_evidence_help()}
        aria-expanded={expanded}
        aria-controls="sources-{learning.id}"
        aria-label={m.learnings_sources_toggle_aria()}
        onclick={() => (expanded = !expanded)}
      >
        {m.learnings_sources_toggle()}
        <span class="caret" class:open={expanded} aria-hidden="true">▸</span>
      </button>
    {/if}
  </div>
  {#if expanded && learning.evidenceDetail}
    <!-- disclosed region the toggle's aria-controls points at; carries a
         visible copy of the provenance explanation, reachable for
         keyboard/touch users who can't hover the title tooltip -->
    <div class="sources-region" id="sources-{learning.id}">
      <p class="shelp">{m.learnings_evidence_help()}</p>
      {#if learning.evidenceDetail.length > 0}
        <ul class="sources">
          {#each learning.evidenceDetail as ev (ev.id)}
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
    <button class="dismiss" onclick={() => ctx.ondismiss(learning.id)}
      >{m.learnings_dismiss()}</button
    >
    <button class="approve" onclick={() => ctx.onapprove(learning.id, draft)}>
      {m.learnings_approve()}
    </button>
  </div>
</article>

<style>
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
  .dismiss {
    font-size: var(--fs-base);
    padding: 5px 12px;
    cursor: pointer;
    border: 1px solid var(--color-line-bright);
    background: none;
    color: var(--color-muted);
  }
  .approve {
    font-size: var(--fs-base);
    padding: 5px 12px;
    cursor: pointer;
    border: 1px solid var(--color-green);
    background: none;
    color: var(--color-green);
  }
</style>
