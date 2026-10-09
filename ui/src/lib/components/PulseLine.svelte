<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { Pulse } from "#lib/session-pulse.js";
  import { pulseLabel } from "#lib/pulse-text.js";

  // The card's "now" line: the session's progress verdict in one glance — what it is doing or
  // waiting on, how long against the usual, and whether Shepherd is re-steering in circles.
  // Purely presentational; the verdict comes from session-pulse.ts. Renders nothing for null.
  let { pulse, id }: { pulse: Pulse | null; id: string } = $props();

  const min = (ms: number) => Math.max(0, Math.round(ms / 60_000));

  function metricOf(p: Pulse, timed: boolean): string {
    const job = p.job;
    if (timed && job?.typicalMs)
      return m.pulse_minutes_of({ elapsed: min(job.elapsedMs!), typical: min(job.typicalMs) });
    if (timed) return m.pulse_minutes({ elapsed: min(job!.elapsedMs!) });
    if (p.state === "looping") return m.pulse_ci_fix_count({ count: p.ciFixRun });
    if (p.step) return m.pulse_step_of({ index: p.step.index, total: p.step.total });
    return "";
  }

  function detailOf(p: Pulse): string {
    if (p.state === "working") return p.step?.title ?? "";
    if (p.state === "needs_you") return "";
    const green = p.total ? m.pulse_green_of({ green: p.green, total: p.total }) : "";
    return [p.job?.short, green].filter(Boolean).join(" · ");
  }

  const view = $derived.by(() => {
    if (!pulse) return null;
    const job = pulse.job;
    const timed =
      (pulse.state === "waiting_ci" || pulse.state === "ci_overdue") && job?.elapsedMs != null;
    return {
      state: pulse.state,
      label: pulseLabel(pulse.state),
      metric: metricOf(pulse, timed),
      // Elapsed against the usual, capped full; an overdue job simply fills the bar.
      ratio: timed && job?.typicalMs ? Math.min(1, job.elapsedMs! / job.typicalMs) : null,
      detail: detailOf(pulse),
      loopNote:
        pulse.ciFixRun > 0 && pulse.state !== "looping" && pulse.state !== "working"
          ? m.pulse_ci_fix_no_loop({ count: pulse.ciFixRun })
          : "",
    };
  });
</script>

{#if view}
  <div class="pulse pulse--{view.state}" {id}>
    <div class="p-top">
      <span class="p-dot" aria-hidden="true"></span>
      <span class="p-label">{view.label}</span>
      {#if view.metric}<span class="p-metric">{view.metric}</span>{/if}
    </div>
    {#if view.ratio != null}
      <div class="p-bar" aria-hidden="true"><span style:width="{view.ratio * 100}%"></span></div>
    {/if}
    {#if view.detail || view.loopNote}
      <div class="p-sub">
        {#if view.detail}<span class="p-detail">{view.detail}</span>{/if}
        {#if view.loopNote}<span class="p-loop">{view.loopNote}</span>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Hue by meaning (Four-Light Rule): in progress = amber, caution = warn, blocked = red. The
     label always names the state, so the hue never stands alone. */
  .pulse {
    --pulse-hue: var(--status-running);
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
    padding: 5px 8px 6px;
    border: 1px solid color-mix(in srgb, var(--pulse-hue) 40%, var(--color-line));
    border-radius: 2px;
    background: color-mix(in srgb, var(--pulse-hue) 7%, var(--color-panel));
    font-size: var(--fs-meta);
    line-height: 1.3;
    font-variant-numeric: tabular-nums;
  }
  .pulse--ci_overdue {
    --pulse-hue: var(--status-warn);
  }
  .pulse--ci_failed,
  .pulse--looping,
  .pulse--needs_you {
    --pulse-hue: var(--status-blocked);
  }
  .p-top,
  .p-sub {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .p-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--pulse-hue);
    align-self: center;
  }
  .p-label {
    color: var(--color-ink-bright);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .p-metric {
    margin-left: auto;
    color: var(--color-ink);
    white-space: nowrap;
  }
  .p-bar {
    height: 3px;
    background: color-mix(in srgb, var(--pulse-hue) 22%, var(--color-line));
  }
  .p-bar > span {
    display: block;
    height: 100%;
    background: var(--pulse-hue);
  }
  .p-sub {
    color: var(--color-muted);
  }
  .p-detail {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .p-loop {
    margin-left: auto;
    flex: none;
    white-space: nowrap;
  }
</style>
