<script lang="ts">
  import { gitState, openPr, mergePr, redeploy, replySession } from "$lib/api";
  import type { GitState, SessionStatus } from "$lib/types";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
  import { reviews, repoConfig } from "$lib/reviews.svelte";
  import { criticBadgeLabel } from "./critic-badge";
  import ReadyToggle from "./ReadyToggle.svelte";
  import AutomationPanel from "./AutomationPanel.svelte";
  import { automationCount } from "./git-rail-automation";
  import { coachTarget, coachTargets } from "$lib/actions/coachTarget.svelte";
  import { featureDiscovery } from "$lib/featureDiscovery.svelte";
  import { featureAnnouncements } from "$lib/feature-announcements";
  import Coachmark from "$lib/components/Coachmark.svelte";

  let {
    sessionId,
    repoPath = "",
    name = "",
    prompt = "",
    mobile = false,
    ready = false,
    status = "idle",
    showReady = true,
  }: {
    sessionId: string;
    repoPath?: string;
    name?: string;
    prompt?: string;
    mobile?: boolean;
    ready?: boolean;
    status?: SessionStatus;
    showReady?: boolean;
  } = $props();

  let git = $state<GitState | null>(null);
  let busy = $state(false);
  let err = $state<string | null>(null);
  // which handler last failed, so the inline Retry re-invokes the same action
  let retry = $state<(() => void) | null>(null);

  // Open-PR popover
  let showPr = $state(false);
  let prTitle = $state("");
  let prBody = $state("");

  // Critic-findings popover (read the full verdict body without leaving the app)
  let showReview = $state(false);
  let wrapEl = $state<HTMLElement | null>(null);

  // Repo-automation panel (pill-anchored popover; replaces the icon-toggle horde)
  let showAutomation = $state(false);

  // two-step confirm for destructive actions (mirrors decommission UX)
  let armed = $state<"merge" | "redeploy" | null>(null);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  function arm(which: "merge" | "redeploy"): boolean {
    if (armed === which) {
      clearTimeout(armTimer);
      armed = null;
      return true; // confirmed
    }
    armed = which;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => (armed = null), 3000);
    return false;
  }

  async function load(id: string) {
    try {
      const g = await gitState(id);
      if (id === sessionId) git = g;
    } catch {
      if (id === sessionId) git = null;
    }
  }

  $effect(() => {
    const id = sessionId;
    git = null;
    err = null;
    retry = null;
    armed = null;
    showPr = false;
    showReview = false;
    showAutomation = false;
    load(id);
    // light poll only while a PR is open (CI/merge state can change)
    const t = setInterval(() => {
      if (git?.state === "open") load(id);
    }, 15000);
    return () => clearInterval(t);
  });

  function startPr() {
    prTitle = name;
    prBody = prompt;
    showPr = true;
    showReview = false; // one popover at a time
    showAutomation = false; // one popover at a time
    err = null;
    retry = null;
  }

  function toggleReview() {
    showReview = !showReview;
    if (showReview) {
      showPr = false; // one popover at a time
      showAutomation = false;
    }
  }

  function toggleAutomation() {
    showAutomation = !showAutomation;
    if (showAutomation) {
      showPr = false;
      showReview = false; // one popover at a time
      // The critic/auto-address/learnings toggles now live behind this pill, so their
      // discovery coachmarks re-home onto it: arm the first still-unseen one on open.
      armFirstUnseenAutomation();
    }
  }

  // Escape / click-outside dismiss the findings + automation popovers
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (showReview) showReview = false;
      if (showAutomation) showAutomation = false;
    }
  }
  function onWindowPointerdown(e: PointerEvent) {
    if (wrapEl && !wrapEl.contains(e.target as Node)) {
      if (showReview) showReview = false;
      if (showAutomation) showAutomation = false;
    }
  }

  // server message, when meaningful, becomes the {reason} clause; otherwise a generic fallback
  function reason(e: unknown, fallback: string): string {
    const msg = e instanceof Error ? e.message.trim() : "";
    return msg || fallback;
  }

  async function submitPr() {
    busy = true;
    err = null;
    retry = null;
    try {
      git = {
        kind: git?.kind ?? "github",
        ...(await openPr(sessionId, { title: prTitle, body: prBody })),
      };
      showPr = false;
    } catch (e) {
      err = m.gitrail_open_pr_failed({ reason: reason(e, m.gitrail_open_pr()) });
      retry = submitPr;
    } finally {
      busy = false;
    }
  }

  // skipArm lets the inline Retry re-run a confirmed action without a second arm tap
  async function doMerge(skipArm = false) {
    if (!skipArm && !arm("merge")) return;
    busy = true;
    err = null;
    retry = null;
    try {
      git = { kind: git?.kind ?? "github", ...(await mergePr(sessionId)) };
      toasts.info(m.toast_merged({ name: name || sessionId }));
    } catch (e) {
      // prefer the known local cause over a raw server string
      err =
        git?.checks === "failure"
          ? m.gitrail_merge_failed_checks()
          : git?.mergeable === false
            ? m.gitrail_merge_failed_unmergeable()
            : m.gitrail_merge_failed({ reason: reason(e, m.gitrail_merge()) });
      retry = () => doMerge(true);
    } finally {
      busy = false;
    }
  }

  async function doRedeploy(skipArm = false) {
    if (!skipArm && !arm("redeploy")) return;
    busy = true;
    err = null;
    retry = null;
    try {
      await redeploy(sessionId);
    } catch (e) {
      err = m.gitrail_redeploy_failed({ reason: reason(e, m.gitrail_redeploy()) });
      retry = () => doRedeploy(true);
    } finally {
      busy = false;
    }
  }

  const mergeBlocked = $derived(
    !git || git.mergeable === false || git.checks === "failure" || busy,
  );

  const verdict = $derived(reviews.map[sessionId]);
  const verdictLabel = $derived(criticBadgeLabel(verdict));
  // Render the (AI-authored) findings as markdown, sanitized before @html.
  // marked + DOMPurify are dynamically imported on first render so they stay off
  // the first-paint critical path; gated on showReview so the (browser-only)
  // sanitizer never runs during SSR.
  let renderedBody = $state("");
  $effect(() => {
    const body = showReview ? verdict?.body : undefined;
    if (!body) {
      renderedBody = "";
      return;
    }
    let alive = true;
    Promise.all([import("marked"), import("dompurify")])
      .then(([{ marked }, { default: DOMPurify }]) => {
        if (alive)
          renderedBody = DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
      })
      .catch((err) => {
        // Markdown render is progressive enhancement; warn so a broken
        // marked/dompurify load isn't swallowed silently.
        console.warn("PR body markdown render failed", err);
      });
    return () => {
      alive = false;
    };
  });
  const criticOn = $derived(repoConfig.isEnabled(repoPath));
  const autoAddressOn = $derived(repoConfig.isAutoAddressEnabled(repoPath));
  const learningsOn = $derived(repoConfig.learningsOn(repoPath));
  const autopilotOn = $derived(repoConfig.isAutopilotEnabled(repoPath));
  const autoDrainOn = $derived(repoConfig.isAutoDrainEnabled(repoPath));
  const reviewing = $derived(reviews.isReviewing(sessionId));
  const autoCount = $derived(
    automationCount({
      critic: criticOn,
      autoAddress: autoAddressOn,
      learnings: learningsOn,
      autopilot: autopilotOn,
      autoDrain: autoDrainOn,
    }),
  );
  let reviewFlash = $state<string | null>(null);
  let reviewFlashErr = $state(false);

  // Coachmark: which feature is currently "armed" (popover open on first reveal).
  // armedId is set when the automation pill is first opened while a feature is unseen;
  // cleared on onseen (markSeen) or onclose (dismiss without marking seen).
  let armedId = $state<string | null>(null);

  // Feature ids whose controls moved behind the automation pill; their discovery
  // coachmarks now anchor on the pill instead of their (deleted) individual toggles.
  const PILL_FEATURE_IDS = ["critic", "auto-address", "learnings"] as const;

  // A passive "new" dot rides the pill while any relocated feature is still unseen.
  const automationHasUnseen = $derived(
    PILL_FEATURE_IDS.some((id) => !featureDiscovery.isSeen(id)),
  );

  // Arm the first relocated feature that is unseen AND has a pill target registered.
  function armFirstUnseenAutomation() {
    const next = PILL_FEATURE_IDS.find(
      (id) => !featureDiscovery.isSeen(id) && coachTargets.has(id),
    );
    if (next) armedId = next;
  }

  // The first catalog entry whose targetId is registered in coachTargets AND not yet seen
  // AND is currently armed. Reading coachTargets (SvelteMap) here makes this reactive to
  // session-switch registry changes (action destroy deletes, remount re-registers).
  const armedEntry = $derived(
    armedId && !featureDiscovery.isSeen(armedId) && coachTargets.has(armedId)
      ? (featureAnnouncements.find((e) => e.targetId === armedId) ?? null)
      : null,
  );

  $effect(() => {
    if (repoPath) repoConfig.ensure(repoPath);
  });

  async function sendReviewToAgent() {
    if (!verdict?.body) return;
    try {
      await replySession(sessionId, `Address this code review feedback:\n\n${verdict.body}`);
      showReview = false; // panel closing is the success feedback; dismiss it
    } catch {
      reviewFlash = m.gitrail_send_review_failed();
      reviewFlashErr = true;
      setTimeout(() => (reviewFlash = null), 1500);
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerdown} />

{#if git}
  <!-- dim the rest of the page behind the findings popover (mirrors the compose-bar
       sheet). Sits OUTSIDE wrapEl so a backdrop click trips the existing
       click-outside dismiss; Escape closes it too. Purely visual → aria-hidden. -->
  {#if showReview && verdict}
    <div class="review-scrim" aria-hidden="true"></div>
  {/if}
  <span class="git-rail-wrap" class:mobile bind:this={wrapEl}>
    <span class="rail" class:mobile>
      {#if git.state === "none"}
        <button class="gbtn" type="button" disabled={busy} onclick={startPr}
          >{m.gitrail_open_pr()}</button
        >
      {:else if git.state === "open"}
        {#if git.url}
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external git-host URL, not an app route -->
          <a class="prlink" href={git.url} target="_blank" rel="noopener">PR #{git.number} ↗</a>
        {:else}
          <span class="prlink">PR #{git.number}</span>
        {/if}
        <span
          class="dot dot-{git.checks}"
          title={m.gitrail_ci_status({ status: git.checks })}
          aria-label={m.gitrail_ci_status({ status: git.checks })}
        ></span>
        <button
          class="gbtn"
          class:armed={armed === "merge"}
          type="button"
          disabled={mergeBlocked}
          onclick={() => doMerge()}
        >
          {armed === "merge" ? m.gitrail_confirm_merge() : m.gitrail_merge()}
        </button>
      {:else if git.state === "merged"}
        <span class="merged">{m.gitrail_merged()}</span>
        {#if git.deployConfigured}
          <button
            class="gbtn"
            class:armed={armed === "redeploy"}
            type="button"
            disabled={busy}
            onclick={() => doRedeploy()}
          >
            {armed === "redeploy" ? m.gitrail_confirm_redeploy() : m.gitrail_redeploy()}
          </button>
        {/if}
      {:else}
        <span class="merged">{m.gitrail_closed()}</span>
      {/if}

      {#if repoPath}
        <button
          class={["gbtn", "auto-pill", { reviewing, armed: showAutomation }]}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={showAutomation}
          aria-busy={reviewing}
          aria-label={reviewing
            ? m.automation_pill_reviewing_aria()
            : m.automation_pill_aria({ count: autoCount })}
          use:coachTarget={"critic"}
          use:coachTarget={"auto-address"}
          use:coachTarget={"learnings"}
          onclick={toggleAutomation}
        >
          ⚙ {m.automation_pill_label()}
          <span class="auto-count" class:on={autoCount > 0}>{autoCount}/5</span>
          {#if automationHasUnseen}<span class="new-dot" aria-hidden="true"
            ></span><span class="sr-only">{m.newdot_aria()}</span>{/if}
        </button>
      {/if}
      {#if showReady && (git.state === "open" || ready) && status !== "running" && status !== "blocked"}
        <ReadyToggle {sessionId} {ready} variant="rail" />
      {/if}
      {#if verdict}
        <button
          class={["verdict-chip", `critic-${verdict.decision}`, { armed: showReview }]}
          type="button"
          aria-expanded={showReview}
          title={m.gitrail_review_title()}
          onclick={toggleReview}
        >
          {verdictLabel}
        </button>
      {/if}

      {#if err}
        <span class="err" role="alert" title={err}>{err}</span>
        {#if retry}
          <button class="gbtn" type="button" disabled={busy} onclick={() => retry?.()}
            >{m.common_retry()}</button
          >
        {/if}
      {/if}
    </span>

    {#if showPr}
      <div class="pr-pop">
        <input
          class="pr-title"
          bind:value={prTitle}
          placeholder={m.gitrail_pr_title_placeholder()}
          aria-label={m.gitrail_pr_title_aria()}
        />
        <textarea
          class="pr-body"
          bind:value={prBody}
          placeholder={m.gitrail_pr_description_placeholder()}
          aria-label={m.gitrail_pr_body_aria()}
          rows="4"
        ></textarea>
        <div class="pr-actions">
          <button class="gbtn" type="button" onclick={() => (showPr = false)}
            >{m.gitrail_cancel()}</button
          >
          <button
            class="gbtn primary"
            type="button"
            disabled={busy || !prTitle.trim()}
            onclick={submitPr}
          >
            {m.gitrail_create_pr()}
          </button>
        </div>
      </div>
    {/if}

    {#if showAutomation}
      <AutomationPanel {repoPath} {sessionId} />
    {/if}

    {#if armedEntry}
      <Coachmark
        targetId={armedEntry.targetId ?? null}
        titleKey={armedEntry.titleKey}
        bodyKey={armedEntry.bodyKey}
        onseen={() => {
          if (armedId) featureDiscovery.markSeen(armedId);
          armedId = null;
        }}
        onclose={() => {
          armedId = null;
        }}
      />
    {/if}

    {#if showReview && verdict}
      <div class="review-pop" role="dialog" aria-label={m.gitrail_review_title()}>
        <div class="review-head">
          <span class="rv-label critic-{verdict.decision}">{verdictLabel}</span>
          {#if git.url}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external git-host URL, not an app route -->
            <a class="rv-prlink" href={git.url} target="_blank" rel="noopener">PR #{git.number} ↗</a
            >
          {/if}
          <button
            class="gbtn"
            type="button"
            onclick={() => (showReview = false)}
            aria-label={m.common_close()}>✕</button
          >
        </div>
        {#if verdict.summary}
          <p class="rv-summary">{verdict.summary}</p>
        {/if}
        {#if verdict.body}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify above -->
          <div class="rv-body">{@html renderedBody}</div>
        {/if}
        {#if verdict.decision !== "error" && verdict.body}
          <div class="review-actions">
            {#if reviewFlash}<span
                class:err={reviewFlashErr}
                class:ok={!reviewFlashErr}
                title={reviewFlash}>{reviewFlash}</span
              >{/if}
            <button class="gbtn" type="button" disabled={busy} onclick={sendReviewToAgent}>
              {m.gitrail_send_review()}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </span>
{/if}

<style>
  /* own positioning context so .pr-pop anchors to the button in every
     mount site (desktop header + compact strip), not to some far ancestor */
  .git-rail-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .rail {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    padding: 2px 8px;
    white-space: nowrap;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.armed {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* critic actively reviewing: amber outline (reused by automation pill) */
  .gbtn.reviewing {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* automation summary pill: worded label + active-count, replaces the toggle horde */
  .auto-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .auto-count {
    color: var(--color-faint);
  }
  .auto-count.on {
    color: var(--color-green);
  }

  /* "new" discovery pip — separate element, distinct hue (accent blue ring).
     Sits next to .crit-dot inside the flex row; does NOT overload .crit-dot's
     grey/green/amber vocabulary.
     Visual priority: lower than .reviewing (reviewing uses !important pulse + amber,
     new-dot is a soft accent and loses visually by design).
     Reduced-motion: animation intentionally lacks !important so the global blanket
     in app.css (@media prefers-reduced-motion: reduce { animation: none !important })
     suppresses it — unlike .reviewing which is exempt. */
  .new-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-accent, #5f6ad2);
    flex-shrink: 0;
    animation: new-pip-pulse 2s ease-in-out infinite;
  }
  @keyframes new-pip-pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }

  /* Visually hidden but available to screen readers */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* verdict chip: .gbtn sizing, colored by decision */
  .verdict-chip {
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 8px;
    white-space: nowrap;
    cursor: pointer;
    transition:
      opacity 0.12s,
      box-shadow 0.12s;
  }
  .verdict-chip:hover {
    opacity: 0.8;
  }
  .verdict-chip.armed {
    box-shadow: 0 0 0 1px currentColor inset;
  }

  /* touch layouts: bigger tap targets + readable PR link/dot. fill the strip and
     wrap whole buttons onto a new right-aligned row, rather than letting a single
     nowrap rail overflow and squeeze button labels across lines */
  .git-rail-wrap.mobile {
    flex: 1 1 auto;
    min-width: 0;
  }
  .rail.mobile {
    width: 100%;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 10px;
    row-gap: 8px;
  }
  .rail.mobile .gbtn {
    min-height: 40px;
    padding: 6px 14px;
    font-size: 12px;
  }
  .rail.mobile .prlink {
    font-size: 13px;
    padding: 4px 2px;
  }
  .rail.mobile .dot {
    width: 9px;
    height: 9px;
  }

  .prlink {
    font-size: 11px;
    color: var(--color-muted);
    text-decoration: none;
  }
  .prlink:hover {
    color: var(--color-ink-bright);
  }

  .merged {
    font-size: 11px;
    color: var(--color-slate);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
    background: var(--color-faint);
  }
  .dot-pending {
    background: var(--color-amber);
    /* CI running — functional status motion, exempt from the reduced-motion
       blanket (app.css): the pulse encodes "work happening", not decoration. */
    animation: dot-pulse 1.1s ease-in-out infinite !important;
  }
  .dot-success {
    background: var(--color-green);
  }
  .dot-failure {
    background: var(--color-red);
  }

  .err,
  .ok {
    font-size: 10px;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err {
    color: var(--color-red);
  }
  .ok {
    color: var(--color-green);
  }

  .pr-pop {
    position: absolute;
    top: 100%;
    right: 8px;
    z-index: 20;
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    width: 320px;
    max-width: 90vw;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  }

  .pr-title,
  .pr-body {
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 4px 6px;
    resize: vertical;
  }

  .pr-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  /* full-page dim behind the findings popover, matching the compose-bar sheet */
  .review-scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(0, 0, 0, 0.45);
    -webkit-backdrop-filter: blur(3px);
    backdrop-filter: blur(3px);
  }

  /* findings popover: same anchoring as .pr-pop, wider + scrollable body.
     Rides above .review-scrim (z-index 50) so it stays lit while the page dims. */
  .review-pop {
    position: absolute;
    top: 100%;
    right: 8px;
    z-index: 51;
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    width: min(480px, 90vw);
    max-height: 60vh;
    /* clip to the box so the scrollable body — not the popover — absorbs
       overflow; without this the action footer escapes below max-height and,
       on short (unfolded-fold) viewports, lands off-screen + unreachable */
    overflow: hidden;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  }

  .review-head {
    display: flex;
    align-items: center;
    gap: 8px;
    /* head + footer stay pinned; only .rv-body scrolls */
    flex-shrink: 0;
  }
  .rv-label {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--color-muted);
  }
  .rv-label.critic-changes_requested,
  .verdict-chip.critic-changes_requested {
    color: var(--color-amber);
  }
  .rv-label.critic-commented,
  .verdict-chip.critic-commented {
    color: var(--color-blue);
  }
  .rv-label.critic-error,
  .verdict-chip.critic-error {
    color: var(--color-faint);
  }
  .rv-prlink {
    font-size: 11px;
    color: var(--color-muted);
    text-decoration: none;
  }
  .rv-prlink:hover {
    color: var(--color-ink-bright);
  }
  .review-head .gbtn {
    margin-left: auto;
    padding: 0 6px;
    line-height: 1.6;
  }

  .rv-summary {
    margin: 0;
    font-size: 11px;
    color: var(--color-ink);
    /* pinned alongside head/footer; only .rv-body scrolls */
    flex-shrink: 0;
  }
  .rv-body {
    margin: 0;
    /* the lone scroller: min-height:0 lets it shrink within the flex column
       (default min-height:auto would refuse, pushing the footer out of view) */
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-size: 12px;
    line-height: 1.5;
    padding: 6px 8px;
    overflow-wrap: anywhere;
  }
  /* markdown rendered via {@html} — children aren't scoped, so target globally */
  .rv-body :global(> *:first-child) {
    margin-top: 0;
  }
  .rv-body :global(> *:last-child) {
    margin-bottom: 0;
  }
  .rv-body :global(p),
  .rv-body :global(ul),
  .rv-body :global(ol) {
    margin: 0 0 8px;
  }
  .rv-body :global(ul),
  .rv-body :global(ol) {
    padding-left: 18px;
  }
  .rv-body :global(li) {
    margin: 2px 0;
  }
  .rv-body :global(h1),
  .rv-body :global(h2),
  .rv-body :global(h3),
  .rv-body :global(h4) {
    margin: 12px 0 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-ink-bright);
  }
  .rv-body :global(a) {
    color: var(--color-blue);
    text-decoration: underline;
  }
  .rv-body :global(code) {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--color-line);
    border-radius: 2px;
    padding: 0 3px;
    overflow-wrap: anywhere;
  }
  .rv-body :global(pre) {
    margin: 0 0 8px;
    padding: 6px 8px;
    background: var(--color-bg, var(--color-line));
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .rv-body :global(pre code) {
    background: none;
    padding: 0;
    overflow-wrap: anywhere;
  }
  .rv-body :global(blockquote) {
    margin: 0 0 8px;
    padding-left: 8px;
    border-left: 2px solid var(--color-line);
    color: var(--color-muted);
  }
  .rv-body :global(table) {
    width: 100%;
    margin: 0 0 8px;
    border-collapse: collapse;
    table-layout: fixed;
  }
  .rv-body :global(th),
  .rv-body :global(td) {
    padding: 2px 6px;
    border: 1px solid var(--color-line);
    text-align: left;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .review-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 4px;
    padding-top: 6px;
    border-top: 1px solid var(--color-line);
    /* pinned footer: never compressed away by a tall body */
    flex-shrink: 0;
  }
</style>
