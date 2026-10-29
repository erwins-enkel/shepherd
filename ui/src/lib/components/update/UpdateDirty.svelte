<script lang="ts">
  import type { Snippet } from "svelte";
  import type { DirtyStatus } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";

  // A dirty tree blocking a self-update — this Shepherd's or a connected machine's: what changed,
  // and, before a discard, what it would reset. The caller owns the discard and its two-click arm.
  let {
    dirty,
    body,
    stale = false,
    arming = false,
    actions,
  }: {
    dirty: DirtyStatus | null;
    /** Whose repo is dirty, and what the operator can do about it. */
    body: string;
    /** The tree changed since the list was shown: confirm again. */
    stale?: boolean;
    /** The discard is armed: show what it resets. */
    arming?: boolean;
    actions?: Snippet;
  } = $props();

  // no signature → too large to verify for a one-click discard; the operator resolves it by hand
  const tooLarge = $derived(dirty?.sig == null);
  const moreCount = $derived(dirty ? dirty.dirtyCount - dirty.dirtyFiles.length : 0);
</script>

<div class="dirty">
  <div class="dirty-title">{m.updatemodal_dirty_title()}</div>
  <p class="dirty-body">{body}</p>
  {#if stale}
    <p class="dirty-stale">{m.updatemodal_dirty_stale()}</p>
  {/if}
  {#if dirty && dirty.dirtyFiles.length}
    <div class="loghead">{m.updatemodal_dirty_files_head()}</div>
    <ul class="files">
      {#each dirty.dirtyFiles as f (f)}
        <li>{f}</li>
      {/each}
      {#if moreCount > 0}
        <li class="more">{m.updatemodal_dirty_files_more({ count: moreCount })}</li>
      {/if}
    </ul>
  {/if}
  {#if tooLarge}
    <p class="dirty-hint">{m.updatemodal_dirty_too_large()}</p>
  {:else if arming}
    <div class="confirm">
      <span class="confirm-q"
        >{m.updatemodal_discard_confirm({ count: dirty?.dirtyCount ?? 0 })}</span
      >
    </div>
  {/if}
  {#if actions}<div class="dirty-actions">{@render actions()}</div>{/if}
</div>

<style>
  .dirty {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .dirty-title {
    color: var(--color-red);
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .dirty-body,
  .dirty-hint,
  .dirty-stale {
    margin: 0;
    font-size: var(--fs-base);
    line-height: 1.45;
    color: var(--color-ink);
  }
  .dirty-hint {
    color: var(--color-muted);
  }
  .dirty-stale {
    color: var(--color-amber);
  }
  .loghead {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .files {
    margin: 0;
    list-style: none;
    padding: 8px 10px;
    max-height: 160px;
    overflow: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    line-height: 1.5;
    white-space: pre;
  }
  .files .more {
    color: var(--color-faint);
    white-space: normal;
  }
  .confirm {
    padding: 8px 10px;
    border: 1px solid var(--color-red);
    background: var(--color-inset);
  }
  .confirm-q {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .dirty-actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 10px;
  }
</style>
