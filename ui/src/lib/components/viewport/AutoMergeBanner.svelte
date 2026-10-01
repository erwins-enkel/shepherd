<script lang="ts">
  import type { AutoMergeStatus, GitState, MergeWaitCode } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { reviews, repoConfig } from "$lib/reviews.svelte";
  import { autoMergeView, elapsedMinutes } from "$lib/auto-merge-banner";
  import { clock } from "$lib/now.svelte";
  import { environmentLabel } from "$lib/reviewer-env";
  import { autoMergeStripExplanation } from "$lib/tooltips/explanations";
  import InfoTip from "$lib/components/InfoTip.svelte";

  // Non-blocking "full auto-merge owns this PR" strip (TASK-1368): the same bottom slot as
  // ReviewInFlightBanner / CiRunningBanner, shown only when neither claims it, naming what the
  // merge train still waits for. Independently of the strip, `owned` is bound out so the Viewport
  // dims the terminal and relabels the recap while Shepherd carries the PR — typing stays possible.
  let {
    sessionId,
    repoPath,
    git,
    status,
    tab,
    stripTaken,
    height = $bindable(0),
    owned = $bindable(false),
  }: {
    sessionId: string;
    repoPath: string;
    git: GitState | null | undefined;
    status: AutoMergeStatus | null | undefined;
    tab: string;
    /** The review-in-flight or CI banner occupies the bottom strip. */
    stripTaken: boolean;
    height?: number;
    owned?: boolean;
  } = $props();

  const criticRunning = $derived(reviews.isReviewing(sessionId));
  const view = $derived(
    autoMergeView({
      status,
      sessionId,
      criticRunning,
      autoAddressOn: repoConfig.autoAddress[repoPath] ?? false,
      stripTaken,
    }),
  );
  $effect(() => {
    if (owned !== view.owned) owned = view.owned;
  });

  const sha = $derived(git?.headSha ? git.headSha.slice(0, 7) : "");

  function criticRunningText(): string {
    const env = reviews.reviewerEnvFor(sessionId);
    const timed =
      env?.startedAt != null && env.timeoutMs != null
        ? m.automergebanner_critic_running({
            sha,
            elapsed: String(elapsedMinutes(env.startedAt, clock.current)),
            timeout: String(Math.round(env.timeoutMs / 60_000)),
          })
        : m.automergebanner_critic_running_bare({ sha });
    return env?.provider
      ? `${timed} · ${environmentLabel(env.provider, env.model, env.effort)}`
      : timed;
  }

  function reason(code: MergeWaitCode): string {
    switch (code) {
      case "critic_pending":
        return criticRunning ? criticRunningText() : m.automergebanner_critic_pending({ sha });
      case "checks_pending":
        return m.automergebanner_checks_pending();
      case "checks_failed":
        return m.automergebanner_checks_failed();
      case "behind":
        return m.automergebanner_behind();
      case "conflict":
        return m.automergebanner_conflict();
      case "not_mergeable":
        return m.automergebanner_not_mergeable();
      case "changes_requested":
        return view.code !== null && view.owner === "shepherd"
          ? m.automergebanner_changes_auto()
          : m.automergebanner_changes_manual();
      case "critic_error":
        return m.automergebanner_critic_error();
      case "rebase_cap":
        return m.automergebanner_rebase_cap();
      case "merge_backoff":
        return m.automergebanner_merge_backoff();
      case "manual_steps":
        return m.automergebanner_manual_steps();
      case "stacked":
        return m.automergebanner_stacked();
      case "signoff":
        return m.automergebanner_signoff();
    }
  }

  const shown = $derived(view.show && tab === "term");

  // Publish occupied height so the jump-to-latest button and .term-mount make room, mirroring
  // CiRunningBanner. Seeded pre-paint via the bound element; bind:offsetHeight keeps it current.
  let bannerEl = $state<HTMLDivElement>();
  $effect(() => {
    if (!shown) {
      height = 0;
      return;
    }
    if (bannerEl) height = bannerEl.offsetHeight;
  });
</script>

{#if shown && view.code}
  <div
    class="am-banner"
    data-owner={view.owner}
    role="status"
    aria-live="polite"
    bind:this={bannerEl}
    bind:offsetHeight={height}
  >
    <span class="am-icon" aria-hidden="true">↣</span>
    <span class="am-text">
      <span class="am-lead"
        >{view.owner === "shepherd"
          ? m.automergebanner_shepherd_lead()
          : m.automergebanner_operator_lead()}</span
      >
      <span class="am-sep" aria-hidden="true"> — </span>
      <span class="am-reason">{reason(view.code)}</span>
    </span>
    <InfoTip text={autoMergeStripExplanation()} label={m.automergebanner_tip_title()} />
  </div>
{/if}

<style>
  /* Bottom strip pinned to the terminal body, above the steer bar — the slot shared with
     ReviewInFlightBanner and CiRunningBanner (which win it). Non-blocking: no scrim/blur.
     Slate = Shepherd has it in hand (calm, nothing to do); amber = the train waits for you. */
  .am-banner {
    --accent: var(--color-slate);
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    font-size: var(--fs-base);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, var(--color-head));
    border-top: 1px solid color-mix(in srgb, var(--accent) 55%, var(--color-line));
    animation: am-in 0.14s ease;
  }
  .am-banner[data-owner="operator"] {
    --accent: var(--color-amber);
  }
  .am-icon {
    flex-shrink: 0;
    color: var(--accent);
  }
  .am-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-ink-bright);
  }
  .am-lead {
    color: var(--accent);
  }
  .am-sep {
    color: var(--color-faint);
  }
  @keyframes am-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
