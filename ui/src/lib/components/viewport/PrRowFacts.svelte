<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { FACT_GLYPH, type PrRowFact } from "./pr-action-row";

  // The merge row's fact line. The critic fact can open the findings dialog.
  let {
    facts,
    opensFindings,
    findingsOpen,
    onfindings,
  }: {
    facts: PrRowFact[];
    opensFindings: boolean;
    findingsOpen: boolean;
    onfindings: (opener: HTMLElement) => void;
  } = $props();
</script>

<p class="pr-facts">
  {#each facts as f, i (f.id)}{#if i > 0}<span class="pr-dot" aria-hidden="true">·</span
      >{/if}{#if f.id === "critic" && opensFindings}<button
        class={["fact", "fact-btn", f.tone]}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={findingsOpen}
        title={m.gitrail_review_title()}
        onclick={(e) => onfindings(e.currentTarget)}
        ><span class="fg" aria-hidden="true">{FACT_GLYPH[f.tone]}</span>{f.text}</button
      >{:else}<span class={["fact", f.tone]}
        ><span class="fg" aria-hidden="true">{FACT_GLYPH[f.tone]}</span>{f.text}</span
      >{/if}{/each}
</p>

<style>
  .pr-facts {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    color: var(--color-muted);
  }
  .pr-dot {
    margin: 0 8px;
  }
  .fact .fg {
    margin-right: 5px;
  }
  .fact.ok .fg {
    color: var(--color-green);
  }
  .fact.fail .fg {
    color: var(--color-red);
  }
  .fact-btn {
    appearance: none;
    margin: 0;
    padding: 0;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: var(--color-line-bright);
    text-underline-offset: 2px;
  }
  .fact-btn:hover {
    color: var(--color-ink-bright);
    text-decoration-color: currentColor;
  }
  .fact-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
