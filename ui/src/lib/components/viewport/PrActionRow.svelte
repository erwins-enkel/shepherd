<script lang="ts">
  import { untrack } from "svelte";
  import { reviewPr, setReadyToMerge } from "#lib/api.js";
  import { checksCleared } from "#lib/checks-cleared.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { recaps } from "#lib/recaps.svelte.js";
  import { repoConfig, reviews } from "#lib/reviews.svelte.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { mergeIntoEpicExplanation } from "#lib/tooltips/explanations.js";
  import { statusTip, type StatusTipParams } from "#lib/tooltips/statusTip.svelte.js";
  import type { DrainStatus, GitState, Session, SessionStatus } from "#lib/types.js";
  import { firstSafeHttpUrl } from "#lib/url.js";
  import { criticChip } from "../critic-badge";
  import { railEpicChild, railEpicStopped } from "../git-rail/epic-rail";
  import MergeConfirmHost from "../MergeConfirmHost.svelte";
  import { SessionPrMerge } from "../session-pr-merge.svelte";
  import PrActionMenu from "./PrActionMenu.svelte";
  import {
    FACT_GLYPH,
    mergeActionLabel,
    mergeBlockedText,
    prActionRowVisible,
    prRowFacts,
    prRowLabel,
    prRowStatus,
  } from "./pr-action-row";

  // The merge row above the steer bar (#3540): an open PR's state, its merge prerequisites and
  // the ONE amber main action. Merge always opens the confirmation (#2299) — never inline.
  let {
    session,
    git,
    status,
    drain = null,
    mobile = false,
    touch = false,
    ondecommission,
    onsummary,
  }: {
    session: Session;
    git: GitState | null | undefined;
    /** Display status; the Ready item hides while the agent runs or is blocked. */
    status: SessionStatus;
    /** The repo's drain; an epic child's Merge tooltip says when its run is stopped. */
    drain?: DrainStatus | null;
    /** Phone: stacked layout (status, facts, action row). */
    mobile?: boolean;
    /** Any touch device: 44px targets. */
    touch?: boolean;
    /** Offered by the merged toast; called with the merged session's id. */
    ondecommission?: (id: string) => void;
    /** Opens the session recap (the row replaces its one-line headline). */
    onsummary?: () => void;
  } = $props();

  const merge = new SessionPrMerge();

  const verdict = $derived(reviews.map[session.id]);
  const reviewing = $derived(reviews.isReviewing(session.id));
  const chip = $derived(criticChip(verdict, reviewing));
  const criticOn = $derived(repoConfig.flags(session.repoPath).critic);
  $effect(() => {
    if (session.repoPath) repoConfig.ensure(session.repoPath);
  });

  const local = $derived(git?.kind === "local");
  const base = $derived(git?.baseRefName || session.baseBranch);
  const kind = $derived(git ? prRowStatus(git, merge.busy || git.inMergeQueue === true) : "ready");
  const blockedText = $derived(mergeBlockedText(kind));
  const facts = $derived(git ? prRowFacts({ git, chip, criticOn, base }) : []);
  // #2735: an epic child merges into its epic branch; the tooltip says where it lands.
  const epicChild = $derived(railEpicChild(session.epicParent ?? null, session.baseBranch));
  const epicStopped = $derived(railEpicStopped(epicChild, drain));

  const mergeTip = $derived<StatusTipParams | null>(
    blockedText
      ? {
          text: { title: m.prrow_merge_blocked_tip_title(), summary: blockedText, sections: [] },
          stopClickPropagation: false,
        }
      : epicChild
        ? {
            text: mergeIntoEpicExplanation({ branch: epicChild.branch, stopped: !!epicStopped }),
            stopClickPropagation: false,
            pinOnClick: false,
          }
        : null,
  );

  function onMerge() {
    if (blockedText || !git) return; // locked: aria-disabled keeps it focusable, the tip says why
    merge.merge({
      sessionId: session.id,
      git,
      name: session.name,
      repoPath: session.repoPath,
      isolated: session.isolated,
      baseBranch: session.baseBranch,
      ondecommission,
    });
  }

  // Manual critic trigger, moved from the git strip: only when the auto path's own precondition
  // holds (CI cleared) AND the repo runs the critic — mirrors the server's forceReview guard, so
  // a shown button is never rejected. Reviewing is allowed (the label becomes "Restart").
  const canReview = $derived(!!git && checksCleared(git.checks, git.noCi) && criticOn);
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  const reviewLabel = $derived(
    armed
      ? m.gitrail_confirm_review()
      : reviewing
        ? m.gitrail_restart_review()
        : verdict
          ? m.gitrail_rereview()
          : m.gitrail_review(),
  );

  // First click arms for 3s, the second confirms. The phone's menu item skips the arm: opening
  // the menu and picking the item already are the two steps.
  async function doReview(skipArm = false) {
    if (!skipArm && !armed) {
      armed = true;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => (armed = false), 3000);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    try {
      const res = await reviewPr(session.id);
      // "started" → the REVIEWING chip (via WS) is the feedback. Fail-closed: a decline or error
      // must never read as success.
      if (res === "skipped") toasts.info(m.gitrail_review_skipped());
      else if (res !== "started")
        toasts.info(m.gitrail_review_failed(), { alert: true, key: `review-pr:${session.id}` });
    } catch {
      toasts.info(m.gitrail_review_failed(), { alert: true, key: `review-pr:${session.id}` });
    }
  }

  // ⋯ menu: the secondary actions, each only while offered.
  const readyShown = $derived(status !== "running" && status !== "blocked");
  const issueHref = $derived(
    git?.issueUrl && session.issueNumber != null ? firstSafeHttpUrl(git.issueUrl) : null,
  );
  const showSummary = $derived(!!onsummary && recaps.map[session.id]?.state === "ready");
  const menuReview = $derived(mobile && canReview);
  const hasMenu = $derived(readyShown || !!issueHref || showSummary || menuReview);
  let moreBtn = $state<HTMLButtonElement>();
  let menuAnchor = $state<DOMRect | null>(null);
  function toggleMenu() {
    menuAnchor = menuAnchor || !moreBtn ? null : moreBtn.getBoundingClientRect();
  }

  // The Viewport is reused across sessions: an unanswered confirmation, a stale error, an armed
  // review or an open menu must not carry over to the next one.
  $effect(() => {
    void session.id;
    untrack(() => {
      merge.reset();
      clearTimeout(armTimer);
      armed = false;
      menuAnchor = null;
    });
  });

  const prHref = $derived(firstSafeHttpUrl(git?.url));
</script>

{#snippet more()}
  {#if hasMenu}
    <button
      bind:this={moreBtn}
      class="gbtn more"
      type="button"
      aria-label={m.prrow_more_aria()}
      aria-haspopup="menu"
      aria-expanded={!!menuAnchor}
      onclick={toggleMenu}>⋯</button
    >
  {/if}
{/snippet}

{#if prActionRowVisible(git)}
  <section
    class={["pr-row", kind, { mobile, touch: touch || mobile }]}
    aria-label={m.prrow_aria({ number: git.number ?? 0 })}
    data-swipe-ignore
  >
    <div class="pr-info">
      <div class="pr-head">
        <span class="pr-glyph" aria-hidden="true">{kind === "ready" ? "✓" : ""}</span>
        <span class="pr-label">{prRowLabel(kind, base)}</span>
        <span class="pr-num">#{git.number}</span>
        <span class="pr-title" title={git.title}>{git.title ?? ""}</span>
      </div>
      {#if merge.error}
        <p class="pr-error" role="alert">{merge.error}</p>
      {:else if facts.length > 0}
        <p class="pr-facts">
          {#each facts as f, i (f.id)}{#if i > 0}<span class="pr-dot" aria-hidden="true">·</span
              >{/if}<span class={["fact", f.tone]}
              ><span class="fg" aria-hidden="true">{FACT_GLYPH[f.tone]}</span>{f.text}</span
            >{/each}
        </p>
      {/if}
    </div>
    <div class="pr-actions">
      <!-- the phone leads its action row with ⋯; in the DOM too, so focus follows the eye -->
      {#if mobile}{@render more()}{/if}
      {#if prHref}
        <!-- eslint-disable svelte/no-navigation-without-resolve -- external git-host URL, not an app route -->
        <a
          class="gbtn"
          href={prHref}
          target="_blank"
          rel="noopener"
          aria-label={m.prbadge_open_pr()}>{m.prrow_pr_link()}</a
        >
        <!-- eslint-enable svelte/no-navigation-without-resolve -->
      {/if}
      {#if canReview && !mobile}
        <button
          class="gbtn"
          class:armed
          type="button"
          onclick={() => doReview()}
          use:coachTarget={"manual-critic-review"}>{reviewLabel}</button
        >
      {/if}
      {#if !mobile}{@render more()}{/if}
      <span class="pr-sep" aria-hidden="true"></span>
      <button
        class="gbtn primary merge"
        type="button"
        aria-disabled={blockedText ? "true" : undefined}
        aria-busy={kind === "merging" ? "true" : undefined}
        use:statusTip={mergeTip}
        use:coachTarget={"pr-merge-row"}
        onclick={onMerge}
      >
        {kind === "merging" ? m.prrow_merging() : mergeActionLabel(local, !!epicChild)}
      </button>
    </div>
  </section>

  {#if menuAnchor}
    <PrActionMenu
      anchor={menuAnchor}
      opener={moreBtn}
      ready={session.readyToMerge}
      showReady={readyShown}
      {issueHref}
      {showSummary}
      reviewLabel={menuReview ? reviewLabel : null}
      onready={() => setReadyToMerge(session.id, !session.readyToMerge)}
      onsummary={() => onsummary?.()}
      onreview={() => doReview(true)}
      onclose={() => (menuAnchor = null)}
    />
  {/if}
  <MergeConfirmHost flow={merge.flow} />
{/if}

<style>
  /* One flat band between the status strip and the steer bar; the hue lives on the glyph +
     label (Four-Light Rule), and only a ready PR tints the ground — mixed from tokens. */
  .pr-row {
    --tone: var(--color-ink);
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 10px 8px 14px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    font-family: var(--font-mono);
    min-width: 0;
  }
  .pr-row.ready {
    --tone: var(--color-green);
    background: color-mix(in srgb, var(--color-green) 7%, var(--color-head));
    border-top-color: color-mix(in srgb, var(--color-green) 35%, var(--color-line));
  }
  .pr-row.ci_running,
  .pr-row.merging {
    --tone: var(--color-amber);
  }
  /* subordinate red: text + dot only — no halo, pulse or wash */
  .pr-row.ci_failed {
    --tone: var(--color-red);
  }

  .pr-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .pr-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .pr-glyph {
    align-self: center;
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--tone);
  }
  .pr-row.ready .pr-glyph {
    width: auto;
    height: auto;
    border-radius: 0;
    background: none;
    color: var(--tone);
    font-size: var(--fs-base);
    line-height: 1;
  }
  /* work in progress: functional status motion, exempt from the reduced-motion blanket */
  .pr-row.ci_running .pr-glyph,
  .pr-row.merging .pr-glyph {
    animation: dot-pulse 1.1s ease-in-out infinite !important;
  }
  .pr-label {
    flex: none;
    color: var(--tone);
    font-size: var(--fs-meta);
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .pr-num {
    flex: none;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .pr-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-ink);
    font-size: var(--fs-base);
  }
  .pr-facts,
  .pr-error {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
  }
  .pr-facts {
    color: var(--color-muted);
  }
  .pr-error {
    color: var(--color-red);
  }
  .pr-dot {
    margin: 0 8px;
  }
  .fact .fg {
    margin-right: 5px;
  }
  .fact.ok .fg {
    color: var(--color-green);
  }
  .fact.fail .fg {
    color: var(--color-red);
  }

  .pr-actions {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pr-sep {
    width: 1px;
    align-self: stretch;
    background: var(--color-line);
  }

  /* .gbtn recipe (/design-system), standalone 2px; the label recipe for the type */
  .gbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 32px;
    padding: 0 12px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    box-sizing: border-box;
    transition:
      border-color 0.12s,
      color 0.12s,
      background 0.12s;
  }
  .gbtn:hover:not([aria-disabled="true"]) {
    border-color: var(--color-amber);
    color: var(--color-amber);
    background: var(--color-hover);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn.armed {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn.more {
    min-width: 32px;
    padding: 0;
    font-size: var(--fs-base);
    letter-spacing: 0;
  }
  /* the one amber action in the row: outline + inset glow, never a fill */
  .gbtn.primary {
    min-width: 132px;
    min-height: 36px;
    border-color: var(--color-amber);
    color: var(--color-amber);
    font-weight: 600;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .gbtn.primary:focus-visible {
    box-shadow:
      inset 0 0 0 1px var(--color-amber),
      inset 0 0 18px -10px var(--color-amber);
  }
  /* locked (not merging): focusable for its reason, but visibly inert */
  .gbtn.primary[aria-disabled="true"] {
    border-color: var(--color-line);
    color: var(--color-muted);
    box-shadow: none;
    cursor: not-allowed;
  }
  .gbtn.primary[aria-busy="true"] {
    border-color: color-mix(in srgb, var(--color-amber) 45%, var(--color-line));
    color: var(--color-amber);
    cursor: progress;
  }

  /* touch: every target at least 44px */
  .pr-row.touch .gbtn {
    min-height: var(--mobile-actionbar-hit);
  }
  .pr-row.touch .gbtn.more {
    min-width: var(--mobile-actionbar-hit);
  }

  /* phone: status + title, facts, then the action row — ⋯ · PR ↗ · Merge over the rest */
  .pr-row.mobile {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 10px 10px 10px 12px;
  }
  .pr-row.mobile .pr-actions {
    gap: 6px;
  }
  .pr-row.mobile .pr-sep {
    display: none;
  }
  .pr-row.mobile .gbtn.primary {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-base);
  }
</style>
