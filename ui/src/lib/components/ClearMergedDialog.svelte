<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { m } from "#lib/paraglide/messages.js";
  import { basename } from "./learnings-drawer";
  import { scopeClearMerged, sumLeftovers } from "./clear-merged-scope";

  let {
    sessions,
    leftovers,
    probesUnavailable,
    repoFilter,
    onclose,
    onconfirm,
  }: {
    /** Every merged session the server would clear, across all repos. */
    sessions: Session[];
    /** Leftover subprocesses per listed session id, totalled over the batch each action clears. */
    leftovers: Record<string, number>;
    /** This host can't detect running processes, so the leftover totals are "unknown" rather
     *  than real counts — a 0 must not read as "nothing is running" (#1923). */
    probesUnavailable: boolean;
    /** The herd's repo filter (empty = every repo). The default action clears only the merged
     *  sessions it shows; the ones it hides need the separate "all" action. */
    repoFilter: ReadonlySet<string>;
    onclose: () => void;
    /** Clear the given sessions (worktree + agent + merged branch). */
    onconfirm: (ids: string[]) => void;
  } = $props();

  const scope = $derived(scopeClearMerged(sessions, repoFilter));
  const filterName = $derived(
    repoFilter.size === 1
      ? basename([...repoFilter][0]!)
      : m.repo_filter_multi_name({ count: repoFilter.size }),
  );
  const insideLeftovers = $derived(sumLeftovers(scope.inside, leftovers));
  const outsideLeftovers = $derived(sumLeftovers(scope.outside, leftovers));
  // "shepherd 5 · BarTab 1": repo names and counts are data, not copy.
  const outsideSummary = $derived(
    scope.outsideRepos.map((r) => `${r.name} ${r.count}`).join(" · "),
  );
  let expanded = $state(false);
  // Hovering or focusing "all" marks the hidden-repo box it would add. Restyle and a same-length
  // relabel only — a layout shift here would move the very button under the pointer.
  let armed = $state(false);
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
    class:scoped={scope.outside.length > 0}
    role="dialog"
    aria-modal="true"
    aria-label={m.clearmerged_title()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.clearmerged_title()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    {#if scope.outside.length > 0}
      <p class="desc">
        {m.clearmerged_scoped_desc({ repo: filterName, count: scope.inside.length })}
      </p>
    {:else}
      <p class="desc">{m.clearmerged_desc({ count: sessions.length })}</p>
    {/if}

    {#if scope.inside.length > 0}
      <div class="rows">
        {#each scope.inside as s (s.id)}
          <div class="row">
            <span class="desig">{s.desig}</span>
            <span class="nm">{s.name}</span>
          </div>
        {/each}
      </div>
    {/if}

    {#if insideLeftovers > 0}
      <p class="warn">{m.clearmerged_leftovers({ count: insideLeftovers })}</p>
    {/if}

    {#if scope.outside.length > 0}
      <div class="outside" class:armed>
        <button
          type="button"
          class="disc"
          aria-expanded={expanded}
          onclick={() => (expanded = !expanded)}
        >
          <span class="chev" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span class="disc-text">
            <span class="disc-head">
              {armed
                ? m.clearmerged_outside_armed({ count: scope.outside.length })
                : m.clearmerged_outside({ count: scope.outside.length })}
            </span>
            <span class="disc-repos">{outsideSummary}</span>
          </span>
        </button>
        {#if outsideLeftovers > 0}
          <p class="warn nested-warn">
            {m.clearmerged_outside_leftovers({ count: outsideLeftovers })}
          </p>
        {/if}
        {#if expanded}
          <div class="rows nested">
            {#each scope.outside as s (s.id)}
              <div class="row">
                <span class="desig">{s.desig}</span>
                <span class="nm">{s.name}</span>
                <span class="repo">{basename(s.repoPath)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- OUTSIDE the count guard: the caution exists precisely for the host that reports 0. -->
    {#if probesUnavailable}
      <p class="warn">{m.clearmerged_probes_unavailable()}</p>
    {/if}

    <div class="actions">
      <button type="button" class="ghost" onclick={onclose}>{m.common_cancel()}</button>
      {#if scope.outside.length > 0}
        <button
          type="button"
          class="ghost all"
          onmouseenter={() => (armed = true)}
          onmouseleave={() => (armed = false)}
          onfocus={() => (armed = true)}
          onblur={() => (armed = false)}
          onclick={() => onconfirm(sessions.map((s) => s.id))}
        >
          {m.clearmerged_confirm_all({ count: sessions.length })}
        </button>
      {/if}
      <button
        type="button"
        class="run"
        disabled={scope.inside.length === 0}
        onclick={() => onconfirm(scope.inside.map((s) => s.id))}
      >
        {m.clearmerged_confirm({ count: scope.inside.length })}
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
    width: min(var(--card-w, 440px), 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  /* Room for three actions in one row once the hidden repos add a second decommission choice. */
  .scoped {
    --card-w: 520px;
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
  .desig {
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
  .repo {
    margin-left: auto;
    flex-shrink: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .outside {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
  }
  .outside.armed {
    border-color: var(--color-amber);
  }
  .disc {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 10px;
    background: transparent;
    border: 0;
    color: var(--color-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .chev {
    color: var(--color-muted);
  }
  .disc-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .disc-head {
    font-size: var(--fs-base);
  }
  .armed .disc-head {
    color: var(--color-amber);
  }
  .disc-repos {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .rows.nested {
    border: 0;
    border-top: 1px solid var(--color-line);
    border-radius: 0;
  }
  .nested .nm {
    color: var(--color-muted);
  }
  .armed .nested .nm {
    color: var(--color-ink-bright);
  }
  .warn {
    margin: 0;
    color: var(--color-amber);
    font-size: var(--fs-meta);
    line-height: 1.4;
  }
  .nested-warn {
    padding: 0 10px 10px 28px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
  }
  /* With an "all" action, cancel parks left and the two decommission choices sit together. */
  .all {
    margin-left: auto;
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
  .run:disabled {
    opacity: 0.5;
    cursor: default;
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
