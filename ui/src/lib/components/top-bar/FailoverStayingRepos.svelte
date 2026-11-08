<script lang="ts">
  import { onMount } from "svelte";
  import { getRepoRunDefaults, type RepoRunDefaults } from "#lib/api.js";
  import { reposStayingOn } from "#lib/repo-cli.js";
  import type { AgentProvider, Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";

  // The repos a failover does not move (#3448): the switch only changes the global default, so a
  // repo set to the exhausted CLI keeps starting there. Only the ones with sessions on this
  // machine are named — without any, the pin means nothing right now and nothing renders. Loaded
  // once per mount (the usage panel mounts on open); loading or a failed read shows nothing, it
  // is a hint, not a state the switch depends on.
  let {
    from,
    sessions,
    onOpenRepo,
  }: {
    from: AgentProvider;
    sessions: readonly Session[];
    onOpenRepo: (repoPath: string) => void;
  } = $props();

  let rows = $state<RepoRunDefaults[]>([]);

  onMount(async () => {
    try {
      rows = (await getRepoRunDefaults()).repos;
    } catch {
      // best-effort; the hint stays away
    }
  });

  const staying = $derived(reposStayingOn(rows, sessions, from));
  const providerName = $derived(
    from === "claude" ? m.agent_provider_claude() : m.agent_provider_codex(),
  );
  const sessionCount = (count: number) =>
    count === 1
      ? m.usage_failover_staying_sessions_one()
      : m.usage_failover_staying_sessions_other({ count });
</script>

{#if staying.length > 0}
  <div class="staying">
    <span class="staying-title">{m.usage_failover_staying_title({ provider: providerName })}</span>
    <ul>
      {#each staying as r (r.repoPath)}
        <li>
          <button
            type="button"
            class="staying-repo"
            aria-label={m.usage_failover_staying_open_aria({
              repo: r.name,
              sessions: sessionCount(r.sessions),
            })}
            onclick={() => onOpenRepo(r.repoPath)}
          >
            <span class="name">{r.name}</span>
            <span class="count">· {sessionCount(r.sessions)}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .staying {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .staying-title {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    line-height: 1.35;
  }
  ul {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .staying-repo {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    min-width: 0;
    padding: 3px 0;
    background: none;
    border: 0;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    text-align: left;
    cursor: pointer;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    flex-shrink: 0;
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  .staying-repo:hover .name,
  .staying-repo:focus-visible .name {
    color: var(--color-ink-bright);
    text-decoration: underline;
  }
  .staying-repo:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  @media (pointer: coarse) {
    .staying-repo {
      min-height: 44px;
      align-items: center;
    }
  }
</style>
