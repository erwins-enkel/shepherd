<script lang="ts">
  import type { AutoMergeStatus, GitState, MergeWaitCode } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { reviews, repoConfig } from "#lib/reviews.svelte.js";
  import { autoMergeView } from "#lib/auto-merge-banner.js";
  import { autoMergeStripExplanation } from "#lib/tooltips/explanations.js";
  import InfoTip from "#lib/components/InfoTip.svelte";
  import { mergePr, MergeRefusedError } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { prMergeAvailable } from "../pr-badge";
  import { mergeConfirmFromGit } from "../merge-confirm";
  import { MergeConfirmFlow } from "../merge-confirm-flow.svelte";
  import MergeConfirmHost from "../MergeConfirmHost.svelte";

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
    handedBack,
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
    /** Autopilot paused and handed the session back to the operator. */
    handedBack: boolean;
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
      handedBack,
    }),
  );
  $effect(() => {
    if (owned !== view.owned) owned = view.owned;
  });

  const sha = $derived(git?.headSha ? git.headSha.slice(0, 7) : "");

  /** Codes whose copy takes no arguments. */
  const PLAIN: Record<
    Exclude<MergeWaitCode, "critic_pending" | "changes_requested">,
    () => string
  > = {
    checks_pending: m.automergebanner_checks_pending,
    checks_failed: m.automergebanner_checks_failed,
    behind: m.automergebanner_behind,
    conflict: m.automergebanner_conflict,
    not_mergeable: m.automergebanner_not_mergeable,
    protection_blocked: m.automergebanner_protection_blocked,
    critic_error: m.automergebanner_critic_error,
    rebase_cap: m.automergebanner_rebase_cap,
    merge_backoff: m.automergebanner_merge_backoff,
    manual_steps: m.automergebanner_manual_steps,
    stacked: m.automergebanner_stacked,
    migrations: m.automergebanner_migrations,
    signoff: m.automergebanner_signoff,
    no_ci: m.automergebanner_no_ci,
    checks_absent: m.automergebanner_checks_absent,
    queued: m.automergebanner_queued,
  };

  function reason(code: MergeWaitCode): string {
    // Autopilot stopped driving the agent; its question / reason shows on the autopilot badge.
    if (handedBack) return m.automergebanner_handed_back();
    // A running critic owns the slot itself (ReviewInFlightBanner), so this is the gap
    // between a new head and its critic run.
    if (code === "critic_pending") return m.automergebanner_critic_pending({ sha });
    if (code === "changes_requested")
      return view.code !== null && view.owner === "shepherd"
        ? m.automergebanner_changes_auto()
        : m.automergebanner_changes_manual();
    return PLAIN[code]();
  }

  const shown = $derived(view.show && tab === "term");

  // #3221: the PR carries no checks (no PR CI, or CI skipped it) — offer the manual merge here,
  // through the same confirmation dialog as the PR badge, instead of a dead-end wait.
  const NO_CHECKS: ReadonlySet<MergeWaitCode> = new Set(["no_ci", "checks_absent"]);
  const canMergeWithoutCi = $derived(
    !!view.code && NO_CHECKS.has(view.code) && prMergeAvailable(git ?? undefined),
  );
  const mergeFlow = new MergeConfirmFlow();

  function mergeWithoutCi() {
    const ctx = mergeConfirmFromGit(git);
    if (!canMergeWithoutCi || !ctx) return;
    mergeFlow.open(ctx, async (confirm) => {
      try {
        await mergePr(sessionId, { deleteBranch: true, confirm });
        toasts.info(m.prbadge_merged_toast({ number: ctx.number }), {
          key: `pr-merge:${sessionId}`,
        });
      } catch (err) {
        if (err instanceof MergeRefusedError) throw err; // the dialog re-states and stays open
        toasts.info(
          m.prbadge_merge_failed({
            reason: err instanceof Error ? err.message : m.prbadge_unknown_error(),
          }),
          { alert: true, key: `pr-merge:${sessionId}` },
        );
      }
    });
  }

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
    class="term-strip am-banner"
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
    {#if canMergeWithoutCi}
      <button class="am-merge" type="button" onclick={mergeWithoutCi}
        >{m.automergebanner_merge_without_ci()}</button
      >
    {/if}
    <InfoTip text={autoMergeStripExplanation()} label={m.automergebanner_tip_title()} />
  </div>
{/if}
<MergeConfirmHost flow={mergeFlow} />

<style>
  /* Geometry, tint and entry animation come from the shared .term-strip recipe (app.css) — the
     slot shared with ReviewInFlightBanner and CiRunningBanner (which win it).
     Slate = Shepherd has it in hand (calm, nothing to do); amber = the train waits for you. */
  .am-banner {
    --accent: var(--color-slate);
  }
  .am-banner[data-owner="operator"] {
    --accent: var(--color-amber);
  }
  .am-icon {
    flex-shrink: 0;
    color: var(--accent);
  }
  /* Wraps rather than truncating: on phones the lead alone fills a line, and the reason after
     the dash is the part the operator needs. The bound height grows with it. */
  .am-text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--color-ink-bright);
  }
  .am-lead {
    color: var(--accent);
  }
  .am-sep {
    color: var(--color-faint);
  }
  .am-merge {
    flex-shrink: 0;
    min-height: 28px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--accent) 70%, var(--color-line-bright));
    background: color-mix(in srgb, var(--accent) 18%, var(--color-bg));
    color: var(--color-ink-bright);
    font: inherit;
    cursor: pointer;
  }
  .am-merge:hover {
    background: color-mix(in srgb, var(--accent) 28%, var(--color-bg));
  }
  @media (pointer: coarse) {
    .am-merge {
      min-height: 44px;
    }
  }
</style>
