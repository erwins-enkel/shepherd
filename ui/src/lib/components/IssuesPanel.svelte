<script lang="ts">
  import { listIssues } from "$lib/api";
  import type { Issue } from "$lib/types";

  let {
    repoPath,
    onnewtask,
  }: {
    repoPath: string;
    onnewtask: (prompt: string) => void;
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
    {#if slug}ISSUES · {slug}{:else}ISSUES{/if}
  </div>

  <div class="issues-list">
    {#if loading}
      <div class="muted">loading…</div>
    {:else if slug === null}
      <div class="muted">no git host configured for this repo</div>
    {:else if issues.length === 0}
      <div class="muted">no open issues</div>
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
              title="open on GitHub">#{issue.number}</a
            >
            <a
              class="issue-title"
              href={issue.url}
              target="_blank"
              rel="noopener"
              title="open on GitHub">{issue.title}</a
            >
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
          </div>
          {#if issue.labels.length > 0}
            <div class="label-row">
              {#each issue.labels as label (label)}
                <span class="label-chip">{label}</span>
              {/each}
            </div>
          {/if}
          <div class="issue-actions">
            <button
              class="task-btn"
              onclick={() => onnewtask(`${issue.title}\n\n${issue.body}`.trim())}>+ Task</button
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
    font-size: 10px;
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
    font-size: 10.5px;
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
    font-size: 12.5px;
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
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 5px;
  }

  .issue-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 2px;
  }

  .task-btn {
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

  .task-btn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  .muted {
    font-size: 12px;
    color: var(--color-faint);
    padding: 4px 0;
  }

  @media (max-width: 768px) {
    .issues-list {
      -webkit-overflow-scrolling: touch;
    }
    .task-btn {
      min-height: 40px;
      padding: 2px 14px;
    }
  }
</style>
