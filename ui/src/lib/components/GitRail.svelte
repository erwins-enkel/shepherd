<script lang="ts">
  import { gitState, openPr, mergePr, redeploy, replySession } from "$lib/api";
  import type { GitState } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { reviews, repoConfig } from "$lib/reviews.svelte";

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
    err = null;
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
  const criticOn = $derived(repoConfig.isEnabled(repoPath));
  let reviewFlash = $state<string | null>(null);

  $effect(() => {
    if (repoPath) repoConfig.ensure(repoPath);
  });

  async function sendReviewToAgent() {
    if (!verdict?.body) return;
    try {
      await replySession(sessionId, `Address this code review feedback:\n\n${verdict.body}`);
      reviewFlash = m.gitrail_review_sent();
    } catch {
      reviewFlash = m.gitrail_send_review_failed();
    }
    setTimeout(() => (reviewFlash = null), 1500);
  }
</script>

{#if git}
  <span class="git-rail-wrap">
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
          class="gbtn"
          type="button"
          aria-label={m.gitrail_critic_toggle_aria()}
          onclick={() => repoConfig.toggle(repoPath)}
        >
          {criticOn ? m.gitrail_critic_on() : m.gitrail_critic_off()}
        </button>
      {/if}
      {#if verdict && verdict.decision !== "error" && verdict.body}
        <button class="gbtn" type="button" disabled={busy} onclick={sendReviewToAgent}>
          {m.gitrail_send_review()}
        </button>
      {/if}
      {#if reviewFlash}<span class="err" title={reviewFlash}>{reviewFlash}</span>{/if}

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
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* touch layouts: bigger tap targets + readable PR link/dot */
  .rail.mobile {
    gap: 10px;
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
  }
  .dot-success {
    background: var(--color-blue, #4a90d9);
  }
  .dot-failure {
    background: var(--color-red, #d9534f);
  }

  .err {
    font-size: 10px;
    color: var(--color-red, #d9534f);
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
</style>
