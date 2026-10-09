<script lang="ts">
  import type { DrainRunSummary, Epic } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { importEpic } from "#lib/api.js";
  import { chipFor, progress, slotHeldBy, stateLabel } from "./epic-panel";
  import { childDuration } from "#lib/epic-timing-detail.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import EpicHandsOffIntro from "./EpicHandsOffIntro.svelte";
  import EpicDiagnosisModal from "./EpicDiagnosisModal.svelte";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";

  // An epic's children and structural warnings. Its run controls (state, Start/Pause, mode,
  // CLI/model/effort) live in the detail's run area, EpicRunControl (#2620).
  let {
    repoPath,
    parent,
    epic,
    runSummary = null,
    headActions = true,
    nowMs = Date.now(),
  }: {
    repoPath: string;
    parent: number;
    epic: Epic;
    /** The repo's run picture — marks the child holding an agent slot. */
    runSummary?: DrainRunSummary | null;
    /** Render Import + Diagnose in the head. False when the host (the backlog reading
     *  detail, #2617) offers them in its own ⋯ menu instead. */
    headActions?: boolean;
    /** The host's tick — a running step's clock runs on it (#2939). */
    nowMs?: number;
  } = $props();

  const p = $derived(progress(epic.children));
  const readyCount = $derived(epic.children.filter((c) => c.state === "ready").length);
  // A DAUER column (#2939) once the server sends the epic clock.
  const timed = $derived(epic.timing != null);

  let showDiag = $state(false);
</script>

<div class="epic" role="region" aria-label={epic.parentTitle}>
  <EpicHandsOffIntro {repoPath} {parent} {epic} />

  <div class="epic-head">
    <span class="badge">{m.epic_progress({ merged: p.merged, total: p.total })}</span>
    {#if headActions && epic.source === "markdown"}
      <button
        class="gbtn"
        type="button"
        onclick={() =>
          importEpic(repoPath, parent).catch(() =>
            toasts.info(m.epic_import_failed(), {
              alert: true,
              key: "epic-import-fail",
            }),
          )}
      >
        {m.epic_import()}
      </button>
    {/if}
    {#if headActions}
      <button
        class="gbtn"
        type="button"
        use:coachTarget={"epic-diagnose"}
        title={m.epic_diag_open_title()}
        onclick={() => (showDiag = true)}
      >
        {m.epic_diag_open()}
      </button>
    {/if}
    {#if timed}<span class="dur-head">{m.epicdetail_col_duration()}</span>{/if}
  </div>

  <ul class="epic-children">
    {#each epic.children as c (c.number)}
      {@const chip = chipFor(c.state)}
      {@const slot = slotHeldBy(runSummary, c.number)}
      <li class="epic-child">
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
        <a class="num" href={c.url} target="_blank" rel="noopener noreferrer">#{c.number}</a>
        <span class="title">{c.title}</span>
        <span class="chip chip-{chip.tone}">{stateLabel(c.state)}</span>
        {#if slot}
          <span class="slot">{m.epic_slot_held({ index: slot.index, max: slot.max })}</span>
        {/if}
        {#if timed}
          {@const d = childDuration(c, epic, nowMs)}
          <span class="dur dur-{d?.tone ?? 'none'}">
            {#if d?.clock}<span class="dur-clock">{d.clock}</span>{/if}{d?.clock && d.text
              ? ` · ${d.text}`
              : (d?.text ?? "")}
          </span>
        {/if}
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

  {#if epic.noDependencyEdges}
    <p class="warn">{m.epic_warn_no_deps({ count: readyCount })}</p>
  {/if}
</div>

{#if showDiag}
  <EpicDiagnosisModal {repoPath} {parent} onclose={() => (showDiag = false)} />
{/if}

<style>
  /* ── layout ─────────────────────────────────────────────────────────────── */
  .epic {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--color-panel);
    /* No border-top: the host ([data-epic-panel]) owns the single head↔children
       divider, so it also covers the pre-resolve loading line. */
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
  /* A leading rail marks these rows as the epic's CHILDREN, separating them from
     their siblings on the same panel surface (.epic-head's progress/import/diagnose
     above, the warnings below). Mirrors the same cue on the herd's epic groups
     (HerdEpicGroups.svelte). The rail sits on the scroll container, so it stays put
     while a long child list scrolls under it — intended. */
  .epic-children {
    margin: 0;
    padding: 0 0 0 8px;
    border-left: 1px solid color-mix(in srgb, var(--status-running) 30%, var(--color-line));
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

  /* A basis, so a narrow row wraps its DAUER cell instead of crushing the title. */
  .title {
    flex: 1 1 12ch;
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

  /* "holds slot i/m" (#2620): neutral, like the run area's role badges — the state chip
     beside it already carries the status color. */
  .slot {
    flex-shrink: 0;
    padding: 0 5px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  /* ── DAUER (#2939) ──────────────────────────────────────────────────────
     Merged: the measured time, bright; running: its clock amber, what is left muted; the rest
     the step estimate, muted. A fixed width keeps the chips in line. */
  .dur-head {
    margin-left: auto;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .dur {
    flex: none;
    min-width: 22ch;
    margin-left: auto;
    color: var(--color-muted);
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .dur-done {
    color: var(--color-ink-bright);
  }
  .dur-clock {
    color: var(--status-running);
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

  /* ── progress badge ──────────────────────────────────────────────────────
     Neutral pill for the "{merged}/{total} merged" head count — token-only,
     mirrors the .label-chip / .chip recipe used elsewhere. */
  .badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 5px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ── buttons ─────────────────────────────────────────────────────────────
     Canonical .gbtn recipe from /design-system. Copied into this component's
     scoped style because Svelte scopes styles per-component and there is no
     global .gbtn in app.css — every sibling that uses .gbtn duplicates it here
     the same way. Without this the controls render as bare unstyled text. */
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
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Condition mirrors the global mobile control branch in app.css — phone
     landscape is short-wide, so a width-only query would leave these controls
     desktop-sized while app.css had already bumped their font to 16px. */
  @media (max-width: 768px), (max-height: 600px) {
    /* 44px is the tap-target floor. */
    .gbtn {
      min-height: 44px;
      padding: 2px 14px;
    }
  }
</style>
