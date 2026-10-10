<script lang="ts">
  import { buildQueues } from "#lib/buildQueues.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { buildQueueCollapse } from "#lib/build-queue-collapse.svelte.js";
  import type { Session, GitState } from "#lib/types.js";

  // `tip` (Herd card only): swap the native title for the styled statusTip tooltip.
  let {
    sessionId,
    interactive = true,
    planPhase,
    git,
    selected,
    onselect,
    tip = false,
    hideWhenStepLive = false,
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
    /** The card's activity line already reads "Step N/M" off this same queue — say it once.
     *  Hides the badge unless the queue is drifted, the one state the line can't show. */
    hideWhenStepLive?: boolean;
  } = $props();

  const queue = $derived(buildQueues.map[sessionId] ?? null);
  const total = $derived(queue?.steps.length ?? 0);
  const resolved = $derived(
    queue?.steps.filter((s) => s.status === "done" || s.status === "skipped").length ?? 0,
  );
  const pct = $derived(total > 0 ? (resolved / total) * 100 : 0);
  // One cell per step reads at a glance up to a dozen; past that the cells get too small to
  // count, so the meter becomes one proportional bar.
  const MAX_CELLS = 12;

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

{#snippet meter()}
  <span class="queue-key">{m.queuebadge_meter_label()}</span>
  {#if total <= MAX_CELLS}
    <span class="queue-cells" aria-hidden="true"
      >{#each { length: total }, i (i)}<i class:on={!drifted && i < resolved}></i>{/each}</span
    >
  {:else}
    <span class="queue-bar" aria-hidden="true"><i style="width: {drifted ? 0 : pct}%"></i></span>
  {/if}
  <span class="queue-label">{drifted ? `⚠ ${total}` : m.queuebadge_label({ resolved, total })}</span
  >
{/snippet}

{#if total > 0 && !(hideWhenStepLive && !drifted)}
  {#if !interactive}
    <!-- D4: coarse pointer — read-only readout; the queue panel opens from the detail screen. -->
    <span
      class="queue-badge"
      class:queue-badge--stale={drifted}
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
      {@render meter()}
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
      {@render meter()}
    </button>
  {:else}
    <button
      type="button"
      class="queue-badge"
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
      {@render meter()}
    </button>
  {/if}
{/if}

<style>
  /* A segment of the card's telemetry strip: a faint key, a segment meter (one cell per step,
     amber = resolved) and the count. No box of its own — the strip's dividers separate it. */
  .queue-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-family: inherit;
    line-height: inherit;
    margin: 0;
    padding: 0;
    border: 0;
    color: var(--color-muted);
    white-space: nowrap;
    cursor: pointer;
    background: transparent;
  }
  span.queue-badge {
    cursor: default;
  }
  .queue-badge:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 1px;
  }
  .queue-key {
    color: var(--color-faint);
  }
  .queue-cells {
    display: inline-flex;
    gap: 2px;
  }
  .queue-cells i {
    width: 4px;
    height: 7px;
    background: var(--color-line-bright);
  }
  .queue-cells i.on {
    background: var(--color-amber);
  }
  .queue-bar {
    position: relative;
    width: 48px;
    height: 7px;
    background: var(--color-line-bright);
  }
  .queue-bar i {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--color-amber);
  }
  /* STALE (drifted): the agent is working but hasn't posted step status, so every step still
     reads `pending`. Empty cells alone would look identical to "nothing started" — actively
     misleading — so the cells go hollow (unknown, not measured-zero) and the count turns into
     an amber ⚠ total. */
  .queue-badge--stale .queue-cells i,
  .queue-badge--stale .queue-bar {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }
  .queue-badge--stale .queue-label {
    color: var(--color-amber);
  }
</style>
