<script lang="ts">
  /**
   * The Issues panel's failure state when GitHub rate-limited the listing: WHEN the issues
   * load again, an automatic retry at that moment, and a disclosure on whether the limit
   * can be raised at all (a paid personal plan can't; only GitHub Enterprise Cloud can).
   *
   * The refill time comes from the quota-exempt `/api/usage/github` reading the usage
   * view's GitHub tab shows, so asking for it never deepens the limit. The caller mounts
   * this only for a rate-limited trail and remounts it on every retry, which re-reads the
   * time and drops a pending auto-retry with the old instance.
   */
  import { getGithubRateLimit } from "#lib/api.js";
  import type { GithubRateLimit, IssueFetchAttempt } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { clock } from "#lib/now.svelte.js";
  import { formatReset, formatResetIn } from "#lib/format.js";
  import TooltipBody from "#lib/tooltips/TooltipBody.svelte";
  import { githubRateLimitRaiseExplanation } from "#lib/tooltips/explanations.js";
  import IssueLoadAttempts from "../IssueLoadAttempts.svelte";
  import { rateLimitWait } from "./rate-limit-wait";

  const { attempts, onretry }: { attempts: IssueFetchAttempt[]; onretry: () => void } = $props();

  const uid = $props.id();

  /** A few seconds past the refill, so a browser clock slightly ahead of GitHub's doesn't
   *  retry into the same limit. */
  const RETRY_SLACK_MS = 3_000;

  let gh = $state<GithubRateLimit | null>(null);
  let open = $state(false);

  $effect(() => {
    let live = true;
    getGithubRateLimit()
      .then((r) => {
        if (live) gh = r;
      })
      // No reading: the card stays, without a time — the trail still names the limit.
      .catch(() => {});
    return () => {
      live = false;
    };
  });

  // Evaluated once per reading, not per clock tick, so the retry timer below isn't
  // re-armed every 30s.
  const wait = $derived(gh ? rateLimitWait(attempts, gh, Date.now()) : null);
  const resumeTime = $derived(
    wait ? formatReset(wait.resumeAt, clock.current, { withTime: true }) : null,
  );

  $effect(() => {
    if (!wait) return;
    const id = setTimeout(onretry, Math.max(0, wait.resumeAt - Date.now()) + RETRY_SLACK_MS);
    return () => clearTimeout(id);
  });

  function freeNote(a: IssueFetchAttempt): string | null {
    const at = wait?.freeAt[a.transport];
    return at == null
      ? null
      : m.issues_attempt_free_at({ time: formatReset(at, clock.current, { withTime: true }) });
  }
</script>

<section class="rl-notice" aria-labelledby="{uid}-title">
  <div class="rl-head">
    <span class="rl-kicker" id="{uid}-title">{m.issues_ratelimit_title()}</span>
    {#if wait && resumeTime}
      <p class="rl-when">{m.issues_ratelimit_resume({ time: resumeTime })}</p>
      <p class="rl-sub">
        {m.issues_ratelimit_resume_in({ time: formatResetIn(wait.resumeAt, clock.current) })}
      </p>
    {:else}
      <p class="rl-sub">{m.issues_ratelimit_unknown()}</p>
    {/if}
  </div>

  <div>
    <button type="button" class="gbtn" onclick={onretry}>{m.issues_ratelimit_retry_now()}</button>
  </div>

  <IssueLoadAttempts {attempts} note={freeNote} />

  <div class="rl-raise">
    <button
      type="button"
      class="rl-toggle"
      aria-expanded={open}
      aria-controls="{uid}-raise"
      onclick={() => (open = !open)}
    >
      <span class="rl-chevron" class:open aria-hidden="true">▸</span>
      {m.issues_ratelimit_raise_toggle()}
    </button>
    {#if open}
      <div class="rl-explainer" id="{uid}-raise">
        <TooltipBody content={githubRateLimitRaiseExplanation(resumeTime)} />
        <span class="rl-links">
          <!-- eslint-disable svelte/no-navigation-without-resolve -- external GitHub URLs -->
          <a
            href="https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api"
            target="_blank"
            rel="noopener">{m.issues_ratelimit_docs_link()} ↗</a
          >
          <a href="https://github.com/enterprise" target="_blank" rel="noopener"
            >{m.issues_ratelimit_enterprise_link()} ↗</a
          >
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
        </span>
      </div>
    {/if}
  </div>
</section>

<style>
  .rl-notice {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    background: var(--color-inset);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }

  .rl-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* Amber, not red: this is a wait, not a defect. */
  .rl-kicker {
    color: var(--color-amber);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .rl-when {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: 600;
    line-height: 1.35;
    color: var(--color-ink-bright);
  }

  .rl-sub {
    margin: 0;
  }

  /* The /design-system button recipe. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
  }

  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .rl-raise {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--color-line);
  }

  .rl-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
    background: transparent;
    border: 0;
    color: var(--color-ink);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    text-align: left;
  }

  .rl-toggle:hover {
    color: var(--color-amber);
  }

  .rl-toggle:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .rl-chevron {
    transition: transform 0.12s ease;
  }

  .rl-chevron.open {
    transform: rotate(90deg);
  }

  .rl-explainer {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .rl-links {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
  }

  .rl-links a {
    color: var(--color-blue);
  }

  @media (max-width: 768px), (pointer: coarse) {
    .gbtn,
    .rl-toggle,
    .rl-links a {
      min-height: 44px;
    }

    .rl-links a {
      display: inline-flex;
      align-items: center;
    }
  }
</style>
