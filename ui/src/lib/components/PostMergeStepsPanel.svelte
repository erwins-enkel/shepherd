<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { PostMergeSteps, OwedFocusSnapshot } from "$lib/types";
  import { postMergeSteps, owedRecordsForRepo } from "$lib/post-merge-steps.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { basename } from "./learnings-drawer";
  import { formatAgo } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";
  import { EMPTY_REPO_FILTER } from "./queue-strip";

  let {
    repoFilter = EMPTY_REPO_FILTER,
    filteredRepo = null,
    focusSessionId = null,
    focusSnapshot = null,
    focusNonce = 0,
    focusHandledNonce = 0,
    onfocusresolved = undefined,
  }: {
    /** Active repo chip filter (selected repo paths; empty = all repos). Scopes the visible card
     *  list and empty state — but NOT the focus/frozen-card resolution, which must see every repo. */
    repoFilter?: ReadonlySet<string>;
    /** Pre-computed filter display name ("N repos" for a multi-selection) for the empty state. */
    filteredRepo?: string | null;
    focusSessionId?: string | null;
    focusSnapshot?: OwedFocusSnapshot | null;
    focusNonce?: number;
    focusHandledNonce?: number;
    onfocusresolved?: (nonce: number) => void;
  } = $props();

  // Unfiltered store — the source of truth for focus/frozen-card resolution (the #1275
  // "live record always wins / never a dead end" invariant must see records across ALL repos).
  const records = $derived(postMergeSteps.records);
  // Repo-scoped view (#owed) — used ONLY by the card-list render and the empty gate. An empty
  // repoFilter passes records through unchanged.
  const shownRecords = $derived(owedRecordsForRepo(records, repoFilter));

  // Owed-lens focus (#1275): a manual-steps chip click scrolls to + briefly highlights the target
  // session's card, or — when it has no live outstanding record (pre-merge, cleared, dismissed, or
  // load-failed) — pins a read-only frozen card built from the click-time snapshot so the click is
  // never a dead end.
  let listEl = $state<HTMLElement>();
  let focusedSessionId = $state<string | null>(null);
  let pinnedFrozen = $state<OwedFocusSnapshot | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  // A live record always wins over the frozen fallback. `settled` is sticky (true after the first
  // load), so the effect's `merged && !settled` wait branch only guards the FIRST load — a click
  // during the merge→WS-refresh window, or after a failed-then-retried load, can pin a frozen card
  // and mark its nonce handled; when the live record later lands, the nonce guard makes the effect
  // return early. This render-time guard suppresses the frozen card for any session that now has a
  // live record, so the two never co-render (and a stale "no longer owed" note can't contradict the
  // live card). #1275
  const frozenCard = $derived.by(() => {
    const p = pinnedFrozen;
    if (!p) return null;
    return records.some((r) => r.sessionId === p.sessionId) ? null : p;
  });

  function startFlash(id: string) {
    if (flashTimer) clearTimeout(flashTimer);
    focusedSessionId = id;
    flashTimer = setTimeout(() => {
      focusedSessionId = null;
      flashTimer = null;
    }, 1500);
  }

  function scrollToCard(id: string) {
    const el = listEl?.querySelector(`[data-session-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }

  $effect(() => {
    const nonce = focusNonce;
    const snap = focusSnapshot;
    // guards: nothing to do / already resolved this click
    if (!snap || nonce === focusHandledNonce) return;
    // focusSessionId is the parent's authoritative "what to focus" id (kept in lockstep with
    // snap.sessionId by the page); snap otherwise only supplies the frozen-fallback payload.
    const id = focusSessionId ?? snap.sessionId;

    const live = records.find((r) => r.sessionId === id);
    if (live) {
      pinnedFrozen = null;
      void tick().then(() => scrollToCard(id));
      startFlash(id);
      onfocusresolved?.(nonce);
      return;
    }
    // no live record:
    if (snap.merged && !postMergeSteps.settled) {
      // load still in flight — unknown, not empty. Wait (do NOT resolve).
      return;
    }
    // absence is real (pre-merge, or settled): show a frozen card
    pinnedFrozen = snap;
    void tick().then(() => scrollToCard(id));
    startFlash(id);
    onfocusresolved?.(nonce);
  });

  // Kept OUT of the focus effect above so its re-runs (e.g. a WS-driven records refresh) can't
  // truncate a flash already in flight — this only fires once, on unmount.
  onDestroy(() => {
    if (flashTimer) clearTimeout(flashTimer);
  });

  // Dismiss is an inline arm-then-confirm (no modal, no scrim): first click arms, second confirms;
  // the armed state self-disarms after a few seconds so a stray click can't clear a whole record.
  let armed = $state<string | null>(null);
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;
  function disarm() {
    armed = null;
    if (disarmTimer) {
      clearTimeout(disarmTimer);
      disarmTimer = null;
    }
  }
  function clickDismiss(sessionId: string) {
    if (armed !== sessionId) {
      armed = sessionId;
      if (disarmTimer) clearTimeout(disarmTimer);
      disarmTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    void postMergeSteps.dismiss(sessionId);
  }

  function toggleStep(rec: PostMergeSteps, stepId: string, done: boolean) {
    void postMergeSteps.setStepDone(rec.sessionId, stepId, done);
  }

  const doneCount = (rec: PostMergeSteps) => rec.steps.filter((s) => s.doneAt != null).length;
</script>

<div class="owed" bind:this={listEl}>
  <div class="ow-head">
    <span class="ow-title">{m.owed_title()}</span>
  </div>

  {#if shownRecords.length === 0 && !frozenCard}
    <div class="ow-empty">
      {#if filteredRepo}{m.owed_repo_filter_empty({
          repo: filteredRepo,
        })}{:else}{m.owed_empty()}{/if}
    </div>
  {:else}
    <p class="ow-note">{m.owed_note()}</p>
    {#if frozenCard}
      <section
        class="ow-card ow-card--frozen"
        data-session-id={frozenCard.sessionId}
        class:focus={focusedSessionId === frozenCard.sessionId}
      >
        <header class="ow-card-head">
          <div class="ow-card-id">
            <span class="ow-repo" title={frozenCard.repoPath}>
              {#if projectIcons.iconFor(frozenCard.repoPath)}<span
                  class="ow-repo-icon"
                  aria-hidden="true">{projectIcons.iconFor(frozenCard.repoPath)}</span
                >{/if}{basename(frozenCard.repoPath)}
            </span>
            <span class="ow-desig">{frozenCard.desig}</span>
            {#if frozenCard.prNumber != null}<span class="ow-pr">#{frozenCard.prNumber}</span>{/if}
          </div>
          <div class="ow-card-meta">
            <span class="ow-frozen-note">
              {#if !frozenCard.merged}{m.owed_frozen_pre_merge_note()}
              {:else if postMergeSteps.loaded}{m.owed_frozen_cleared_note()}
              {:else}{m.owed_frozen_unknown_note()}{/if}
            </span>
          </div>
        </header>
        <ul class="ow-steps">
          {#each frozenCard.steps as step (step.id)}
            <li class="ow-step ow-step--frozen">
              <span class="ow-step-text">
                {#if step.postMerge}<span class="ow-pm-badge">{m.owed_post_merge_badge()}</span
                  >{/if}
                {step.text}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    <div class="ow-list">
      {#each shownRecords as rec (rec.sessionId)}
        <section
          class="ow-card"
          data-session-id={rec.sessionId}
          class:focus={focusedSessionId === rec.sessionId}
        >
          <header class="ow-card-head">
            <div class="ow-card-id">
              <span class="ow-repo" title={rec.repoPath}>
                {#if projectIcons.iconFor(rec.repoPath)}<span
                    class="ow-repo-icon"
                    aria-hidden="true">{projectIcons.iconFor(rec.repoPath)}</span
                  >{/if}{basename(rec.repoPath)}
              </span>
              <span class="ow-desig">{rec.desig}</span>
              {#if rec.prNumber != null}<span class="ow-pr">#{rec.prNumber}</span>{/if}
              <span class="ow-count"
                >{m.owed_steps_count({ done: doneCount(rec), total: rec.steps.length })}</span
              >
            </div>
            {#if rec.prTitle}<div class="ow-pr-title">{rec.prTitle}</div>{/if}
            <div class="ow-card-meta">
              <span class="ow-ago"
                >{m.owed_merged_ago({ ago: formatAgo(clock.current - rec.createdAt) })}</span
              >
              {#if rec.trackingIssueUrl}
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
                <a class="ow-issue" href={rec.trackingIssueUrl} target="_blank" rel="noopener"
                  >{m.owed_tracking_issue()}</a
                >
              {/if}
              <button
                type="button"
                class="ow-dismiss"
                class:armed={armed === rec.sessionId}
                title={m.owed_dismiss_title()}
                onclick={() => clickDismiss(rec.sessionId)}
                >{armed === rec.sessionId ? m.owed_dismiss_confirm() : m.owed_dismiss()}</button
              >
            </div>
          </header>
          <ul class="ow-steps">
            {#each rec.steps as step (step.id)}
              <li class="ow-step" class:done={step.doneAt != null}>
                <label class="ow-step-label">
                  <input
                    type="checkbox"
                    checked={step.doneAt != null}
                    aria-label={m.owed_step_toggle()}
                    onchange={(e) => toggleStep(rec, step.id, e.currentTarget.checked)}
                  />
                  <span class="ow-step-text">
                    {#if step.postMerge}<span class="ow-pm-badge">{m.owed_post_merge_badge()}</span
                      >{/if}
                    {step.text}
                  </span>
                </label>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .owed {
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    overflow: auto;
    min-height: 0;
    flex: 1;
  }
  .ow-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-line);
  }
  .ow-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .ow-empty {
    padding: 24px 16px;
    color: var(--color-muted);
    font-size: var(--fs-sm);
  }
  .ow-note {
    margin: 0;
    padding: 10px 16px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    border-bottom: 1px solid var(--color-line);
  }
  .ow-list {
    display: flex;
    flex-direction: column;
  }
  .ow-card {
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-line);
  }
  .ow-card.focus {
    outline: 2px solid var(--status-warn);
    outline-offset: -2px;
  }
  .ow-card--frozen .ow-step-text {
    color: var(--color-muted);
  }
  .ow-frozen-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .ow-card-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ow-card-id {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  /* Quiet repo identity marker ahead of the designation — mirrors EpicGroupHeader's
     .repo / .repo-icon (icon only when set, no ▣ fallback). */
  .ow-repo {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    max-width: 16ch;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .ow-repo-icon {
    flex: none;
  }
  .ow-desig {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--color-ink-bright);
  }
  .ow-pr {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .ow-count {
    margin-left: auto;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .ow-pr-title {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .ow-card-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 2px;
  }
  .ow-ago {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .ow-issue {
    font-size: var(--fs-meta);
    color: var(--color-accent);
    text-decoration: none;
  }
  .ow-issue:hover {
    text-decoration: underline;
  }
  .ow-dismiss {
    margin-left: auto;
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    padding: 2px 6px;
    font-size: var(--fs-meta);
    color: var(--color-faint);
    transition: color 0.12s ease;
  }
  .ow-dismiss:hover {
    color: var(--color-ink);
  }
  .ow-dismiss.armed {
    color: var(--color-red);
  }
  .ow-steps {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ow-step-label {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    cursor: pointer;
    font-size: var(--fs-sm);
    color: var(--color-ink);
  }
  .ow-step-label input {
    margin-top: 2px;
    accent-color: var(--color-green);
  }
  .ow-step.done .ow-step-text {
    color: var(--color-faint);
    text-decoration: line-through;
  }
  .ow-pm-badge {
    display: inline-block;
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    color: var(--color-amber);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    padding: 0 4px;
    margin-right: 4px;
  }
</style>
