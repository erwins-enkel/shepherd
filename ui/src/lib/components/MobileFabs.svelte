<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import TopBarAssist from "./top-bar/TopBarAssist.svelte";

  // Phone list screen (variant E, docs/design/mobile-herd): the two actions that used to sit
  // at the screen's top edge and in the action bar float above the bar, in the thumb corner.
  // --mobile-fab-clear (app.css) is the band they take; toasts and the list's bottom reserve
  // clear it by the same token.
  let {
    onnew,
    assistant = null,
    assistants = [],
    assistantOpen = false,
    workingBlocked = {},
    backgroundBusy = {},
    onassistant,
  }: {
    onnew: () => void;
    assistant?: Session | null;
    assistants?: Session[];
    assistantOpen?: boolean;
    workingBlocked?: Record<string, boolean>;
    backgroundBusy?: Record<string, boolean>;
    /** Absent → no Assist button. */
    onassistant?: () => void;
  } = $props();
</script>

<div class="fabs">
  {#if onassistant}
    <TopBarAssist
      {assistant}
      {assistants}
      open={assistantOpen}
      compact
      mobile
      {workingBlocked}
      {backgroundBusy}
      onclick={onassistant}
    />
  {/if}
  <button class="new" type="button" onclick={onnew} aria-label={m.actionbar_new_task()}>
    <!-- Drawn plus: the label is the bare verb, so the glyph carries the "+". Decorative —
         the full label rides on aria-label. -->
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="square"
      aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg
    >{m.actionbar_new_task_short()}
  </button>
</div>

<style>
  .fabs {
    position: fixed;
    z-index: 5;
    right: max(16px, env(safe-area-inset-right));
    bottom: calc(
      var(--mobile-actionbar-h) + max(var(--mobile-actionbar-pad), env(safe-area-inset-bottom)) +
        var(--mobile-fab-gap)
    );
    display: flex;
    gap: 10px;
  }
  .new {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: var(--mobile-fab-size);
    padding: 0 18px;
    border: 0;
    background: var(--color-amber);
    color: var(--color-on-action);
    font-size: var(--fs-meta);
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .new:focus-visible {
    outline: 2px solid var(--color-ink-bright);
    outline-offset: 2px;
  }
</style>
