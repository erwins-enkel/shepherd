<script lang="ts">
  import { getTodo, listIssues } from "$lib/api";
  import type { Issue } from "$lib/types";

  let { repoPath, onpick }: { repoPath: string; onpick: (prompt: string) => void } = $props();

  let tab = $state<"todo" | "issues">("todo");
  let todos = $state<string[]>([]);
  let issues = $state<Issue[]>([]);
  let slug = $state<string | null>(null);
  let loading = $state(false);

  const OPEN_RE = /^\s*-\s\[ \]\s+(.*)$/;

  $effect(() => {
    const rp = repoPath;
    const t = tab;
    if (!rp) return;
    loading = true;
    if (t === "todo") {
      getTodo(rp)
        .then((r) => {
          if (rp !== repoPath || t !== tab) return;
          const matches: string[] = [];
          for (const line of r.content.split("\n")) {
            const m = OPEN_RE.exec(line);
            if (m) matches.push(m[1].trim());
          }
          todos = matches;
          loading = false;
        })
        .catch(() => {
          if (rp !== repoPath || t !== tab) return;
          todos = [];
          loading = false;
        });
    } else {
      listIssues(rp)
        .then((r) => {
          if (rp !== repoPath || t !== tab) return;
          slug = r.slug;
          issues = r.issues;
          loading = false;
        })
        .catch(() => {
          if (rp !== repoPath || t !== tab) return;
          slug = null;
          issues = [];
          loading = false;
        });
    }
  });
</script>

<div class="ps-wrap">
  <div class="ps-head">
    <span class="micro seed-label">Seed From</span>
    <div class="tabs">
      <button
        class="tab"
        class:active={tab === "todo"}
        type="button"
        onclick={() => (tab = "todo")}
      >
        To-Do
      </button>
      <button
        class="tab"
        class:active={tab === "issues"}
        type="button"
        onclick={() => (tab = "issues")}
      >
        Issues
      </button>
    </div>
  </div>

  <div class="ps-body">
    {#if loading}
      <div class="muted">loading…</div>
    {:else if tab === "todo"}
      {#if todos.length === 0}
        <div class="muted">no open TODO items</div>
      {:else}
        {#each todos as text (text)}
          <button class="row" type="button" onclick={() => onpick(text)}>
            <span class="row-marker">□</span>
            <span class="row-text">{text}</span>
          </button>
        {/each}
      {/if}
    {:else if slug === null}
      <div class="muted">no GitHub upstream</div>
    {:else if issues.length === 0}
      <div class="muted">no open issues</div>
    {:else}
      {#each issues as i (i.number)}
        <button class="row" type="button" onclick={() => onpick(`${i.title}\n\n${i.body}`.trim())}>
          <span class="issue-num">#{i.number}</span>
          <span class="row-text">{i.title}</span>
          {#if i.labels.length > 0}
            <span class="chips">
              {#each i.labels as lbl (lbl)}
                <span class="chip">{lbl}</span>
              {/each}
            </span>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .ps-wrap {
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    margin-top: 4px;
  }

  .ps-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px 4px;
    border-bottom: 1px solid var(--color-line);
  }

  .seed-label {
    font-size: 9.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-faint);
    flex-shrink: 0;
  }

  .micro {
    font-family: var(--font-mono);
  }

  .tabs {
    display: flex;
    gap: 2px;
    margin-left: auto;
  }

  .tab {
    background: transparent;
    border: 1px solid transparent;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 2px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }

  .tab:hover {
    color: var(--color-ink);
  }

  .tab.active {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }

  .ps-body {
    max-height: 180px;
    overflow-y: auto;
    padding: 4px 2px;
    display: flex;
    flex-direction: column;
  }

  .ps-body::-webkit-scrollbar {
    width: 3px;
  }
  .ps-body::-webkit-scrollbar-track {
    background: transparent;
  }
  .ps-body::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  .muted {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--color-faint);
    padding: 6px 10px;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    background: transparent;
    border: none;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 12px;
    text-align: left;
    padding: 4px 10px;
    cursor: pointer;
    border-radius: 2px;
    transition:
      background 0.1s,
      color 0.1s;
    width: 100%;
  }

  .row:hover {
    background: var(--color-panel);
    color: var(--color-ink-bright);
  }

  .row-marker {
    color: var(--color-faint);
    flex-shrink: 0;
    font-size: 10px;
  }

  .issue-num {
    color: var(--color-muted);
    flex-shrink: 0;
    font-size: 11px;
  }

  .row-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chips {
    display: flex;
    gap: 3px;
    flex-shrink: 0;
  }

  .chip {
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-slate);
    border: 1px solid var(--color-faint);
    border-radius: 2px;
    padding: 0 4px;
  }
</style>
