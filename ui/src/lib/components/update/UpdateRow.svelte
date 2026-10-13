<script lang="ts">
  import type { Snippet } from "svelte";
  import type { UpdateCommit } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { platformLabel } from "#lib/machines.js";
  import { commitsLabel } from "#lib/machine-updates.js";

  // One machine in the update window: who it is and where it stands. The caller supplies the
  // state cell (`status`) and anything shown under the row (`detail`); while an update is due the
  // commits it would bring fold out from the name.
  let {
    name,
    local = false,
    platform = null,
    from = null,
    to = null,
    behind = 0,
    at = null,
    commits = [],
    progress = null,
    status,
    detail,
  }: {
    name: string;
    /** This Shepherd: tagged, and the one whose update restarts the page. */
    local?: boolean;
    platform?: string | null;
    /** While an update is due: running commit → target, `behind` commits apart. */
    from?: string | null;
    to?: string | null;
    behind?: number;
    /** Otherwise the line under the name ("running abc1234"), if any. */
    at?: string | null;
    commits?: UpdateCommit[];
    /** The newest line of a running deploy. */
    progress?: string | null;
    status: Snippet;
    detail?: Snippet;
  } = $props();

  let open = $state(false);
  const due = $derived(behind > 0);
</script>

{#snippet identity()}
  <span class="text">
    <span class="line">
      <span class="name">{name}</span>
      {#if local}<span class="tag">{m.updatemodal_this_machine()}</span>{/if}
      {#if platform}<span class="platform">{platformLabel(platform)}</span>{/if}
    </span>
    {#if due}
      <span class="meta"
        ><span class="sha">{from ?? "?"}</span> → <span class="sha to">{to ?? "?"}</span> · {commitsLabel(
          behind,
        )}</span
      >
    {:else if at}
      <span class="meta">{at}</span>
    {/if}
    {#if progress}<span class="meta progress">{progress}</span>{/if}
  </span>
{/snippet}

<li class="mrow" data-machine={name}>
  <div class="mhead">
    {#if due}
      <button type="button" class="who" aria-expanded={open} onclick={() => (open = !open)}>
        <svg
          class="chev"
          class:open
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg
        >
        {@render identity()}
      </button>
    {:else}
      <div class="who">
        <span class="chev-space" aria-hidden="true"></span>
        {@render identity()}
      </div>
    {/if}
    <div class="state">{@render status()}</div>
  </div>
  {#if due && open}
    <ul class="commits">
      {#each commits as c (c.sha)}
        <li><span class="sha">{c.sha}</span><span class="subject">{c.subject}</span></li>
      {/each}
    </ul>
  {/if}
  {#if detail}<div class="detail">{@render detail()}</div>{/if}
</li>

<style>
  .mrow {
    list-style: none;
    display: flex;
    flex-direction: column;
  }
  .mrow + :global(.mrow) {
    border-top: 1px solid var(--color-line);
  }
  .mhead {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 12px 12px 8px;
  }
  .who {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0;
    padding: 0;
    background: transparent;
    border: 0;
    text-align: left;
    font: inherit;
    color: inherit;
  }
  button.who {
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  button.who:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: 2px;
  }
  .chev,
  .chev-space {
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 2px;
    color: var(--color-muted);
  }
  .chev {
    transition: transform 0.15s;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }
  .line {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px 8px;
  }
  .name {
    color: var(--color-ink-bright);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .tag {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    border: 1px solid var(--color-line-bright);
    padding: 1px 6px;
  }
  .platform,
  .meta {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .meta {
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .meta .sha {
    color: var(--color-ink);
  }
  .meta .sha.to {
    color: var(--color-amber);
  }
  .state {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 7px;
    font-size: var(--fs-meta);
  }
  .commits {
    margin: -2px 12px 12px 30px;
    padding: 8px 10px;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 5px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
  }
  .commits li {
    display: flex;
    gap: 9px;
    min-width: 0;
    font-size: var(--fs-meta);
  }
  .commits .sha {
    flex: none;
    color: var(--color-amber);
    font-variant-numeric: tabular-nums;
  }
  .commits .subject {
    min-width: 0;
    color: var(--color-ink-bright);
    overflow-wrap: anywhere;
  }
  .detail {
    margin: -2px 12px 12px 30px;
  }
  @media (max-width: 768px) {
    .mhead {
      align-items: flex-start;
    }
    .commits,
    .detail {
      margin-left: 12px;
    }
  }
</style>
