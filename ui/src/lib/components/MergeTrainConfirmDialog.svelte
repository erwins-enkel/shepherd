<script lang="ts">
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  let {
    repoLabel,
    items,
    handpicked,
    otherRepoCount,
    onclose,
    onconfirm,
  }: {
    /** Short repo name (basename) for the desc line. */
    repoLabel: string;
    /** PRs the train will work through — `#<number> <title>` per row. */
    items: { number: number; title: string }[];
    /** false = ready-group path (genuinely flagged ready); true = backlog hand-pick. */
    handpicked: boolean;
    /** Ready PRs in OTHER repos excluded from this train (>0 only on the ready path). */
    otherRepoCount: number;
    onclose: () => void;
    /** Launch the merge train. */
    onconfirm: () => void;
  } = $props();
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
    aria-label={m.mergetrain_confirm_title()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.mergetrain_confirm_title()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    <p class="desc">
      {#if handpicked}
        {m.mergetrain_confirm_desc_picked({ count: items.length, repo: repoLabel })}
      {:else}
        {m.mergetrain_confirm_desc_ready({ count: items.length, repo: repoLabel })}
      {/if}
    </p>

    <div class="rows">
      {#each items as it (it.number)}
        <div class="row">
          <span class="num">#{it.number}</span>
          <span class="nm">{it.title}</span>
        </div>
      {/each}
    </div>

    {#if otherRepoCount > 0}
      <p class="warn">{m.mergetrain_confirm_other_repos({ count: otherRepoCount })}</p>
    {/if}

    <div class="actions">
      <button type="button" class="ghost" onclick={onclose}>{m.common_cancel()}</button>
      <button type="button" class="run" onclick={onconfirm}>
        {m.mergetrain_confirm_action()}
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
    z-index: 20;
  }
  .card {
    width: min(440px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .chead {
    display: flex;
    align-items: center;
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .desc {
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.4;
  }
  .rows {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    display: flex;
    flex-direction: column;
    max-height: 200px;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .row:last-child {
    border-bottom: 0;
  }
  .num {
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    color: var(--color-blue);
  }
  .nm {
    font-family: var(--font-mono, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .warn {
    margin: 0;
    color: var(--color-amber);
    font-size: var(--fs-meta);
    line-height: 1.4;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
  }
  .ghost,
  .run {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .run {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      height: 100dvh;
      border: 0;
      overflow-y: auto;
    }
  }
</style>
