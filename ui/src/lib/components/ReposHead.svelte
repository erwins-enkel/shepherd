<script lang="ts">
  import type { Snippet } from "svelte";
  import type { BacklogProject } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { formatCount, repoOwnerName } from "./backlog-view";

  // The desktop Repos dialog's header row, replacing the old "REPOS" title bar:
  // the repo switcher (children), the other recently-worked-on repos as one-click
  // chips, and Fast-forward + close on the right. Mobile keeps BacklogOverlay's title bar.
  let {
    recents = [],
    onselect = () => {},
    onff = undefined,
    ffDisabled = false,
    onclose,
    children = undefined,
  }: {
    /** Recent repos other than the open one — each a chip with its open-issue count. */
    recents?: BacklogProject[];
    onselect?: (path: string) => void;
    /** Fast-forward the selected repo's default branch. Omitted → no button (the
     *  loading / no-repos states have nothing to fast-forward). */
    onff?: () => void;
    ffDisabled?: boolean;
    onclose: () => void;
    /** The switcher. Omitted → the plain "Repos" title instead. */
    children?: Snippet;
  } = $props();
</script>

<div class="rh">
  {#if children}
    {@render children()}
    {#if recents.length > 0}
      <div class="rh-recent">
        <span class="rh-label">{m.repos_head_recent()}</span>
        {#each recents as project (project.path)}
          {@const name = repoOwnerName(project).name}
          <button
            class="rh-chip"
            type="button"
            aria-label={m.repos_head_chip_aria({
              repo: name,
              count: formatCount(project.openIssues),
            })}
            onclick={() => onselect(project.path)}
          >
            <span class="rh-chip-name">{name}</span>
            {#if project.openIssues !== null}
              <span class="rh-chip-count">{project.openIssues}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  {:else}
    <span class="rh-title">{m.actionbar_backlog()}</span>
  {/if}
  <div class="rh-actions">
    {#if onff}
      <button
        class="gbtn ff-btn"
        type="button"
        disabled={ffDisabled}
        onclick={onff}
        title={m.backlog_ff_main_title()}
        aria-label={m.backlog_ff_main_title()}
        use:coachTarget={"backlog-ff-main"}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M1 2.5L5.5 6 1 9.5V2.5Z" fill="currentColor" />
          <path d="M6.5 2.5L11 6 6.5 9.5V2.5Z" fill="currentColor" />
        </svg>
        {m.backlog_ff_main()}
      </button>
    {/if}
    <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
  </div>
</div>

<style>
  .rh {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 8px 14px;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }

  .rh-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  /* Clipped, not wrapped, when the modal is narrow: Fast-forward and ✕ must stay put. */
  .rh-recent {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
  }
  .rh-label {
    flex-shrink: 0;
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .rh-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    min-height: 30px;
    padding: 0 10px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    cursor: pointer;
    touch-action: manipulation;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .rh-chip:hover {
    border-color: var(--color-line-bright);
    color: var(--color-ink-bright);
  }
  .rh-chip:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
  }
  .rh-chip-name {
    max-width: 18ch;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .rh-chip-count {
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }

  .rh-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    flex-shrink: 0;
  }

  /* Fast-forward: same look it had in the tab bar. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* keyboard focus — flat inset amber ring (never an outer glow), per design-system */
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .ff-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }

  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 2px 6px;
  }
  .x:hover {
    color: var(--color-amber);
  }
</style>
