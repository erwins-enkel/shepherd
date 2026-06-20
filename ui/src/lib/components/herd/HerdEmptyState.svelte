<script lang="ts">
  import EmptyHerd from "../EmptyHerd.svelte";
  import { m } from "$lib/paraglide/messages";

  let {
    mode,
    statusFilter,
    statusLabel,
    filteredRepo,
    filter,
    issueActionsUnset,
    onnew,
    onsettings,
  }: {
    mode: "sessions" | "shown";
    statusFilter: "running" | "idle" | "blocked" | null;
    statusLabel: string;
    filteredRepo: string | null;
    filter: string;
    issueActionsUnset: boolean;
    onnew: () => void;
    onsettings?: () => void;
  } = $props();
</script>

{#if mode === "sessions"}
  {#if statusFilter != null && filteredRepo}
    <div class="empty micro static">
      {m.herd_status_repo_filter_empty({ status: statusLabel, repo: filteredRepo })}
    </div>
  {:else if statusFilter != null}
    <div class="empty micro static">
      {m.herd_status_filter_empty({ status: statusLabel })}
    </div>
  {:else if filteredRepo}
    <div class="empty micro static">{m.herd_repo_filter_empty({ repo: filteredRepo })}</div>
  {:else}
    <EmptyHerd {onnew} {issueActionsUnset} {onsettings} />
  {/if}
{:else}
  {#if filter === "research"}
    <div class="empty micro static">{m.herd_research_empty()}</div>
  {:else}
    <div class="empty micro static">{m.herd_ready_empty()}</div>
  {/if}
{/if}

<style>
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .empty {
    width: 100%;
    padding: 24px 14px;
    text-align: center;
    color: var(--color-faint);
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.12s ease;
  }
  .empty:hover {
    color: var(--color-ink);
  }
  .empty.static {
    cursor: default;
  }
  .empty.static:hover {
    color: var(--color-faint);
  }
</style>
