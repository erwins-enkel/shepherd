<script lang="ts">
  import type { Session, GitState, SessionActivity, HoldReason, LivenessState } from "$lib/types";
  import UnitRow from "../UnitRow.svelte";
  import InfoTip from "../InfoTip.svelte";

  export type HerdRowCtx = {
    selectedId: string | null;
    nowMs: number;
    onselect: (id: string) => void;
    git: Record<string, GitState>;
    activity: Record<string, SessionActivity>;
    preview: Record<string, number | null>;
    previewServe: Record<string, "ok" | "failed">;
    onpreview?: (id: string, target?: "inline" | "tab") => void;
    ondecommission?: (id: string) => void;
    onrename?: (id: string) => void;
    onrelaunch?: (id: string) => void;
    onrelaunchElsewhere?: (id: string) => void;
    onvariant?: (id: string, anchor: { x: number; y: number }) => void;
    onreplace?: (id: string, anchor: { x: number; y: number }) => void;
    repoFilter: ReadonlySet<string>;
    onrepofilter?: (repoPath: string, additive: boolean) => void;
    workingBlocked: Record<string, boolean>;
    liveness: Record<string, LivenessState>;
    quotaKindFor: (id: string) => "rework" | "review" | "error" | "plan" | null;
    // returns the hold reason for a session, or undefined if none
    holdFor: (id: string) => HoldReason | undefined;
    // acknowledge a session's manual operator steps, clearing its auto-merge gate (#1060)
    onackmanualsteps?: (id: string) => void;
    // manual-steps chip -> Owed lens (#1275)
    onshowowed?: (id: string) => void;
  };

  type ActionDef = {
    class: string;
    title: string;
    label: string;
    onclick: () => void;
  };

  type HerdGroupProps = {
    sessions: Session[];
    headClass?: string | null;
    countLabel?: string | null;
    aboveLabel?: string | null;
    action?: ActionDef | null;
    withPreview?: boolean;
    // Optional stage explainer: a right-aligned "i" that opens a tooltip describing what
    // this lifecycle stage means, what Shepherd does automatically, and what happens next.
    help?: { text: string; label: string } | null;
    collapsible?: boolean;
    expanded?: boolean;
    ontoggle?: () => void;
    // coarse-pointer/touch input: keeps the 44px touch-target sizing on the header
    // toggle + its actions. False on fine-pointer desktop, where headers stay compact.
    touchTarget?: boolean;
    ctx: HerdRowCtx;
  };

  let {
    sessions,
    headClass = null,
    countLabel = null,
    aboveLabel = null,
    action = null,
    withPreview = false,
    help = null,
    collapsible = false,
    expanded = true,
    ontoggle = undefined,
    touchTarget = false,
    ctx,
  }: HerdGroupProps = $props();
</script>

{#if headClass}
  <div class="{headClass} micro" class:collapsible class:touch={touchTarget}>
    {#if collapsible}
      <button class="group-toggle" type="button" aria-expanded={expanded} onclick={ontoggle}>
        <span class="chev" class:collapsed={!expanded} aria-hidden="true">▾</span>
        {#if countLabel}<span>{countLabel}</span>{/if}
        {#if aboveLabel}<span class="above">{aboveLabel}</span>{/if}
      </button>
    {:else}
      {#if countLabel}{countLabel}{/if}
      {#if aboveLabel}<span class="above">{aboveLabel}</span>{/if}
    {/if}
    {#if action || help}
      <!-- right-aligned cluster: the optional bulk action, then the stage-explainer "i"
           (kept rightmost for a consistent target across every header). -->
      <span class="head-right">
        {#if action}
          <button
            type="button"
            class="{action.class} micro"
            title={action.title}
            onclick={action.onclick}>{action.label}</button
          >
        {/if}
        {#if help}
          <InfoTip text={help.text} label={help.label} prominent />
        {/if}
      </span>
    {/if}
  </div>
{/if}
{#if !collapsible || expanded}
  {#each sessions as session (session.id)}
    <UnitRow
      {session}
      selected={session.id === ctx.selectedId}
      nowMs={ctx.nowMs}
      onselect={ctx.onselect}
      git={ctx.git[session.id]}
      activity={ctx.activity[session.id]}
      previewPort={withPreview ? (ctx.preview[session.id] ?? null) : null}
      previewServeFailed={withPreview ? ctx.previewServe[session.id] === "failed" : false}
      onpreview={withPreview ? ctx.onpreview : undefined}
      ondecommission={ctx.ondecommission}
      onrename={ctx.onrename}
      onrelaunch={ctx.onrelaunch}
      onrelaunchElsewhere={ctx.onrelaunchElsewhere}
      onvariant={ctx.onvariant}
      onreplace={ctx.onreplace}
      repoFilter={ctx.repoFilter}
      onrepofilter={ctx.onrepofilter}
      workingBlocked={ctx.workingBlocked}
      liveness={ctx.liveness[session.id]}
      quotaKind={ctx.quotaKindFor(session.id)}
      hold={ctx.holdFor(session.id)}
      onackmanualsteps={ctx.onackmanualsteps}
      onshowowed={ctx.onshowowed}
    />
  {/each}
{/if}

<style>
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  /* 44px touch targets are keyed to input modality (.touch = phone layout or a
     coarse-pointer wide device), not to collapsibility — fine-pointer desktop
     headers stay at their compact height. */
  .micro.collapsible.touch {
    min-height: 44px;
    padding-block: 0;
  }

  .group-toggle {
    display: flex;
    align-items: center;
    align-self: stretch;
    gap: 7px;
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    text-align: left;
    cursor: pointer;
  }
  .touch .group-toggle {
    min-height: 44px;
  }
  .group-toggle:hover {
    background: var(--color-hover);
  }
  .group-toggle:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .chev {
    flex: none;
    transition: transform 0.12s ease;
  }
  .chev.collapsed {
    transform: rotate(-90deg);
  }

  /* amber section headers for the in-flight stages (PR CI running, critic
     reviewing) — amber mirrors the CI-pending dot and the critic badge */
  .ci-head,
  .reviewing-head,
  .rework-head,
  .merging-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-amber);
    border-top: 1px solid color-mix(in srgb, var(--color-amber) 30%, var(--color-line));
  }

  /* red section header for an open PR whose CI failed — done but needs a look */
  .ci-failed-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-red);
    border-top: 1px solid color-mix(in srgb, var(--color-red) 30%, var(--color-line));
  }

  /* slate section header for a green-CI draft PR awaiting human sign-off —
     parked but NOT actionable (must never read as the green "Your turn" state) */
  .draft-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-slate);
    border-top: 1px solid color-mix(in srgb, var(--color-slate) 30%, var(--color-line));
  }

  /* green section headers for the "waiting for a human to merge" stages:
     auto-detected (open PR, CI green) and operator-parked "ready to merge" */
  .awaiting-head,
  .ready-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-green);
    border-top: 1px solid color-mix(in srgb, var(--color-green) 30%, var(--color-line));
  }

  /* slate section header for "waiting on someone else" (a foreign reviewer/merger):
     NOT the operator's turn, so it must read as parked, not actionable-green. */
  .waiting-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-slate);
    border-top: 1px solid color-mix(in srgb, var(--color-slate) 30%, var(--color-line));
  }

  .needs-rework-head,
  .branch-blocked-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-amber);
    border-top: 1px solid color-mix(in srgb, var(--color-amber) 30%, var(--color-line));
  }

  /* blue section header for the landed "merged PR" group */
  .merged-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-blue);
    border-top: 1px solid color-mix(in srgb, var(--color-blue) 30%, var(--color-line));
  }

  /* right-aligned cluster holding the optional bulk action + the stage-explainer "i".
     Owns the `margin-left:auto` so the action buttons no longer need their own. */
  .head-right {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  /* right-aligned action in the ready-to-merge group header */
  .merge-train {
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    padding: 0 2px;
    color: color-mix(in srgb, var(--color-green) 70%, var(--color-faint));
    transition: color 0.12s ease;
  }
  .merge-train:hover {
    color: var(--color-green);
  }
  .merge-train:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .collapsible.touch .merge-train,
  .collapsible.touch .clear-merged {
    align-self: stretch;
    min-height: 44px;
    padding-inline: 8px;
  }

  /* right-aligned bulk action in the merged group header */
  .clear-merged {
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    padding: 0 2px;
    color: color-mix(in srgb, var(--color-blue) 70%, var(--color-faint));
    transition: color 0.12s ease;
  }
  .clear-merged:hover {
    color: var(--color-blue);
  }
  .clear-merged:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* "N in epics above" — a quiet annotation beside a section count when that
     stage's rows live in epic groups above the lifecycle list. */
  .above {
    color: var(--color-faint);
  }
</style>
