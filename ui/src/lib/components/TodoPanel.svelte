<script lang="ts">
  import { getTodo, putTodo } from "$lib/api";
  import { ITEM_RE, isDone, toggleItem, cleanupTodo } from "$lib/todo";
  import { m } from "$lib/paraglide/messages";

  let { repoPath }: { repoPath: string } = $props();

  let content = $state("");
  let exists = $state(false);
  let loading = $state(true);
  let adding = $state("");

  $effect(() => {
    const rp = repoPath;
    loading = true;
    getTodo(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        content = r.content;
        exists = r.exists;
        loading = false;
      })
      .catch(() => {
        loading = false;
        content = "";
      });
  });

  function toggle(i: number) {
    content = toggleItem(content, i);
    putTodo(repoPath, content).catch(() => {});
  }

  function addItem() {
    const text = adding.trim();
    if (!text) return;
    if (content === "") {
      content = "- [ ] " + text + "\n";
    } else {
      content = content.trimEnd() + "\n- [ ] " + text + "\n";
    }
    exists = true;
    putTodo(repoPath, content).catch(() => {});
    adding = "";
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") addItem();
  }

  const hasDone = $derived(content.split("\n").some(isDone));

  function clearDone() {
    content = cleanupTodo(content);
    putTodo(repoPath, content).catch(() => {});
  }
</script>

<div class="todo-panel">
  <div class="todo-header">
    <span>{m.todopanel_title()}</span>
    {#if hasDone}
      <button
        class="cleanup-btn"
        type="button"
        onclick={clearDone}
        title={m.todopanel_cleanup_title()}>{m.todopanel_clear_done()}</button
      >
    {/if}
  </div>

  <div class="todo-list">
    {#if loading}
      <div class="muted">{m.common_loading()}</div>
    {:else if !exists || content.trim() === ""}
      <div class="empty-hint">{m.todopanel_empty()}</div>
    {:else}
      {#each content.split("\n") as line, i (i + ":" + line)}
        {@const match = ITEM_RE.exec(line)}
        {#if match}
          {@const done = match[2] !== " "}
          <div class="item-row">
            <input
              type="checkbox"
              class="cb"
              checked={done}
              onchange={() => toggle(i)}
              aria-label={m.todopanel_item_aria({ item: match[3] })}
            />
            <span class="item-label" class:done>{match[3]}</span>
          </div>
        {:else if line.trim() === ""}
          <div class="spacer"></div>
        {:else if line.startsWith("#")}
          <div class="line-heading">{line.replace(/^#+\s*/, "")}</div>
        {:else}
          <div class="line-plain">{line}</div>
        {/if}
      {/each}
    {/if}
  </div>

  <div class="add-row">
    <input
      class="add-input"
      type="text"
      placeholder={m.todopanel_add_placeholder()}
      aria-label={m.todopanel_add_aria()}
      bind:value={adding}
      onkeydown={handleKeydown}
    />
    <button class="add-btn" onclick={addItem}>{m.todopanel_add_button()}</button>
  </div>
</div>

<style>
  .todo-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-inset);
    font-family: var(--font-mono);
    overflow: hidden;
  }

  .todo-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 12px;
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }

  .cleanup-btn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 7px;
    cursor: pointer;
    flex-shrink: 0;
    transition:
      border-color 0.15s,
      color 0.15s;
  }

  .cleanup-btn:hover {
    border-color: var(--color-green);
    color: var(--color-green);
  }

  .todo-list {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .todo-list::-webkit-scrollbar {
    width: 4px;
  }
  .todo-list::-webkit-scrollbar-track {
    background: transparent;
  }
  .todo-list::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  .item-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
  }

  .cb {
    appearance: none;
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border: 1px solid var(--color-faint);
    border-radius: 2px;
    background: transparent;
    cursor: pointer;
    flex-shrink: 0;
    position: relative;
    top: 1px;
    transition:
      border-color 0.1s,
      background 0.1s;
  }

  .cb:checked {
    background: var(--color-green);
    border-color: var(--color-green);
  }

  .cb:checked::after {
    content: "";
    position: absolute;
    left: 2px;
    top: 0px;
    width: 5px;
    height: 8px;
    /* tick "cuts out" of the green box — inset flips with the theme so it stays
       dark-on-light-green (dark) and light-on-dark-green (light) */
    border: 1.5px solid var(--color-inset);
    border-top: none;
    border-left: none;
    transform: rotate(45deg);
  }

  .item-label {
    font-size: var(--fs-base);
    color: var(--color-ink);
    line-height: 1.5;
    word-break: break-word;
  }

  .item-label.done {
    color: var(--color-muted);
    text-decoration: line-through;
    text-decoration-color: var(--color-faint);
  }

  .spacer {
    height: 6px;
  }

  .line-heading {
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    font-weight: bold;
    padding: 4px 0 2px;
  }

  .line-plain {
    font-size: var(--fs-base);
    color: var(--color-muted);
    padding: 1px 0;
  }

  .muted,
  .empty-hint {
    font-size: var(--fs-base);
    color: var(--color-faint);
    padding: 4px 0;
  }

  .add-row {
    display: flex;
    gap: 6px;
    padding: 8px 12px;
    border-top: 1px solid var(--color-line);
    flex-shrink: 0;
  }

  .add-input {
    flex: 1;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 5px 8px;
    outline: none;
    transition: border-color 0.15s;
  }

  .add-input::placeholder {
    color: var(--color-faint);
  }

  .add-input:focus {
    border-color: var(--color-line-bright);
  }

  .add-btn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 5px 10px;
    cursor: pointer;
    transition:
      border-color 0.15s,
      color 0.15s;
  }

  .add-btn:hover {
    border-color: var(--color-green);
    color: var(--color-green);
  }

  @media (max-width: 768px) {
    .todo-list {
      -webkit-overflow-scrolling: touch;
    }
    .item-row {
      padding: 6px 0;
      align-items: center;
    }
    .cb {
      width: 18px;
      height: 18px;
      top: 0;
    }
    .cb:checked::after {
      left: 5px;
      top: 2px;
      width: 6px;
      height: 10px;
    }
    .add-input {
      font-size: var(--fs-lg); /* prevents iOS zoom-on-focus */
    }
    .add-btn {
      min-height: 40px;
    }
  }
</style>
