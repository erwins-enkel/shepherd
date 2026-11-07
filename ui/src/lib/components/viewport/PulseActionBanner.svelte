<script lang="ts">
  import type { GitState, Session, SteerLogEntry } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { firstSafeHttpUrl } from "#lib/url.js";
  import { clock } from "#lib/now.svelte.js";
  import { sessionPulse } from "#lib/session-pulse.js";
  import { typicalMinutes } from "#lib/pulse-text.js";
  import { ApiError, interruptSession, restartCiJob, setSessionAutopilot } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";

  // The actions the hover status panel can't carry (#2863): it is pointer-transparent, so the
  // "CI overdue" and "going in circles" verdicts get their buttons here, in the detail view's
  // bottom strip — the slot ReviewInFlightBanner wins and CiRunningBanner / AutoMergeBanner yield.
  let {
    session,
    git,
    steers,
    autopilotOn,
    tab,
    reviewActive,
    height = $bindable(0),
    shown = $bindable(false),
  }: {
    session: Session;
    git: GitState | null | undefined;
    steers: SteerLogEntry[] | undefined;
    /** Effective autopilot (session override, else repo default). */
    autopilotOn: boolean;
    tab: string;
    reviewActive: boolean;
    height?: number;
    /** Bound out: this strip claims the slot, so the CI / auto-merge strips stand down. */
    shown?: boolean;
  } = $props();

  const pulse = $derived(
    sessionPulse({ session, git: git ?? undefined, steers, nowMs: clock.current }),
  );
  // Local sessions only: a mirrored one's actions belong to its own machine.
  const kind = $derived(
    !session.host && !reviewActive && (pulse?.state === "ci_overdue" || pulse?.state === "looping")
      ? pulse.state
      : null,
  );
  $effect(() => {
    if (shown !== !!kind) shown = !!kind;
  });

  const RESTART_GRACE_MS = 3 * 60_000;
  let armed = $state(false);
  let restarting = $state<{ job: string; at: number } | null>(null);
  const job = $derived(kind === "ci_overdue" ? pulse?.job : undefined);
  const runUrl = $derived(
    job ? firstSafeHttpUrl(git?.jobs?.find((j) => j.name === job.name)?.url) : null,
  );
  // "Restarting…" until the job leaves the overdue verdict (its new attempt starts the clock
  // over) or the grace runs out — the server reports no completion.
  const busy = $derived(
    !!restarting &&
      restarting.job === job?.name &&
      clock.current - restarting.at < RESTART_GRACE_MS,
  );

  async function rerun(): Promise<void> {
    if (!job) return;
    if (!armed) {
      armed = true;
      return;
    }
    armed = false;
    restarting = { job: job.name, at: Date.now() };
    try {
      await restartCiJob(session.id, job.name);
      toasts.info(m.pulseactions_rerun_started({ job: job.short }));
    } catch (e) {
      restarting = null;
      toasts.info(
        e instanceof ApiError && e.status === 400
          ? m.pulseactions_rerun_unsupported()
          : m.pulseactions_rerun_failed(),
        { alert: true },
      );
    }
  }

  async function takeOver(): Promise<void> {
    try {
      await setSessionAutopilot(session.id, false);
    } catch {
      toasts.info(m.session_autopilot_toggle_failed(), { alert: true });
    }
  }

  async function stop(): Promise<void> {
    try {
      await interruptSession(session.id);
    } catch {
      toasts.info(m.pulseactions_stop_failed(), { alert: true });
    }
  }

  const text = $derived.by(() => {
    if (kind === "looping") return m.pulse_summary_looping({ count: pulse!.ciFixRun });
    if (!job) return "";
    return m.pulse_summary_overdue({
      job: job.short,
      elapsed: Math.max(0, Math.round((job.elapsedMs ?? 0) / 60_000)),
      typical: typicalMinutes(job.typicalMs ?? 0),
    });
  });

  let bannerEl = $state<HTMLDivElement>();
  $effect(() => {
    if (!kind || tab !== "term") {
      height = 0;
      return;
    }
    if (bannerEl) height = bannerEl.offsetHeight;
  });
</script>

{#if kind && tab === "term"}
  <div
    class="term-strip pa-banner"
    data-kind={kind}
    role="status"
    aria-live="polite"
    bind:this={bannerEl}
    bind:offsetHeight={height}
  >
    <span class="pa-icon" aria-hidden="true">{kind === "looping" ? "↻" : "!"}</span>
    <span class="pa-text">
      <span class="pa-lead"
        >{kind === "looping" ? m.pulse_title_looping() : m.pulse_title_ci_overdue()}</span
      >
      <span class="pa-sep" aria-hidden="true"> — </span>
      <span>{text}</span>
    </span>
    {#if kind === "ci_overdue"}
      {#if runUrl}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
        <a class="pa-btn" href={runUrl} target="_blank" rel="noopener"
          >{m.pulseactions_open_run()}</a
        >
      {/if}
      <button
        class="pa-btn"
        class:armed
        type="button"
        disabled={busy}
        onclick={rerun}
        onblur={() => (armed = false)}
        >{busy
          ? m.pulseactions_rerun_busy()
          : armed
            ? m.pulseactions_rerun_confirm()
            : m.pulseactions_rerun()}</button
      >
    {:else}
      {#if autopilotOn}
        <button class="pa-btn" type="button" onclick={takeOver}>{m.pulseactions_take_over()}</button
        >
      {/if}
      {#if session.status === "running"}
        <button class="pa-btn pa-stop" type="button" onclick={stop}>{m.pulseactions_stop()}</button>
      {/if}
    {/if}
  </div>
{/if}

<style>
  /* Geometry, tint and entry animation come from the shared .term-strip recipe (app.css).
     Amber = CI overdue (a run to check on); red = going in circles (step in). */
  .pa-banner {
    --accent: var(--color-amber);
  }
  .pa-banner[data-kind="looping"] {
    --accent: var(--color-red);
  }
  .pa-icon {
    flex-shrink: 0;
    font-family: var(--font-mono);
    color: var(--accent);
  }
  .pa-text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--color-ink-bright);
  }
  .pa-lead {
    color: var(--accent);
  }
  .pa-sep {
    color: var(--color-faint);
  }
  .pa-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--accent) 70%, var(--color-line-bright));
    background: color-mix(in srgb, var(--accent) 18%, var(--color-bg));
    color: var(--color-ink-bright);
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .pa-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 28%, var(--color-bg));
  }
  .pa-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .pa-btn.armed,
  .pa-stop {
    border-color: var(--color-red);
  }
  @media (pointer: coarse) {
    .pa-btn {
      min-height: 44px;
    }
  }
</style>
