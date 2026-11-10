<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import HerdDoneList from "./HerdDoneList.svelte";
  import HerdEpicHistory from "./HerdEpicHistory.svelte";

  // The Done lens: finished sessions, or (#3838) finished epics — the epic history.
  let {
    doneList,
    doneSelectedId,
    ondoneselect,
    onbringback,
    onaskassistant,
    nowMs,
    repoFilter,
    touchTarget = false,
    onacknowledge,
    onackmigrations,
  }: {
    doneList: Session[];
    doneSelectedId: string | null;
    ondoneselect?: (id: string) => void;
    onbringback?: (id: string) => void;
    onaskassistant?: (desig: string) => void;
    nowMs: number;
    repoFilter: ReadonlySet<string>;
    /** 44px targets: the phone layout, or a coarse pointer on a wide one. */
    touchTarget?: boolean;
    onacknowledge?: (repoPath: string, parent: number) => Promise<boolean>;
    onackmigrations?: (repoPath: string, parent: number) => void | Promise<void>;
  } = $props();

  let view = $state<"sessions" | "epics">("sessions");
</script>

<div class="seg-row" class:touch={touchTarget} role="group" aria-label={m.herd_done_view_label()}>
  <button
    type="button"
    class="seg-btn"
    class:seg-active={view === "sessions"}
    aria-pressed={view === "sessions"}
    onclick={() => (view = "sessions")}>{m.herd_done_view_sessions()}</button
  >
  <button
    type="button"
    class="seg-btn"
    class:seg-active={view === "epics"}
    aria-pressed={view === "epics"}
    onclick={() => (view = "epics")}>{m.herd_done_view_epics()}</button
  >
</div>
{#if view === "epics"}
  <HerdEpicHistory {repoFilter} {nowMs} {onacknowledge} {onackmigrations} />
{:else}
  <HerdDoneList {doneList} {doneSelectedId} {ondoneselect} {onbringback} {onaskassistant} {nowMs} />
{/if}

<style>
  /* The design system's segmented control (/design-system), at desktop height unless touch. */
  .seg-row {
    display: flex;
    margin-top: 6px;
    border-bottom: 1px solid var(--color-line);
  }
  .seg-btn {
    flex: 1;
    min-width: 0;
    min-height: 32px;
    padding: 0 2px;
    border: 0;
    border-right: 1px solid var(--color-line);
    background: none;
    color: var(--color-muted);
    font-family: inherit;
    font-size: var(--fs-meta);
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .touch .seg-btn {
    min-height: 44px;
    font-size: var(--fs-base);
  }
  .seg-btn:last-child {
    border-right: 0;
  }
  .seg-btn:hover {
    color: var(--color-ink);
  }
  .seg-btn.seg-active {
    color: var(--color-amber);
    background: var(--color-inset);
    box-shadow: inset 0 -2px 0 var(--color-amber);
  }
  .seg-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
