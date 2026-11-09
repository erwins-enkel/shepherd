<script lang="ts">
  import type { Epic } from "#lib/types.js";
  import HerdGroup from "./HerdGroup.svelte";
  import type { HerdRowCtx } from "./HerdGroup.svelte";
  import EpicGroupHeader from "../EpicGroupHeader.svelte";
  import type { SessionlessEpicWait } from "../epic-sessionless";
  import { m } from "#lib/paraglide/messages.js";

  type EpicGroupEntry = {
    key: string;
    epic: Epic;
    sessions: import("#lib/types.js").Session[];
    /** Set on a running/paused epic with no child session (#3814): the group says why it waits
     *  instead of listing rows. */
    wait?: SessionlessEpicWait;
  };

  let {
    groups,
    collapsedKeys,
    cuesFor,
    onepic,
    oncollapsetoggle,
    slotsFor = () => null,
    ctx,
  }: {
    groups: EpicGroupEntry[];
    collapsedKeys: Set<string>;
    cuesFor: (g: { key: string; sessions: import("#lib/types.js").Session[] }) => {
      ciFailed: number;
      needsRework: number;
      branchProtectionBlocked: number;
      ready: number;
      blocked: number;
    };
    onepic?: (repoPath: string, issueNumber: number) => void;
    oncollapsetoggle?: (key: string) => void;
    /** A repo's agent slots (its drain cap); null when unknown. */
    slotsFor?: (repoPath: string) => number | null;
    ctx: HerdRowCtx;
  } = $props();
</script>

{#each groups as g, i (g.key)}
  <!-- Only the first badge anchors the coachmark: coachTargets keys one node per id. -->
  <EpicGroupHeader
    epic={g.epic}
    collapsed={collapsedKeys.has(g.key)}
    cues={cuesFor(g)}
    nowMs={ctx.nowMs}
    slots={slotsFor(g.epic.repoPath)}
    coachId={i === 0 ? "epic-timing" : ""}
    sessionless={!!g.wait}
    ontoggle={() => oncollapsetoggle?.(g.key)}
    {onepic}
  />
  {#if !collapsedKeys.has(g.key)}
    {#if g.wait}
      <div class="epic-sessionless">
        <p class="sl-status">{g.wait.status}</p>
        {#each g.wait.lines as line, j (j)}
          <p class="sl-line">{line}</p>
        {/each}
        <button
          type="button"
          class="gbtn"
          onclick={() => onepic?.(g.epic.repoPath, g.epic.parentIssueNumber)}
          >{m.epic_sessionless_open()}</button
        >
      </div>
    {:else}
      <div class="epic-children">
        <HerdGroup sessions={g.sessions} withPreview={true} {ctx} />
      </div>
    {/if}
  {/if}
{/each}

<style>
  /* Child rows of an epic group nest by indentation alone: their pips shift one --nest step
     right of the top-level pips. No rail — a vertical line here doubled up with the rows'
     own edges. */
  .epic-children {
    --nest: 20px;
  }
  .epic-children :global(.unit) {
    padding-left: calc(14px + var(--nest));
  }
  @container herd (max-width: 300px) {
    .epic-children {
      --nest: 12px;
    }
  }

  /* #3814: a session-less epic's wait note, nested like child rows would be. */
  .epic-sessionless {
    --nest: 20px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 4px 8px 8px calc(14px + var(--nest));
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  @container herd (max-width: 300px) {
    .epic-sessionless {
      --nest: 12px;
    }
  }
  .epic-sessionless p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .sl-status {
    color: var(--color-ink);
  }
  /* canonical .gbtn recipe (/design-system) */
  .gbtn {
    margin-top: 2px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
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
</style>
