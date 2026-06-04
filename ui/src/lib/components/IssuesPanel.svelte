<script lang="ts">
  import { listIssues } from "$lib/api";
  import type { Issue } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    repoPath,
    onnewtask,
    onquick = undefined,
    bodyPreview = false,
    age = false,
  }: {
    repoPath: string;
    onnewtask: (issue: Issue) => void;
    /** Quick-launch: spawn a session with the configured standard command + this
     *  issue, skipping the New Task dialog. Omitted → no quick button is shown. */
    onquick?: (issue: Issue) => void;
    bodyPreview?: boolean;
    age?: boolean;
  } = $props();

  let issues = $state<Issue[]>([]);
  let slug = $state<string | null>(null);
  let loading = $state(true);

  $effect(() => {
    const rp = repoPath;
    loading = true;
    listIssues(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        slug = r.slug;
        issues = r.issues;
        loading = false;
      })
      .catch(() => {
        loading = false;
      });
  });
</script>

<div class="issues-panel">
  <div class="issues-header">
    {#if slug}{m.issuespanel_title_with_slug({ slug })}{:else}{m.issuespanel_title()}{/if}
  </div>

  <div class="issues-list">
    {#if loading}
      <div class="muted">{m.common_loading()}</div>
    {:else if slug === null}
      <div class="muted">{m.issuespanel_no_host()}</div>
    {:else if issues.length === 0}
      <div class="muted">{m.common_no_open_issues()}</div>
    {:else}
      {#each issues as issue (issue.number)}
        <div class="issue-row">
          <div class="issue-top">
            <!-- eslint-disable svelte/no-navigation-without-resolve -- external GitHub URL, not an app route -->
            <a
              class="issue-num"
              href={issue.url}
              target="_blank"
              rel="noopener"
              title={m.issuespanel_open_on_github()}>#{issue.number}</a
            >
            <a
              class="issue-title"
              href={issue.url}
              target="_blank"
              rel="noopener"
              title={m.issuespanel_open_on_github()}>{issue.title}</a
            >
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
          </div>
          {#if bodyPreview && issue.body}
            <div class="body-preview">{issue.body}</div>
          {/if}
          {#if issue.labels.length > 0 || age}
            <div class="label-row">
              {#each issue.labels as label (label)}
                <span class="label-chip">{label}</span>
              {/each}
              {#if age}
                <span class="age-chip"
                  >{m.backlog_open_since_days({
                    days: Math.floor((Date.now() - issue.createdAt) / 86_400_000),
                  })}</span
                >
              {/if}
            </div>
          {/if}
          <div class="issue-actions">
            {#if onquick}
              <button
                class="quick-btn"
                onclick={() => onquick(issue)}
                title={m.issuespanel_quick_button_title()}>{m.issuespanel_quick_button()}</button
              >
            {/if}
            <button class="task-btn" onclick={() => onnewtask(issue)}
              >{m.issuespanel_task_button()}</button
            >
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .issues-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-inset);
    font-family: var(--font-mono);
    overflow: hidden;
  }

  .issues-header {
    padding: 6px 12px;
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }

  .issues-list {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .issues-list::-webkit-scrollbar {
    width: 4px;
  }
  .issues-list::-webkit-scrollbar-track {
    background: transparent;
  }
  .issues-list::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  .issue-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 7px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
  }

  .issue-top {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .issue-num {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    flex-shrink: 0;
    text-decoration: none;
    transition: color 0.12s;
  }

  .issue-num:hover {
    color: var(--color-ink-bright);
  }

  .issue-title {
    flex: 1;
    font-size: var(--fs-base);
    color: var(--color-ink);
    line-height: 1.4;
    word-break: break-word;
    text-decoration: none;
    transition: color 0.12s;
  }

  .issue-title:hover {
    color: var(--color-ink-bright);
  }

  .label-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .label-chip {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 5px;
  }

  .body-preview {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }

  .age-chip {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    color: var(--color-faint);
    padding: 1px 0;
  }

  .issue-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 2px;
  }

  /* Quick-launch: amber-accented to signal it's the fast path that skips the dialog. */
  .quick-btn {
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      background 0.12s,
      border-color 0.12s,
      color 0.12s;
  }

  .quick-btn:hover {
    background: color-mix(in srgb, var(--color-amber) 14%, transparent);
  }

  .task-btn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }

  .task-btn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  .muted {
    font-size: var(--fs-base);
    color: var(--color-faint);
    padding: 4px 0;
  }

  @media (max-width: 768px) {
    .issues-list {
      -webkit-overflow-scrolling: touch;
    }
    .task-btn,
    .quick-btn {
      min-height: 40px;
      padding: 2px 14px;
    }
  }
</style>
