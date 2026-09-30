<script lang="ts">
  import { onMount } from "svelte";
  import type { DrainRunSummary, Epic } from "$lib/types";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import { getEpic } from "$lib/api";
  import { repos } from "$lib/repos.svelte";
  import { supersedeImpact } from "../epic-panel";

  // Asks before starting epic `parent` supersedes `leader`, the epic that leads the repo now
  // (#2623): the server keeps one epic per repo, so the leader stops starting new tasks.
  let {
    repoPath,
    parent,
    leader,
    summary,
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
    onconfirm: () => void;
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

    <div class="option">
      <div class="option-title">{m.epic_supersede_now()}</div>
      <p class="consequence">{m.epic_supersede_stops({ leader })}</p>
      {#if impact.holders.length}
        <p class="consequence">
          {m.epic_supersede_finishes({ inflight: list(impact.holders.map((h) => h.issue)) })}
        </p>
      {/if}
      {#if impact.leftBehind?.length}
        <p class="consequence">
          {m.epic_supersede_left_behind({
            count: impact.leftBehind.length,
            list: list(impact.leftBehind),
          })}
        </p>
      {/if}
    </div>

    <div class="actions">
      {#if onopenautomation}
        <button type="button" class="link" onclick={openAutomation}>
          {m.epic_supersede_slots()}
        </button>
      {/if}
      <button type="button" class="gbtn" onclick={onclose}>{m.common_cancel()}</button>
      <button type="button" class="gbtn primary" onclick={onconfirm}>
        {m.epic_supersede_confirm()}
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

  .option {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    padding: 8px 10px;
  }
  .option-title {
    color: var(--color-amber);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
  }
  .consequence {
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
