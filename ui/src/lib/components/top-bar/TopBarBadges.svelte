<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import type { UpdateStatus, HerdrUpdateStatus, DiagnosticState } from "$lib/types";

  let {
    compactBadges,
    updateAvailable,
    update,
    onupdate,
    herdrUpdateAvailable,
    herdrUpdate,
    onherdrupdate,
    whatsNew,
    onwhatsnew,
    diagnosticsOverall,
    ondiagnose,
    learningsPresent,
    learnings,
    learningsCurate,
    learningsTip,
    learningsLabel,
    learningsCount,
    onlearnings,
  }: {
    compactBadges: boolean;
    updateAvailable: boolean;
    update: UpdateStatus | null;
    onupdate: (() => void) | undefined;
    herdrUpdateAvailable: boolean;
    herdrUpdate: HerdrUpdateStatus | null;
    onherdrupdate: (() => void) | undefined;
    whatsNew: boolean;
    onwhatsnew: (() => void) | undefined;
    diagnosticsOverall: DiagnosticState;
    ondiagnose: (() => void) | undefined;
    learningsPresent: boolean;
    learnings: number;
    learningsCurate: number;
    learningsTip: string;
    learningsLabel: string;
    learningsCount: number;
    onlearnings: (() => void) | undefined;
  } = $props();
</script>

{#if updateAvailable}
  <button
    class="update-badge"
    onclick={() => onupdate?.()}
    title="{update!.behind} {update!.behind === 1
      ? m.updatemodal_commits_one()
      : m.updatemodal_commits_other()}"
  >
    <svg
      class="up-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
    </svg>
    {#if !compactBadges}<span class="up-label">{m.topbar_update_badge()}</span>{/if}
    <span class="up-n">{update!.behind}</span>
  </button>
{/if}
<!-- Desktop keeps the inline HERDR badge; on a phone it folds into the gear
     bottom sheet to free a slot in the single-row control cluster. The
     touch-desktop badge crunch drops the label to a bare ▲ (aria-label keeps
     it named) so two stacked update badges still fit. -->
{#if herdrUpdateAvailable}
  <button
    class="update-badge herdr"
    onclick={() => onherdrupdate?.()}
    aria-label={m.topbar_herdr_update_badge()}
    title={m.topbar_herdr_update_title({
      current: herdrUpdate!.current ?? "?",
      latest: herdrUpdate!.latest ?? "?",
    })}
  >
    <span class="up-dot">▲</span>
    {#if !compactBadges}<span class="up-label">{m.topbar_herdr_update_badge()}</span>{/if}
  </button>
{/if}
{#if whatsNew}
  <!-- Desktop: labelled button with hover-tip; touch-desktop multi-badge crunch
       collapses to dot-only to avoid crowding the control cluster. On mobile,
       What's New moves into the gear bottom sheet. -->
  {#if !compactBadges}
    <button
      class="whatsnew-badge tip"
      type="button"
      onclick={() => onwhatsnew?.()}
      data-tip={m.whatsnew_open()}
      aria-label={m.whatsnew_topbar_aria()}
    >
      <span class="wn-dot" aria-hidden="true">●</span>
      <span class="wn-label">{m.whatsnew_open()}</span>
    </button>
  {:else}
    <button
      class="whatsnew-dot-btn"
      type="button"
      onclick={() => onwhatsnew?.()}
      aria-label={m.whatsnew_topbar_aria()}><span class="wn-pip" aria-hidden="true"></span></button
    >
  {/if}
{/if}
<!-- Health pip: visible ONLY when diagnosticsOverall !== "ok" AND not mobile
     (on mobile it moves into the gear bottom sheet).
     Own slot left of the gear-wrap so it never overlaps the halt-pip (gear top-right).
     Color: slate ring with state-colored core —
     warn for warning, red for error — distinct from both the halt-pip identity
     and the herdr blue. Token choice: --status-warn / --color-red for the core,
     --color-line-bright for the ring. Never --color-green (hidden when ok anyway). -->
{#if diagnosticsOverall !== "ok"}
  <button
    class="health-pip tip"
    class:alert={diagnosticsOverall === "error"}
    type="button"
    onclick={() => ondiagnose?.()}
    data-tip={m.diagnostics_pip_label()}
    aria-label={m.diagnostics_pip_label()}
    use:coachTarget={"diagnostics"}
  >
    <span class="health-dot" aria-hidden="true"></span>
  </button>
{/if}
<!-- ✦ LEARNINGS: global entry point to review proposed house rules across all repos.
     Desktop-only badge (mobile folds into the gear bottom sheet). Stays off status
     hues — ✦ is neutral chrome, not an attention state (Four-Light Rule). -->
{#if learningsPresent}
  <button
    class="learnings-btn"
    class:compact={compactBadges}
    type="button"
    onclick={() => onlearnings?.()}
    title={learningsTip}
    aria-label={learnings > 0
      ? m.learnings_open_aria({ count: learnings })
      : m.learnings_open_curate_aria({ count: learningsCurate })}
  >
    <span class="learn-glyph" aria-hidden="true">✦</span>
    {#if !compactBadges}<span class="learn-label">{learningsLabel}</span>{/if}
    <span class="learn-n">{learningsCount}</span>
  </button>
{/if}

<style>
  .update-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    background: color-mix(in srgb, var(--color-amber) 14%, transparent);
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    border-radius: 2px;
    animation: update-pulse 2.4s ease-in-out infinite;
  }
  .update-badge .up-glyph {
    width: 1.15em;
    height: 1.15em;
    display: block;
    flex-shrink: 0;
  }
  .update-badge .up-dot {
    font-size: var(--fs-micro);
  }
  .update-badge .up-n {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }
  /* herdr badge: informational (operator updates manually), so it reads as calm
     blue — the informational accent — and doesn't pulse like the actionable
     self-update badge */
  .update-badge.herdr {
    background: color-mix(in srgb, var(--color-blue) 14%, transparent);
    border-color: var(--color-blue);
    color: var(--color-blue);
    animation: none;
  }
  @keyframes update-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-amber) 40%, transparent);
    }
    50% {
      box-shadow: 0 0 0 4px transparent;
    }
  }
  /* What's New affordance — blue informational accent (shared with the herdr cue),
     distinct from amber (app-update). */
  .whatsnew-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    background: color-mix(in srgb, var(--color-blue) 14%, transparent);
    border: 1px solid var(--color-blue);
    color: var(--color-blue);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    border-radius: 2px;
  }
  .whatsnew-badge:hover {
    background: color-mix(in srgb, var(--color-blue) 22%, transparent);
  }
  .whatsnew-badge .wn-dot {
    font-size: var(--fs-micro);
  }
  /* Phone-only: bare pip button, no label. */
  .whatsnew-dot-btn {
    position: relative;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 5px 8px;
    border-radius: 2px;
    cursor: pointer;
    min-height: 44px;
    min-width: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .wn-pip {
    display: block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--color-blue);
    box-shadow: 0 0 0 2px var(--color-panel);
  }
  /* Health pip: a standalone button placed left of the gear-wrap in .rightside.
     Visible only when diagnosticsOverall !== "ok" (hidden-when-OK via {#if}).
     Ring: --color-line-bright (neutral slate) — a quiet outline that doesn't
     read as the halt-pip or the herdr dot.
     Core: --status-warn (warning) or --color-red (error, .alert). */
  .health-pip {
    position: relative;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 50%;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    padding: 0;
  }
  .health-pip:hover {
    border-color: var(--color-muted);
  }
  .health-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--status-warn);
    display: block;
  }
  .health-pip.alert .health-dot {
    background: var(--color-red);
  }
  .learnings-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    padding: 5px 10px;
    border-radius: 2px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .learnings-btn:hover {
    color: var(--color-ink);
    border-color: var(--color-ink);
  }
  .learnings-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-ink);
  }
  .learn-glyph {
    font-size: var(--fs-lg);
    line-height: 1;
  }
  /* Compact: icon-only, ≥44px tap target. */
  .learnings-btn.compact {
    justify-content: center;
    min-width: 44px;
    padding: 8px 10px;
    letter-spacing: 0;
  }
  .learn-n {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }

  /* Coarse pointers (touch, any layout width): secondary icon buttons need ≥44px hit area. */
  @media (pointer: coarse) {
    .update-badge,
    .learnings-btn {
      min-height: 44px;
      min-width: 44px;
    }
  }

  /* Desktop-only hover tooltips — never shown on touch / mobile devices. */
  @media (hover: hover) and (pointer: fine) {
    .tip {
      position: relative;
    }
    .tip::after {
      content: attr(data-tip);
      position: absolute;
      top: calc(100% + 9px);
      right: 0;
      white-space: nowrap;
      background: var(--color-panel);
      border: 1px solid var(--color-line-bright);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      color: var(--color-ink-bright);
      font-size: var(--fs-meta);
      letter-spacing: 0.06em;
      text-transform: none;
      padding: 5px 9px;
      border-radius: 2px;
      pointer-events: none;
      opacity: 0;
      transform: translateY(-3px);
      transition:
        opacity 0.12s ease,
        transform 0.12s ease;
      z-index: 50;
    }
    .tip:hover::after,
    .tip:focus-visible::after {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
