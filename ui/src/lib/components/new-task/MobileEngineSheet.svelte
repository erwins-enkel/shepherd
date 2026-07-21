<script lang="ts">
  import type { Snippet } from "svelte";
  import { dialog } from "$lib/a11yDialog";

  // Mobile bottom sheet used for the Engine+Guards groups and the repo·branch context
  // sheet. Blocking dialog → shared `.scrim` backdrop (dim + blur) per the design
  // system. Nested-dialog Escape composes with the modal's own `use:dialog`: this
  // sheet's action preventDefault()s the keypress, so the outer modal stays open;
  // its destroy restores focus to the opener. No entrance animation — the handoff's
  // no-motion rule is honored fully.
  let {
    label,
    title,
    onclose,
    children,
  }: {
    /** Accessible dialog name. */
    label: string;
    /** Visible sheet heading (uppercase micro label). */
    title: string;
    onclose: () => void;
    children: Snippet;
  } = $props();
</script>

<div
  class="sheet-scrim scrim"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label={label} use:dialog={{ onclose }}>
  <div class="sheet-head">
    <span class="sheet-title">{title}</span>
  </div>
  <div class="sheet-body">
    {@render children()}
  </div>
</div>

<style>
  .sheet-scrim {
    z-index: 30;
  }
  .sheet {
    position: fixed;
    z-index: 31;
    left: 0;
    right: 0;
    bottom: 0;
    box-sizing: border-box;
    max-height: 85dvh;
    display: flex;
    flex-direction: column;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-bottom: 0;
    border-radius: 12px 12px 0 0;
    box-shadow: var(--shadow-popover);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .sheet-head {
    flex-shrink: 0;
    padding: 12px 16px 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .sheet-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .sheet-body {
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px;
  }
</style>
