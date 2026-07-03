<script lang="ts">
  import type { Epic } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { updateEpic, approveEpicNext, importEpic } from "$lib/api";
  import { chipFor, progress, stateLabel } from "./epic-panel";
  import { toasts } from "$lib/toasts.svelte";
  import EpicHandsOffIntro from "./EpicHandsOffIntro.svelte";

  let { repoPath, parent, epic }: { repoPath: string; parent: number; epic: Epic } = $props();

  const p = $derived(progress(epic.children));
  const running = $derived(epic.run.status === "running");
</script>

<div class="epic" role="region" aria-label={epic.parentTitle}>
  <EpicHandsOffIntro {repoPath} {parent} {epic} />

  <div class="epic-head">
    <span class="badge">{m.epic_progress({ merged: p.merged, total: p.total })}</span>
    {#if epic.source === "markdown"}
      <button
        class="gbtn"
        type="button"
        onclick={() =>
          importEpic(repoPath, parent).catch(() =>
            toasts.info(m.epic_import_failed(), {
              duration: null,
              alert: true,
              key: "epic-import-fail",
            }),
          )}
      >
        {m.epic_import()}
      </button>
    {/if}
  </div>

  <ul class="epic-children">
    {#each epic.children as c (c.number)}
      {@const chip = chipFor(c.state)}
      <li class="epic-child">
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
        <a class="num" href={c.url} target="_blank" rel="noopener noreferrer">#{c.number}</a>
        <span class="title">{c.title}</span>
        <span class="chip chip-{chip.tone}">{stateLabel(c.state)}</span>
        {#if c.state === "blocked" && c.blockedBy.length > 0}
          <span class="deps"
            >{m.epic_blocked_on({ deps: c.blockedBy.map((n) => `#${n}`).join(", ") })}</span
          >
        {/if}
      </li>
    {/each}
  </ul>

  {#if epic.warnings.length}
    <p class="warn">{m.epic_warnings({ count: epic.warnings.length })}</p>
  {/if}

  <div class="epic-controls">
    {#if running}
      <button
        class="gbtn"
        type="button"
        onclick={() =>
          updateEpic(repoPath, parent, { status: "paused" }).catch(() =>
            toasts.info(m.epic_update_failed(), {
              duration: null,
              alert: true,
              key: "epic-update-fail",
            }),
          )}
      >
        {m.epic_pause()}
      </button>
    {:else}
      <button
        class="gbtn"
        type="button"
        onclick={() =>
          updateEpic(repoPath, parent, { status: "running" }).catch(() =>
            toasts.info(m.epic_update_failed(), {
              duration: null,
              alert: true,
              key: "epic-update-fail",
            }),
          )}
      >
        {m.epic_start()}
      </button>
    {/if}

    <button
      class="gbtn"
      type="button"
      onclick={() =>
        updateEpic(repoPath, parent, {
          mode: epic.run.mode === "auto" ? "attended" : "auto",
        }).catch(() =>
          toasts.info(m.epic_update_failed(), {
            duration: null,
            alert: true,
            key: "epic-update-fail",
          }),
        )}
    >
      {epic.run.mode === "auto" ? m.epic_mode_auto() : m.epic_mode_attended()}
    </button>

    {#if epic.run.status === "running" || epic.run.status === "paused"}
      <button
        class="gbtn"
        type="button"
        onclick={() =>
          updateEpic(repoPath, parent, { status: "idle" }).catch(() =>
            toasts.info(m.epic_stop_failed(), {
              duration: null,
              alert: true,
              key: "epic-stop-fail",
            }),
          )}
      >
        {m.epic_stop()}
      </button>
    {/if}

    {#if epic.run.mode === "attended" && running}
      <button
        class="gbtn primary"
        type="button"
        onclick={() =>
          approveEpicNext(repoPath, parent).catch(() =>
            toasts.info(m.epic_approve_failed(), {
              duration: null,
              alert: true,
              key: "epic-approve-fail",
            }),
          )}
      >
        {m.epic_approve_next()}
      </button>
    {/if}
  </div>
</div>

<style>
  /* ── layout ─────────────────────────────────────────────────────────────── */
  .epic {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--color-panel);
    border-top: 1px solid var(--color-line);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }

  .epic-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  /* ── child list ─────────────────────────────────────────────────────────── */
  .epic-children {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 40vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
  }

  .epic-child {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }

  .num {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    text-decoration: none;
    flex-shrink: 0;
  }

  .num:hover {
    color: var(--color-ink-bright);
    text-decoration: underline;
  }

  .title {
    flex: 1;
    min-width: 0;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── state chips ─────────────────────────────────────────────────────────
     Token mapping (all per app.css — NO literals):
       done     = --status-done    (=--color-slate) : merged/finished-parked, per house rule
       ready    = --color-green                     : genuinely actionable-complete
       running  = --status-running (=--color-amber) : in-progress
       review   = --color-blue                      : in-review (no --status-review token exists)
       muted    = --color-muted                     : blocked (quiet/deprioritised)
  ──────────────────────────────────────────────────────────────────────── */
  .chip {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 2px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .chip-done {
    color: var(--status-done);
    background: color-mix(in oklab, var(--status-done) 12%, transparent);
  }

  .chip-ready {
    color: var(--color-green);
    background: color-mix(in oklab, var(--color-green) 12%, transparent);
  }

  .chip-running {
    color: var(--status-running);
    background: color-mix(in oklab, var(--status-running) 15%, transparent);
  }

  .chip-review {
    color: var(--color-blue);
    background: color-mix(in oklab, var(--color-blue) 12%, transparent);
  }

  .chip-muted {
    color: var(--color-muted);
    background: color-mix(in oklab, var(--color-muted) 10%, transparent);
  }

  /* ── blocker deps + warnings ─────────────────────────────────────────── */
  .deps {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    flex-basis: 100%;
    padding-left: calc(var(--fs-meta) + 12px); /* indent under title */
  }

  .warn {
    margin: 0;
    color: var(--color-amber);
    font-size: var(--fs-micro);
  }

  /* ── controls ────────────────────────────────────────────────────────── */
  .epic-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding-top: 2px;
  }

  /* .gbtn and .gbtn.primary are global recipes from the design system;
     they are defined app-wide (see /design-system) and work without local
     duplication. */
</style>
