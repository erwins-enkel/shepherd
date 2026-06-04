<script lang="ts">
  import { untrack } from "svelte";
  import { getTodo, listIssues, getCommands } from "$lib/api";
  import type { Issue, SlashCommand } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    repoPath,
    onpick,
    onpickissue,
  }: {
    repoPath: string;
    onpick: (prompt: string) => void;
    onpickissue: (issue: Issue) => void;
  } = $props();

  let tab = $state<"todo" | "issues" | "commands">("todo");
  let todos = $state<string[]>([]);
  let issues = $state<Issue[]>([]);
  let commands = $state<SlashCommand[]>([]);
  let slug = $state<string | null>(null);
  let loading = $state(false);
  let filter = $state("");
  let filterInput = $state<HTMLInputElement>();
  // null = TODO.md presence not yet resolved for this repo; hide the tab until known.
  let hasTodo = $state<boolean | null>(null);

  const OPEN_RE = /^\s*-\s\[ \]\s+(.*)$/;

  // Resolve TODO.md eagerly per repo (independent of the active tab) so the To-Do
  // tab is hidden outright when the repo has no TODO.md, and the panel opens on
  // Issues instead of a dead empty To-Do tab.
  $effect(() => {
    const rp = repoPath;
    hasTodo = null;
    todos = [];
    if (!rp) return;
    getTodo(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        hasTodo = r.exists;
        const matches: string[] = [];
        for (const line of r.content.split("\n")) {
          const match = OPEN_RE.exec(line);
          if (match) matches.push(match[1].trim());
        }
        todos = matches;
        // Don't leave the user on a tab that's about to vanish.
        if (!r.exists) untrack(() => tab === "todo" && (tab = "issues"));
      })
      .catch(() => {
        if (rp !== repoPath) return;
        hasTodo = false;
        todos = [];
        untrack(() => tab === "todo" && (tab = "issues"));
      });
  });

  $effect(() => {
    const rp = repoPath;
    const t = tab;
    if (!rp || t === "todo") return; // todo is loaded eagerly above
    loading = true;
    if (t === "commands") {
      getCommands(rp)
        .then((r) => {
          if (rp !== repoPath || t !== tab) return;
          commands = r.commands;
          loading = false;
        })
        .catch(() => {
          if (rp !== repoPath || t !== tab) return;
          commands = [];
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

  // Case-insensitive typeahead over name + description (the list spans every
  // installed skill/command, so narrowing is the primary way to find one).
  const filteredCommands = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
  });

  // Land the caret in the filter as soon as the Commands tab is ready, so the
  // user can just start typing to narrow. Deps are tab/loading only — typing in
  // the filter doesn't re-run this, so it never steals focus mid-search.
  $effect(() => {
    if (tab === "commands" && !loading) filterInput?.focus();
  });
</script>

<div class="ps-wrap">
  <div class="ps-head">
    <span class="micro seed-label">{m.promptsources_title()}</span>
    <div class="tabs">
      {#if hasTodo}
        <button
          class="tab"
          class:active={tab === "todo"}
          type="button"
          onclick={() => (tab = "todo")}
        >
          {m.promptsources_todo_tab()}
        </button>
      {/if}
      <button
        class="tab"
        class:active={tab === "issues"}
        type="button"
        onclick={() => (tab = "issues")}
      >
        {m.promptsources_issues_tab()}
      </button>
      <button
        class="tab"
        class:active={tab === "commands"}
        type="button"
        onclick={() => (tab = "commands")}
      >
        {m.promptsources_commands_tab()}
      </button>
    </div>
  </div>

  <div class="ps-body">
    {#if loading || (tab === "todo" && hasTodo === null)}
      <div class="muted">{m.common_loading()}</div>
    {:else if tab === "todo"}
      {#if todos.length === 0}
        <div class="muted">{m.promptsources_no_todos()}</div>
      {:else}
        {#each todos as text (text)}
          <button class="row" type="button" onclick={() => onpick(text)}>
            <span class="row-marker">□</span>
            <span class="row-text">{text}</span>
          </button>
        {/each}
      {/if}
    {:else if tab === "commands"}
      <input
        class="cmd-filter"
        type="text"
        bind:this={filterInput}
        bind:value={filter}
        placeholder={m.promptsources_commands_filter()}
        aria-label={m.promptsources_commands_filter()}
      />
      {#if filteredCommands.length === 0}
        <div class="muted">{m.promptsources_no_commands()}</div>
      {:else}
        {#each filteredCommands as c (c.scope + ":" + c.name)}
          <button class="row" type="button" onclick={() => onpick("/" + c.name + " ")}>
            <span class="row-marker">/</span>
            <span class="cmd-name">{c.name}</span>
            <span class="row-text cmd-desc">{c.description}</span>
            {#if c.scope === "user"}<span class="chip">user</span>{/if}
          </button>
        {/each}
      {/if}
    {:else if slug === null}
      <div class="muted">{m.promptsources_no_github()}</div>
    {:else if issues.length === 0}
      <div class="muted">{m.common_no_open_issues()}</div>
    {:else}
      {#each issues as i (i.number)}
        <button class="row" type="button" onclick={() => onpickissue(i)}>
          <span class="issue-num">#{i.number}</span>
          <span class="row-text">{i.title}</span>
          {#if i.labels.length > 0}
            <span class="chips">
              {#each i.labels.slice(0, 3) as lbl (lbl)}
                <span class="chip">{lbl}</span>
              {/each}
              {#if i.labels.length > 3}
                <span class="chip chip-more" title={i.labels.slice(3).join(", ")}>
                  {m.promptsources_more_labels({ count: i.labels.length - 3 })}
                </span>
              {/if}
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
    font-size: var(--fs-micro);
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
    font-size: var(--fs-micro);
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
    font-size: var(--fs-meta);
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
    font-size: var(--fs-base);
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
    font-size: var(--fs-micro);
  }

  .issue-num {
    color: var(--color-muted);
    flex-shrink: 0;
    font-size: var(--fs-meta);
  }

  /* Sticky so it stays put while the (potentially long) command list scrolls. */
  .cmd-filter {
    position: sticky;
    top: 0;
    z-index: 1;
    margin: 0 8px 4px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 4px 8px;
    border-radius: 2px;
  }

  .cmd-filter:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }

  .cmd-name {
    color: var(--color-ink-bright);
    flex-shrink: 0;
  }

  .cmd-desc {
    color: var(--color-faint);
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
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-slate);
    border: 1px solid var(--color-faint);
    border-radius: 2px;
    padding: 0 4px;
  }

  .chip-more {
    color: var(--color-muted);
    border-color: transparent;
    cursor: default;
  }
</style>
