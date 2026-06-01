<script lang="ts">
  import { gitState, openPr, mergePr, redeploy, replySession } from "$lib/api";
  import type { GitState } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { reviews, repoConfig } from "$lib/reviews.svelte";
  import { criticBadgeLabel } from "./critic-badge";

  let {
    sessionId,
    repoPath = "",
    name = "",
    prompt = "",
    mobile = false,
  }: {
    sessionId: string;
    repoPath?: string;
    name?: string;
    prompt?: string;
    mobile?: boolean;
  } = $props();

  let git = $state<GitState | null>(null);
  let busy = $state(false);
  let err = $state<string | null>(null);

  // Open-PR popover
  let showPr = $state(false);
  let prTitle = $state("");
  let prBody = $state("");

  // Critic-findings popover (read the full verdict body without leaving the app)
  let showReview = $state(false);
  let wrapEl = $state<HTMLElement | null>(null);

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
    armed = null;
    showPr = false;
    showReview = false;
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
    err = null;
  }

  function toggleReview() {
    showReview = !showReview;
    if (showReview) showPr = false; // one popover at a time
  }

  // Escape / click-outside dismiss the findings popover (matches read-only intent)
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && showReview) showReview = false;
  }
  function onWindowPointerdown(e: PointerEvent) {
    if (showReview && wrapEl && !wrapEl.contains(e.target as Node)) showReview = false;
  }

  async function submitPr() {
    busy = true;
    err = null;
    try {
      git = {
        kind: git?.kind ?? "github",
        ...(await openPr(sessionId, { title: prTitle, body: prBody })),
      };
      showPr = false;
    } catch (e) {
      err = e instanceof Error ? e.message : "open PR failed";
    } finally {
      busy = false;
    }
  }

  async function doMerge() {
    if (!arm("merge")) return;
    busy = true;
    err = null;
    try {
      git = { kind: git?.kind ?? "github", ...(await mergePr(sessionId)) };
    } catch (e) {
      err = e instanceof Error ? e.message : "merge failed";
    } finally {
      busy = false;
    }
  }

  async function doRedeploy() {
    if (!arm("redeploy")) return;
    busy = true;
    err = null;
    try {
      await redeploy(sessionId);
    } catch (e) {
      err = e instanceof Error ? e.message : "redeploy failed";
    } finally {
      busy = false;
    }
  }

  const mergeBlocked = $derived(
    !git || git.mergeable === false || git.checks === "failure" || busy,
  );

  const verdict = $derived(reviews.map[sessionId]);
  const verdictLabel = $derived(criticBadgeLabel(verdict));
  const criticOn = $derived(repoConfig.isEnabled(repoPath));
  const reviewing = $derived(reviews.isReviewing(sessionId));
  let reviewFlash = $state<string | null>(null);
  let reviewFlashErr = $state(false);

  $effect(() => {
    if (repoPath) repoConfig.ensure(repoPath);
  });

  async function sendReviewToAgent() {
    if (!verdict?.body) return;
    try {
      await replySession(sessionId, `Address this code review feedback:\n\n${verdict.body}`);
      reviewFlash = m.gitrail_review_sent();
      reviewFlashErr = false;
    } catch {
      reviewFlash = m.gitrail_send_review_failed();
      reviewFlashErr = true;
    }
    setTimeout(() => (reviewFlash = null), 1500);
  }
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerdown} />

{#if git}
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
          onclick={doMerge}
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
            onclick={doRedeploy}
          >
            {armed === "redeploy" ? m.gitrail_confirm_redeploy() : m.gitrail_redeploy()}
          </button>
        {/if}
      {:else}
        <span class="merged">{m.gitrail_closed()}</span>
      {/if}

      {#if repoPath}
        <button
          class={["gbtn", { reviewing }]}
          type="button"
          aria-label={reviewing
            ? m.gitrail_critic_reviewing_aria()
            : m.gitrail_critic_toggle_aria()}
          aria-busy={reviewing}
          title={reviewing
            ? m.gitrail_critic_reviewing_aria()
            : criticOn
              ? m.gitrail_critic_on_title()
              : m.gitrail_critic_off_title()}
          onclick={() => repoConfig.toggle(repoPath)}
        >
          {#if reviewing}<span class="rev-dot" aria-hidden="true"></span>{/if}
          {reviewing
            ? m.gitrail_critic_reviewing()
            : criticOn
              ? m.gitrail_critic_on()
              : m.gitrail_critic_off()}
        </button>
      {/if}
      {#if verdict?.body}
        <button
          class={["gbtn", { armed: showReview }]}
          type="button"
          aria-expanded={showReview}
          onclick={toggleReview}
        >
          {m.gitrail_view_review()}
        </button>
      {/if}
      {#if verdict && verdict.decision !== "error" && verdict.body}
        <button class="gbtn" type="button" disabled={busy} onclick={sendReviewToAgent}>
          {m.gitrail_send_review()}
        </button>
      {/if}
      {#if reviewFlash}<span
          class:err={reviewFlashErr}
          class:ok={!reviewFlashErr}
          title={reviewFlash}>{reviewFlash}</span
        >{/if}

      {#if err}<span class="err" title={err}>{err}</span>{/if}
    </span>

    {#if showPr}
      <div class="pr-pop">
        <input
          class="pr-title"
          bind:value={prTitle}
          placeholder={m.gitrail_pr_title_placeholder()}
        />
        <textarea
          class="pr-body"
          bind:value={prBody}
          placeholder={m.gitrail_pr_description_placeholder()}
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

    {#if showReview && verdict?.body}
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
        <pre class="rv-body">{verdict.body}</pre>
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
  /* critic actively reviewing: amber outline + pulsing dot */
  .gbtn.reviewing {
    border-color: var(--color-amber);
    color: var(--color-amber);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .rev-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
    animation: rev-pulse 1.1s ease-in-out infinite;
  }
  @keyframes rev-pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .rev-dot {
      animation: none;
      opacity: 0.9;
    }
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
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
    /* CI running — pulse like every other in-progress indicator */
    animation: pip-pulse 1.5s ease-out infinite;
  }
  .dot-success {
    background: var(--color-green, #5ad19a);
  }
  .dot-failure {
    background: var(--color-red, #d9534f);
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
    color: var(--color-red, #d9534f);
  }
  .ok {
    color: var(--color-green, #4caf50);
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
    border-radius: 3px;
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

  /* findings popover: same anchoring as .pr-pop, wider + scrollable body */
  .review-pop {
    position: absolute;
    top: 100%;
    right: 8px;
    z-index: 20;
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    width: min(480px, 90vw);
    max-height: 60vh;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  }

  .review-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .rv-label {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--color-muted);
  }
  .rv-label.critic-changes_requested {
    color: var(--color-amber);
  }
  .rv-label.critic-commented {
    color: var(--color-blue, #4a90d9);
  }
  .rv-label.critic-error {
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
  }
  .rv-body {
    margin: 0;
    overflow: auto;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    padding: 6px 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
