<script lang="ts">
  import type { PostMergeSteps } from "$lib/types";
  import { postMergeSteps } from "$lib/post-merge-steps.svelte";
  import { formatAgo } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";

  const records = $derived(postMergeSteps.records);

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

<div class="owed">
  <div class="ow-head">
    <span class="ow-title">{m.owed_title()}</span>
  </div>

  {#if records.length === 0}
    <div class="ow-empty">{m.owed_empty()}</div>
  {:else}
    <p class="ow-note">{m.owed_note()}</p>
    <div class="ow-list">
      {#each records as rec (rec.sessionId)}
        <section class="ow-card">
          <header class="ow-card-head">
            <div class="ow-card-id">
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
