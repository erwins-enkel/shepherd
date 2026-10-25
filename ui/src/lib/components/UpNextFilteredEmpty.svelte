<script lang="ts">
  import type { UpNextFilterStats } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";

  // Up Next's empty state when the default filter hid everything (#3018): the work is hidden,
  // not done. hiddenBy: the per-rule breakdown, when it applies to what is in view.
  let {
    hidden,
    hiddenBy,
    onadjust,
    onbacklog,
  }: {
    hidden: number;
    hiddenBy?: UpNextFilterStats["hiddenBy"];
    onadjust?: () => void;
    onbacklog?: () => void;
  } = $props();

  const reasons = $derived(
    hiddenBy
      ? [
          hiddenBy.scope > 0 ? m.upnext_filter_empty_by_scope({ count: hiddenBy.scope }) : null,
          hiddenBy.forks > 0 ? m.upnext_filter_empty_by_forks({ count: hiddenBy.forks }) : null,
          hiddenBy.labels > 0 ? m.upnext_filter_empty_by_labels({ count: hiddenBy.labels }) : null,
        ].filter((r) => r !== null)
      : [],
  );
</script>

<div class="unfe">
  <p class="unfe-title">{m.upnext_filter_empty_title()}</p>
  <p class="unfe-muted">{m.upnext_filter_empty_body({ count: hidden })}</p>
  {#if reasons.length > 0}
    <ul class="unfe-by">
      {#each reasons as reason (reason)}<li>{reason}</li>{/each}
    </ul>
  {/if}
  <div class="unfe-actions">
    {#if onadjust}
      <button type="button" class="unfe-link" onclick={onadjust}>{m.upnext_filter_adjust()}</button>
    {/if}
    {#if onbacklog}
      <button type="button" class="unfe-link" onclick={onbacklog}>{m.upnext_open_backlog()}</button>
    {/if}
  </div>
</div>

<style>
  .unfe {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 14px;
  }
  .unfe-title,
  .unfe-muted {
    margin: 0;
    font-size: var(--fs-meta);
  }
  .unfe-title {
    color: var(--color-ink-bright);
  }
  .unfe-muted {
    color: var(--color-muted);
  }
  .unfe-by {
    margin: 0;
    padding-left: 16px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .unfe-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
  /* The panel's .un-backlog-link recipe. */
  .unfe-link {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-amber);
    cursor: pointer;
    text-decoration: underline;
  }
  .unfe-link:hover {
    text-decoration: none;
  }
  .unfe-link:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
