<script lang="ts">
  import EmptyHerd from "../EmptyHerd.svelte";
  import { m } from "#lib/paraglide/messages.js";
  import type { SessionOrigin } from "#lib/session-origin.js";

  let {
    mode,
    machine = null,
    statusFilter,
    statusLabel,
    originFilter = null,
    originLabel = "",
    filteredRepo,
    issueActionsUnset,
    onnew,
    onsettings,
  }: {
    // "machine": the machine bar narrowed the herd to one machine (#3055) that shows nothing here
    mode: "sessions" | "shown" | "machine";
    // the picked machine's name, for "machine"
    machine?: string | null;
    statusFilter: "running" | "idle" | "blocked" | null;
    statusLabel: string;
    // the herd's origin filter (#3999) and its display label; outranks the status/repo copy
    originFilter?: SessionOrigin | null;
    originLabel?: string;
    filteredRepo: string | null;
    issueActionsUnset: boolean;
    onnew: () => void;
    onsettings?: () => void;
  } = $props();
</script>

{#if mode !== "machine" && originFilter != null}
  <div class="empty micro static">
    {mode === "shown" || statusFilter != null || filteredRepo
      ? m.herd_origin_filters_empty({ origin: originLabel })
      : m.herd_origin_filter_empty({ origin: originLabel })}
  </div>
{:else if mode === "sessions"}
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
{:else if mode === "machine" && machine}
  <div class="empty micro static">{m.herd_machine_empty({ machine })}</div>
{:else}
  <div class="empty micro static">{m.herd_ready_empty()}</div>
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
