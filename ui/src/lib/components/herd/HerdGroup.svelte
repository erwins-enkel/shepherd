<script lang="ts">
  import type { Session, GitState, SessionActivity, HoldReason } from "$lib/types";
  import UnitRow from "../UnitRow.svelte";

  export type HerdRowCtx = {
    selectedId: string | null;
    nowMs: number;
    onselect: (id: string) => void;
    git: Record<string, GitState>;
    activity: Record<string, SessionActivity>;
    preview: Record<string, number | null>;
    previewServe: Record<string, "ok" | "failed">;
    onpreview?: (id: string) => void;
    ondecommission?: (id: string) => void;
    onrelaunch?: (id: string) => void;
    onrelaunchElsewhere?: (id: string) => void;
    onvariant?: (id: string, anchor: { x: number; y: number }) => void;
    onreplace?: (id: string, anchor: { x: number; y: number }) => void;
    repoFilter: string | null;
    onrepofilter?: (repoPath: string | null) => void;
    workingBlocked: Record<string, boolean>;
    quotaKindFor: (id: string) => "rework" | "review" | "error" | "plan" | null;
    // returns the hold reason for a session, or undefined if none
    holdFor: (id: string) => HoldReason | undefined;
    // acknowledge a session's manual operator steps, clearing its auto-merge gate (#1060)
    onackmanualsteps?: (id: string) => void;
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
    ctx: HerdRowCtx;
  };

  let {
    sessions,
    headClass = null,
    countLabel = null,
    aboveLabel = null,
    action = null,
    withPreview = false,
    ctx,
  }: HerdGroupProps = $props();
</script>

{#if headClass}
  <div class="{headClass} micro">
    {#if countLabel}{countLabel}{/if}
    {#if aboveLabel}<span class="above">{aboveLabel}</span>{/if}
    {#if action}
      <button
        type="button"
        class="{action.class} micro"
        title={action.title}
        onclick={action.onclick}>{action.label}</button
      >
    {/if}
  </div>
{/if}
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
    onrelaunch={ctx.onrelaunch}
    onrelaunchElsewhere={ctx.onrelaunchElsewhere}
    onvariant={ctx.onvariant}
    onreplace={ctx.onreplace}
    repoFilter={ctx.repoFilter}
    onrepofilter={ctx.onrepofilter}
    workingBlocked={ctx.workingBlocked}
    quotaKind={ctx.quotaKindFor(session.id)}
    hold={ctx.holdFor(session.id)}
    onackmanualsteps={ctx.onackmanualsteps}
  />
{/each}

<style>
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  /* amber section headers for the in-flight stages (PR CI running, critic
     reviewing) — amber mirrors the CI-pending dot and the critic badge */
  .ci-head,
  .reviewing-head,
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

  /* blue section header for the landed "merged PR" group */
  .merged-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-blue);
    border-top: 1px solid color-mix(in srgb, var(--color-blue) 30%, var(--color-line));
  }

  /* right-aligned action in the ready-to-merge group header */
  .merge-train {
    margin-left: auto;
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

  /* right-aligned bulk action in the merged group header */
  .clear-merged {
    margin-left: auto;
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
