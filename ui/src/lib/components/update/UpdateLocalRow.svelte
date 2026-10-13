<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { lastLogLine, type LocalUpdate } from "./local-update.svelte.js";
  import UpdateRow from "./UpdateRow.svelte";
  import UpdateDirty from "./UpdateDirty.svelte";
  import UpdateDeployLog from "./UpdateDeployLog.svelte";
  import UpdateDiscardButton from "./UpdateDiscardButton.svelte";

  // This Shepherd as one row among its machines: the same flow as alone, its state in the row.
  let {
    local,
    name,
    platform,
    tagged,
    queued,
    locked,
  }: {
    local: LocalUpdate;
    name: string;
    platform: string | null;
    /** The name is the machine's own (not the "this machine" fallback): tag it as this one. */
    tagged: boolean;
    /** Waiting for the other machines in an "update all". */
    queued: boolean;
    /** Something else is running: starting this one now would cut it off. */
    locked: boolean;
  } = $props();

  const update = $derived(local.update);
  const mode = $derived(local.mode);
  const showDetail = $derived(
    mode === "progress" ||
      mode === "dirty" ||
      mode === "toolarge" ||
      mode === "rawlog" ||
      mode === "nowclean" ||
      local.error !== null,
  );
</script>

{#snippet status()}
  {#if queued}
    <span class="muted">{m.updatemodal_row_waiting()}</span>
  {:else if mode === "progress"}
    <span class="spin" aria-hidden="true"></span>
    <span class="amber">{m.updatemodal_updating()}</span>
  {:else if update.behind <= 0}
    <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="M5 12.5l4.5 4.5L19 7.5" /></svg
    >
    <span class="muted">{m.updatemodal_row_current()}</span>
  {:else if mode === "dirty" || mode === "toolarge"}
    <span class="err">{m.updatemodal_row_blocked()}</span>
  {:else if mode === "rawlog"}
    <span class="err">{m.updatemodal_row_failed()}</span>
  {:else}
    <button
      type="button"
      class="run small"
      aria-label={m.updatemodal_update_named({ name })}
      onclick={() => local.runUpdate()}
      disabled={locked || mode === "loading"}>{m.updatemodal_row_update()}</button
    >
  {/if}
{/snippet}

{#snippet detail()}
  <div class="local-detail">
    {#if mode === "dirty" || mode === "toolarge"}
      <UpdateDirty
        dirty={local.dirty}
        body={m.updatemodal_dirty_body()}
        stale={local.staleHint}
        arming={local.arming}
      >
        {#snippet actions()}
          {#if local.arming}
            <button type="button" class="later small" onclick={() => (local.arming = false)}>
              {m.common_cancel()}
            </button>
          {/if}
          {#if mode === "dirty"}<UpdateDiscardButton {local} />{/if}
        {/snippet}
      </UpdateDirty>
    {:else if mode === "nowclean"}
      <div class="status">{m.updatemodal_now_clean()}</div>
    {:else}
      <UpdateDeployLog {local} />
    {/if}
    {#if mode === "rawlog"}
      <div class="row-actions">
        <button type="button" class="run small" onclick={() => local.runUpdate()} disabled={locked}>
          {m.updatemodal_retry()}
        </button>
      </div>
    {/if}
    {#if local.error}<div class="err">{local.error}</div>{/if}
  </div>
{/snippet}

<UpdateRow
  {name}
  local={tagged}
  {platform}
  from={update.current}
  to={update.latest}
  behind={update.behind}
  at={update.current ? m.updatemodal_row_at({ sha: update.current }) : null}
  commits={update.commits}
  progress={local.liveLog ? lastLogLine(local.liveLog) : null}
  {status}
  detail={showDetail ? detail : undefined}
/>

<style>
  .local-detail {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
</style>
