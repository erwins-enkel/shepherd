<script lang="ts">
  import type { Session, RecapVerdict } from "#lib/types.js";
  import { recaps } from "#lib/recaps.svelte.js";
  import { formatAgo } from "#lib/format.js";
  import { m } from "#lib/paraglide/messages.js";
  import CardMenu from "../CardMenu.svelte";
  import { longPress } from "../longpress";

  let {
    doneList,
    doneSelectedId,
    ondoneselect,
    onbringback,
    nowMs,
  }: {
    doneList: Session[];
    doneSelectedId: string | null;
    ondoneselect?: (id: string) => void;
    // when provided, right-click / long-press on a row opens a menu with "Bring back"
    onbringback?: (id: string) => void;
    nowMs: number;
  } = $props();

  // Row context menu (right-click on desktop, long-press on touch) — mirrors UnitRow.
  // Row buttons by id: the long-press callback carries only coords, and the menu returns
  // focus to the row that opened it.
  const rowEls: Record<string, HTMLButtonElement | null> = {};
  let menu = $state<{ id: string; x: number; y: number; opener?: HTMLElement } | null>(null);
  // Returns whether a menu opened, so the long-press knows to swallow the trailing tap.
  function openMenuAt(id: string, x: number, y: number): boolean {
    if (menu || !onbringback) return false;
    menu = { id, x, y, opener: rowEls[id] ?? undefined };
    return true;
  }
  function onContextMenu(e: MouseEvent, id: string) {
    if (!onbringback) return; // nothing to offer → leave native menu
    e.preventDefault();
    openMenuAt(id, e.clientX, e.clientY);
  }
  function bringBackFromMenu() {
    const id = menu?.id;
    menu = null;
    if (id) onbringback?.(id);
  }

  // Done lens row chrome: a finished session's recap verdict drives a small chip.
  // Semantic colors mirror SessionRecap/DoneRecapPanel (green = genuinely READY only;
  // parked = slate; needs-attention = amber).
  const VERDICT_COLOR: Record<RecapVerdict, string> = {
    ready: "var(--color-green)",
    parked: "var(--status-done)",
    needs_attention: "var(--color-amber)",
  };

  function verdictLabel(v: RecapVerdict): string {
    if (v === "ready") return m.recap_verdict_ready();
    if (v === "parked") return m.recap_verdict_parked();
    return m.recap_verdict_needs_attention();
  }

  // last path segment of a repoPath, for the done row's repo label
  function repoBasename(p: string): string {
    return p.split("/").filter(Boolean).at(-1) ?? p;
  }
</script>

{#if doneList.length === 0}
  <div class="empty micro static">{m.herd_done_empty()}</div>
{:else}
  {#each doneList as ds (ds.id)}
    {@const r = recaps.map[ds.id]}
    <button
      bind:this={rowEls[ds.id]}
      type="button"
      class="done-row"
      class:sel={ds.id === doneSelectedId}
      data-unit-id={ds.id}
      onclick={() => ondoneselect?.(ds.id)}
      oncontextmenu={(e) => onContextMenu(e, ds.id)}
      use:longPress={{ onTrigger: (x, y) => openMenuAt(ds.id, x, y) }}
    >
      <div class="done-row-top">
        <span class="done-desig">{ds.desig}</span>
        <span class="done-repo" title={ds.repoPath}>{repoBasename(ds.repoPath)}</span>
        {#if r?.state === "ready" && r.verdict}
          <span class="done-verdict" style:color={VERDICT_COLOR[r.verdict]}
            >{verdictLabel(r.verdict)}</span
          >
        {/if}
        <span class="done-ago"
          >{m.done_recap_finished({
            ago: formatAgo(nowMs - (ds.archivedAt ?? ds.updatedAt)),
          })}</span
        >
      </div>
      <span class="done-snippet">{r?.state === "ready" ? r.headline : ds.name || ds.prompt}</span>
    </button>
  {/each}
{/if}
{#if menu}
  <CardMenu
    x={menu.x}
    y={menu.y}
    resumable={false}
    opener={menu.opener}
    onbringback={bringBackFromMenu}
    onclose={() => (menu = null)}
  />
{/if}

<style>
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .empty {
    width: 100%;
    padding: 24px 14px;
    text-align: center;
    color: var(--color-faint);
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.12s ease;
  }
  .empty:hover {
    color: var(--color-ink);
  }
  .empty.static {
    cursor: default;
  }
  .empty.static:hover {
    color: var(--color-faint);
  }

  /* Done-lens row: a finished session, picked to show its recap in the main panel.
     Borrows the rail's row rhythm/tokens; selection mirrors UnitRow's .sel cue. */
  .done-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    text-align: left;
    border: 1px solid transparent;
    background: none;
    font-family: inherit;
    cursor: pointer;
    padding: 8px 10px;
    transition:
      border-color 0.12s ease,
      background 0.12s ease;
  }
  .done-row:hover {
    border-color: var(--color-line);
    background: var(--color-hover);
  }
  .done-row:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .done-row.sel {
    border-color: var(--color-line-bright);
    background: var(--color-sel);
  }
  .done-row-top {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .done-desig {
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .done-repo {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .done-verdict {
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }
  .done-ago {
    margin-left: auto;
    flex-shrink: 0;
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
  .done-snippet {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
