<script lang="ts">
  import { onMount } from "svelte";
  import type { DrainRunSummary, Epic } from "#lib/types.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { m } from "#lib/paraglide/messages.js";
  import { getEpic } from "#lib/api.js";
  import { repos } from "#lib/repos.svelte.js";
  import { supersedeImpact } from "../epic-panel";

  // Asks before starting epic `parent` supersedes `leader`, the epic that leads the repo now
  // (#2623): the server keeps one epic per repo, so the leader stops starting new tasks. Unless
  // `parent` is already queued, it offers — preselected — to queue it behind `behind` instead
  // (#2624), so it starts on its own once that epic is complete.
  let {
    repoPath,
    parent,
    leader,
    summary,
    queueable = false,
    behind = leader,
    onconfirm,
    onclose,
    onopenautomation = undefined,
  }: {
    repoPath: string;
    /** The epic about to start. */
    parent: number;
    /** The epic that leads now (`summary.leadingEpic`). */
    leader: number;
    summary: DrainRunSummary;
    /** Offer "queue after #behind" (not when `parent` is queued already). */
    queueable?: boolean;
    /** The epic a queued `parent` would wait for: the queue's tail, else the leader. */
    behind?: number;
    onconfirm: (choice: "queue" | "supersede") => void;
    onclose: () => void;
    onopenautomation?: () => void;
  } = $props();

  let record = $state<"loading" | "error" | Epic>("loading");
  onMount(() => {
    getEpic(repoPath, leader)
      .then((e) => (record = e))
      .catch(() => (record = "error"));
  });

  const repoName = $derived(
    repos.nameFor(repoPath) ?? repoPath.split("/").filter(Boolean).pop() ?? repoPath,
  );
  const loaded = $derived(typeof record === "object" ? record : null);
  const impact = $derived(supersedeImpact(leader, loaded, summary));
  const list = (nums: number[]) => nums.map((n) => `#${n}`).join(", ");
  // Captured once: the dialog opens per Start click, `queueable` does not change while it is open.
  // svelte-ignore state_referenced_locally
  let choice = $state<"queue" | "supersede">(queueable ? "queue" : "supersede");

  function openAutomation() {
    onclose();
    onopenautomation?.();
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.epic_supersede_title({ epic: parent })}
    use:dialog={{ onclose }}
    data-epic-supersede
  >
    <div class="chead">
      <h2 class="title">{m.epic_supersede_title({ epic: parent })}</h2>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    <p class="intro">{m.epic_supersede_intro({ leader, repo: repoName })}</p>

    <section class="status" aria-label={m.epic_supersede_label({ leader })}>
      <div class="status-head">
        <span class="num">#{leader}</span>
        {#if loaded}<span class="name">{loaded.parentTitle}</span>{/if}
      </div>
      {#if record === "loading"}
        <div class="line muted" aria-live="polite">{m.common_loading()}</div>
      {:else if impact.progress}
        <div class="line">{m.epic_progress(impact.progress)}</div>
      {/if}
      {#if impact.holders.length}
        {#each impact.holders as h (h.issue)}
          <div class="line">
            <span class="num">#{h.issue}</span> · {m.epic_slot_held({
              index: h.index,
              max: h.max,
            })}
          </div>
        {/each}
      {:else}
        <div class="line muted">{m.epic_run_now_empty()}</div>
      {/if}
      {#if impact.leftBehind}
        <div class="line">{m.epic_supersede_unstarted({ count: impact.leftBehind.length })}</div>
      {/if}
    </section>

    <div
      class="options"
      role={queueable ? "radiogroup" : undefined}
      aria-label={queueable ? m.epic_supersede_choice() : undefined}
    >
      {#if queueable}
        <label class="option selectable" class:chosen={choice === "queue"} data-choice="queue">
          <span class="option-title">
            <input type="radio" name="epic-start-choice" value="queue" bind:group={choice} />
            {m.epic_queue_option({ after: behind })}
          </span>
          <span class="consequence"
            >{m.epic_queue_option_body({ epic: parent, after: behind })}</span
          >
        </label>
      {/if}

      <svelte:element
        this={queueable ? "label" : "div"}
        class="option"
        class:chosen={choice === "supersede"}
        class:selectable={queueable}
        data-choice="supersede"
      >
        <span class="option-title">
          {#if queueable}
            <input type="radio" name="epic-start-choice" value="supersede" bind:group={choice} />
          {/if}
          {m.epic_supersede_now()}
        </span>
        <span class="consequence">{m.epic_supersede_stops({ leader })}</span>
        {#if impact.holders.length}
          <span class="consequence">
            {m.epic_supersede_finishes({ inflight: list(impact.holders.map((h) => h.issue)) })}
          </span>
        {/if}
        {#if impact.leftBehind?.length}
          <span class="consequence">
            {m.epic_supersede_left_behind({
              count: impact.leftBehind.length,
              list: list(impact.leftBehind),
            })}
          </span>
        {/if}
      </svelte:element>
    </div>

    <div class="actions">
      {#if onopenautomation}
        <button type="button" class="link" onclick={openAutomation}>
          {m.epic_supersede_slots()}
        </button>
      {/if}
      <button type="button" class="gbtn" onclick={onclose}>{m.common_cancel()}</button>
      <button type="button" class="gbtn primary" onclick={() => onconfirm(choice)}>
        {choice === "queue" ? m.epic_queue_confirm() : m.epic_supersede_confirm()}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
    padding: 16px;
  }
  .card {
    box-sizing: border-box;
    width: min(460px, 100%);
    max-height: 90vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 16px;
    font-family: var(--font-mono);
  }
  .chead {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .title {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .x:hover {
    color: var(--color-amber);
  }
  .intro {
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.4;
  }

  .status {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    padding: 8px 10px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .status-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    color: var(--color-ink-bright);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .num {
    color: var(--color-blue);
  }
  .muted {
    color: var(--color-muted);
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .option {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 8px 10px;
  }
  .option.selectable {
    cursor: pointer;
  }
  .option.chosen {
    border-color: var(--color-amber);
  }
  .option-title {
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
  }
  .option.chosen .option-title {
    color: var(--color-amber);
  }
  .option-title input {
    margin: 0;
    accent-color: var(--color-amber);
  }
  .option:focus-within {
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .consequence {
    display: block;
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }
  .link {
    margin-right: auto;
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover,
  .link:focus-visible {
    color: var(--color-amber);
    outline: none;
  }

  /* Canonical .gbtn recipe from /design-system (scoped copy, as in EpicDiagnosisModal). */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* Modal action a11y floor: 44×44px tap targets on mobile. */
  @media (max-width: 768px) {
    .gbtn {
      min-height: 44px;
      padding: 2px 14px;
    }
    .link {
      min-height: 32px;
    }
  }
</style>
