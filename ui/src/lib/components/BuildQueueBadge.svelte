<script lang="ts">
  import { buildQueues } from "$lib/buildQueues.svelte";
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { statusTip } from "$lib/tooltips/statusTip.svelte";
  import { buildQueueCollapse } from "$lib/build-queue-collapse.svelte";
  import type { Session, GitState } from "$lib/types";

  // `tip` (Herd card only): swap the native title for the styled statusTip tooltip.
  let {
    sessionId,
    interactive = true,
    planPhase,
    git,
    selected,
    onselect,
    tip = false,
  }: {
    sessionId: string;
    // D4 (docs/design/mobile-herd): on a coarse pointer this badge is a READ-ONLY readout,
    // not a tap target. Its ~15px box cannot meet iOS HIG 44x44, and five of them stack in one
    // card — inflating them would push the card past 200px. The action moves to the detail
    // screen, which the card tap already opens. Default true leaves desktop untouched.
    interactive?: boolean;
    planPhase: Session["planPhase"];
    git?: GitState;
    selected: boolean;
    onselect: (id: string) => void;
    tip?: boolean;
  } = $props();

  const queue = $derived(buildQueues.map[sessionId] ?? null);
  const total = $derived(queue?.steps.length ?? 0);
  const resolved = $derived(
    queue?.steps.filter((s) => s.status === "done" || s.status === "skipped").length ?? 0,
  );
  const pct = $derived(total > 0 ? (resolved / total) * 100 : 0);

  // "Working but unreported": the agent is past planning (or has an open PR
  // already up, which only happens mid/post-implementation) yet EVERY step
  // still sits at `pending` — none active, none done/skipped — so the agent
  // isn't posting step status at all. Note this requires *all* steps pending,
  // not merely "some": a queue with real (partial) resolved/total progress
  // (e.g. 4/5) is normal progress, not a stale/unreported queue, even though
  // one step remains pending.
  const prPresent = $derived(git?.state === "open");
  const working = $derived(planPhase !== "planning" || prPresent);
  const drifted = $derived(
    (queue?.approved ?? false) &&
      total > 0 &&
      (queue?.steps.every((s) => s.status === "pending") ?? false) &&
      working,
  );
  const expanded = $derived(selected && !buildQueueCollapse.collapsed);
  const actionLabel = $derived(
    expanded ? m.buildqueue_collapse_aria() : m.buildqueue_expand_aria(),
  );
  const contentId = $derived(`bqp-content-${sessionId}`);

  function activate(e: MouseEvent) {
    e.stopPropagation();
    if (selected) {
      buildQueueCollapse.toggle();
      return;
    }
    onselect(sessionId);
    buildQueueCollapse.set(false);
  }
</script>

{#if total > 0}
  {#if !interactive}
    <!-- D4: coarse pointer — read-only readout; the queue panel opens from the detail screen. -->
    <span
      class="queue-badge"
      class:queue-badge--stale={drifted}
      style={drifted ? undefined : `--queue-pct: ${pct}%`}
      role="img"
      aria-label={drifted
        ? m.queuebadge_stale_aria({ total })
        : m.queuebadge_aria({ resolved, total })}
      title={tip
        ? undefined
        : drifted
          ? m.queuebadge_stale_title({ total })
          : m.queuebadge_title({ resolved, total })}
      use:statusTip={tip
        ? {
            text: drifted
              ? m.queuebadge_stale_title({ total })
              : m.queuebadge_title({ resolved, total }),
          }
        : null}
    >
      <span class="queue-label"
        >{drifted ? `⚠ ${total}` : m.queuebadge_label({ resolved, total })}</span
      >
    </span>
  {:else if drifted}
    <button
      type="button"
      class="queue-badge queue-badge--stale"
      onclick={activate}
      title={tip ? undefined : m.queuebadge_stale_title({ total })}
      aria-expanded={expanded}
      aria-controls={selected ? contentId : undefined}
      aria-label={`${actionLabel}. ${m.queuebadge_stale_aria({ total })}`}
      use:coachTarget={"build-queue-progress"}
      use:statusTip={tip
        ? { text: m.queuebadge_stale_title({ total }), stopClickPropagation: false }
        : null}
    >
      <span class="queue-label">⚠ {total}</span>
    </button>
  {:else}
    <button
      type="button"
      class="queue-badge"
      style="--queue-pct: {pct}%"
      onclick={activate}
      title={tip ? undefined : m.queuebadge_title({ resolved, total })}
      aria-expanded={expanded}
      aria-controls={selected ? contentId : undefined}
      aria-label={`${actionLabel}. ${m.queuebadge_aria({ resolved, total })}`}
      use:coachTarget={"build-queue-progress"}
      use:statusTip={tip
        ? { text: m.queuebadge_title({ resolved, total }), stopClickPropagation: false }
        : null}
    >
      <span class="queue-label">{m.queuebadge_label({ resolved, total })}</span>
    </button>
  {/if}
{/if}

<style>
  /* Single-row badge matching its siblings (PREVIEW / REWORK / status badges):
     same outline idiom, same height. Progress is shown as a subtle amber wash
     filling the badge box left→right to --queue-pct (hard-edged gradient stop),
     so there's no extra meter row to make this badge taller than the others. */
  .queue-badge {
    display: inline-flex;
    align-items: center;
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 600;
    font-family: inherit;
    margin: 0;
    padding: 1px 6px;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    white-space: nowrap;
    overflow: hidden;
    cursor: pointer;
    background: linear-gradient(
      to right,
      color-mix(in srgb, var(--color-amber) 22%, transparent) var(--queue-pct),
      transparent var(--queue-pct)
    );
  }

  .queue-badge:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* STALE (drifted): agent is working but hasn't posted step status, so every
     step still reads `pending`. A left-fill wash at 0% would look identical to
     "nothing started" — actively misleading — so this state drops --queue-pct
     entirely in favor of a moving diagonal stripe: same amber hue (still
     "attention", never red/green), but a texture that reads as "unknown/in
     motion" rather than a measured 0%. */
  .queue-badge--stale {
    background: repeating-linear-gradient(
      -45deg,
      color-mix(in srgb, var(--color-amber) 22%, transparent) 0,
      color-mix(in srgb, var(--color-amber) 22%, transparent) 4px,
      transparent 4px,
      transparent 8px
    );
    animation: queue-badge-stale-scroll 1.2s linear infinite;
  }

  @keyframes queue-badge-stale-scroll {
    from {
      background-position: 0 0;
    }
    to {
      background-position: 16px 0;
    }
  }
</style>
