<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { Pulse } from "$lib/session-pulse";
  import { pulseLabel } from "$lib/pulse-text";

  // The card's "now" line: the session's progress verdict in one glance — what it is doing or
  // waiting on, how long against the usual, and whether Shepherd is re-steering in circles.
  // Purely presentational; the verdict comes from session-pulse.ts.
  let { pulse, id }: { pulse: Pulse; id: string } = $props();

  const min = (ms: number) => Math.max(0, Math.round(ms / 60_000));
  const job = $derived(pulse.job);
  const timed = $derived(
    (pulse.state === "waiting_ci" || pulse.state === "ci_overdue") && job?.elapsedMs != null,
  );
  const metric = $derived.by(() => {
    if (timed && job?.typicalMs)
      return m.pulse_minutes_of({ elapsed: min(job.elapsedMs!), typical: min(job.typicalMs) });
    if (timed) return m.pulse_minutes({ elapsed: min(job!.elapsedMs!) });
    if (pulse.state === "looping") return m.pulse_ci_fix_count({ count: pulse.ciFixRun });
    if (pulse.step) return m.pulse_step_of({ index: pulse.step.index, total: pulse.step.total });
    return "";
  });
  // Elapsed against the usual, capped full; an overdue job simply fills the bar.
  const ratio = $derived(
    timed && job?.typicalMs ? Math.min(1, job.elapsedMs! / job.typicalMs) : null,
  );
  const detail = $derived.by(() => {
    if (pulse.state === "working") return pulse.step?.title ?? "";
    if (pulse.state === "needs_you") return "";
    const green = pulse.total ? m.pulse_green_of({ green: pulse.green, total: pulse.total }) : "";
    return [job?.short, green].filter(Boolean).join(" · ");
  });
  const loopNote = $derived(
    pulse.ciFixRun > 0 && pulse.state !== "looping" && pulse.state !== "working"
      ? m.pulse_ci_fix_no_loop({ count: pulse.ciFixRun })
      : "",
  );
</script>

<div class="pulse pulse--{pulse.state}" {id}>
  <div class="p-top">
    <span class="p-dot" aria-hidden="true"></span>
    <span class="p-label">{pulseLabel(pulse.state)}</span>
    {#if metric}<span class="p-metric">{metric}</span>{/if}
  </div>
  {#if ratio != null}
    <div class="p-bar" aria-hidden="true"><span style:width="{ratio * 100}%"></span></div>
  {/if}
  {#if detail || loopNote}
    <div class="p-sub">
      {#if detail}<span class="p-detail">{detail}</span>{/if}
      {#if loopNote}<span class="p-loop">{loopNote}</span>{/if}
    </div>
  {/if}
</div>

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
