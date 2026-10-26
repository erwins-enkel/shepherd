<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";

  // Up Next's batch bar, shown while rows are ticked: it counts them, clears them, and starts
  // them. Ticked issues start as sessions (above a few, after one confirmation — Manual starts
  // bypass the per-repo drain cap); ticked PRs launch a merge train. With both kinds ticked it
  // shows two buttons, and each takes only its own kind of selection.
  let {
    issues,
    prs,
    flow = false,
    confirming,
    starting,
    canTrain,
    onclear,
    onstart,
    oncancelconfirm,
    ontrain,
  }: {
    /** Ticked issues still on screen. */
    issues: number;
    /** Ticked PRs still on screen. */
    prs: number;
    /** The phone's stacked list: the bar sticks above the bottom ActionBar. */
    flow?: boolean;
    /** The issue start is waiting for its one confirmation. */
    confirming: boolean;
    starting: boolean;
    /** Whether the page can launch a merge train at all. */
    canTrain: boolean;
    onclear: () => void;
    /** Gets the click: the CLI picker anchors to the button that started it. */
    onstart: (e: MouseEvent) => void;
    oncancelconfirm: () => void;
    ontrain: () => void;
  } = $props();

  const label = $derived(
    prs === 0
      ? m.upnext_selected_count({ count: issues })
      : issues === 0
        ? m.upnext_pr_selected_count({ count: prs })
        : m.upnext_batch_mixed_count({ issues, prs }),
  );
</script>

<div class={["un-batch", { flow }]} role="region" aria-label={m.upnext_batch_aria()}>
  {#if confirming}
    <span class="un-confirm-text">{m.upnext_confirm({ count: issues })}</span>
    <button type="button" class="un-batch-go un-confirm" disabled={starting} onclick={onstart}
      >{m.upnext_confirm_yes()}</button
    >
    <button type="button" class="un-batch-cancel" onclick={oncancelconfirm}
      >{m.common_cancel()}</button
    >
  {:else}
    <span class="un-batch-count">{label}</span>
    <button type="button" class="un-batch-cancel" onclick={onclear}
      >{m.upnext_clear_selection()}</button
    >
    {#if prs > 0}
      <button
        type="button"
        class={issues > 0 ? "un-batch-alt" : "un-batch-go"}
        disabled={prs < 2 || !canTrain}
        title={prs < 2 ? m.upnext_batch_train_min() : undefined}
        onclick={ontrain}
        >{issues > 0 ? m.upnext_batch_train({ count: prs }) : m.prspanel_launch_train()}</button
      >
    {/if}
    {#if issues > 0}
      <button type="button" class="un-batch-go" disabled={starting} onclick={onstart}
        >{prs > 0
          ? m.upnext_batch_start_issues({ count: issues })
          : m.upnext_start_selected({ count: issues })}</button
      >
    {/if}
  {/if}
</div>

<style>
  /* Starting a batch goes through this bar: tick rows, then start them. Sticky to the
     bottom of the visible list so it stays reachable however deep the last tick was. */
  .un-batch {
    position: sticky;
    bottom: 0;
    z-index: 2;
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 8px 14px;
    border-top: 1px solid var(--color-line-bright);
    background: var(--color-inset);
    flex-wrap: wrap;
  }
  .un-batch-count {
    flex: 1;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  } /* Phone: the page scrolls and the fixed ActionBar covers its bottom edge — stick above it. */
  .un-batch.flow {
    bottom: calc(
      var(--mobile-actionbar-h) + max(var(--mobile-actionbar-pad), env(safe-area-inset-bottom))
    );
  }
  .un-confirm-text {
    flex: 1;
    font-size: var(--fs-meta);
    color: var(--color-amber);
  }
  .un-batch-go {
    min-height: 32px;
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    font-weight: 700;
    padding: 4px 12px;
    cursor: pointer;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .un-batch-go:hover:not(:disabled) {
    background: var(--color-amber);
    color: var(--color-bg);
  }
  .un-batch-go:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .un-batch-go:disabled,
  .un-batch-alt:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  } /* Mixed selection: the merge train is the secondary of the two batch actions. */
  .un-batch-alt {
    min-height: 32px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    font-weight: 700;
    padding: 4px 12px;
    cursor: pointer;
  }
  .un-batch-alt:hover:not(:disabled) {
    border-color: var(--color-ink);
  }
  .un-batch-alt:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-ink);
  }
  .un-batch-cancel {
    background: none;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .un-batch-cancel:hover {
    color: var(--color-ink);
  }
  @media (max-width: 768px), (pointer: coarse) {
    .un-batch-go,
    .un-batch-alt {
      min-height: var(--mobile-actionbar-hit);
    }
  }
</style>
