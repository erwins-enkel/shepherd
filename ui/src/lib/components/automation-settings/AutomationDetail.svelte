<script lang="ts">
  // The long-form explanation an AutomationInfoTip reveals. Every row carries a thorough,
  // newcomer-friendly description of what it does, how, and when it fires.
  //
  // Extracted from AutomationSettings for two reasons: it keeps the hide-info-tips guard out
  // of that template (which sits 1 under the Tier-1 <template> complexity bar), and it folds
  // in the sandbox row, whose explainer used to be hand-written markup rather than the shared
  // snippet — so hiding the ⓘ removed the button but left its paragraphs stranded in the DOM.
  // One component now owns both shapes, so that divergence can't reappear.
  //
  // While tips are shown the block stays mounted, toggled with `hidden` rather than {#if}, so
  // the button's aria-controls target always resolves. When the operator hides tips it is
  // removed outright — leaving it `hidden` would strand content that nothing could ever reveal
  // again, since its ⓘ is gone too.
  import { infoTips } from "$lib/info-tips.svelte";

  // Exactly one of `text` / `paragraphs` is given. `text` is the single-note shape every
  // switch row uses (its message may carry \n\n breaks, rendered via white-space: pre-line).
  // `paragraphs` is the multi-paragraph shape — currently only the sandbox row, which needs
  // real <p> children rather than pre-line whitespace.
  let {
    id,
    open,
    text,
    paragraphs,
  }: { id: string; open: boolean; text?: string; paragraphs?: string[] } = $props();
</script>

{#if !infoTips.hidden}
  {#if paragraphs}
    <!-- Container with real <p> children; recessed against the .drain-fields ground it sits
         on. Keyed by index: two paragraphs could legitimately carry identical text, and a
         text key would throw on the duplicate. -->
    <div id="auto-detail-{id}" class="auto-detail sandbox-detail" role="note" hidden={!open}>
      {#each paragraphs as paragraph, i (i)}
        <p>{paragraph}</p>
      {/each}
    </div>
  {:else}
    <p id="auto-detail-{id}" class="auto-detail" role="note" hidden={!open}>{text}</p>
  {/if}
{/if}

<style>
  /* the revealed long-form explanation: a quiet tonal-step note (panel over the
     popover's inset ground) with a full hairline border — no accent stripe */
  .auto-detail {
    margin: 6px 0 0;
    padding: 8px 10px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-ink);
    /* messages may carry \n\n paragraph breaks (e.g. auto-address/auto-drain) */
    white-space: pre-line;
  }
  /* Recess to --color-inset so it steps against the --color-panel .drain-fields ground
     (panel-over-panel would show no fill step — only the border). margin-top:0 cancels the
     .auto-detail 6px that would otherwise stack on .drain-fields' 6px gap. */
  .sandbox-detail {
    margin-top: 0;
    background: var(--color-inset);
    /* container with real <p> children — pre-line would render markup whitespace */
    white-space: normal;
  }
  .sandbox-detail p {
    margin: 0;
  }
  .sandbox-detail p + p {
    margin-top: 6px;
  }
</style>
