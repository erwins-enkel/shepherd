<script lang="ts">
  import { onDestroy } from "svelte";
  import type { DeployState, DirtyStatus, MachineUpdate } from "#lib/types.js";
  import {
    applyMachineUpdate,
    checkRemoteInstance,
    getMachineUpdateDirty,
    getMachineUpdateLog,
    StaleDirtyError,
  } from "#lib/api.js";
  import { machineStatusLabel } from "#lib/machines.js";
  import { machineReachable, type MachinePhase } from "#lib/machine-updates.js";
  import { m } from "#lib/paraglide/messages.js";
  import { lastLogLine } from "./local-update.svelte.js";
  import UpdateRow from "./UpdateRow.svelte";
  import UpdateDirty from "./UpdateDirty.svelte";

  // A connected machine's self-update, run from here: started through the coordinator, followed
  // by polling the machine's own deploy log until it is live again, and routed through the same
  // dirty-tree flow as this Shepherd when the machine's checkout blocks the pull.
  let {
    machine,
    onphase,
  }: {
    machine: MachineUpdate;
    onphase?: (phase: MachinePhase) => void;
  } = $props();

  const POLL_MS = 1500;
  /** A deploy restarts the machine; past this without an answer it is reported, not awaited. */
  const GONE_MS = 3 * 60_000;

  let phase = $state<MachinePhase>("idle");
  let progress = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let failLog = $state<string | null>(null);
  let dirty = $state<DirtyStatus | null>(null);
  let staleHint = $state(false);
  let arming = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  onDestroy(() => {
    alive = false;
    clearTimeout(timer);
  });

  $effect(() => onphase?.(phase));

  const update = $derived(machine.update);
  const reachable = $derived(machineReachable(machine));
  const due = $derived(
    reachable && (phase === "idle" || phase === "updating") && (update?.behind ?? 0) > 0,
  );
  const at = $derived(
    phase === "done"
      ? m.updatemodal_row_now_at({ sha: update?.latest ?? "?" })
      : reachable && update?.current
        ? m.updatemodal_row_at({ sha: update.current })
        : null,
  );

  /** Start (or retry) the update; `discard` resets the confirmed dirty tree first. */
  export async function start(discard = false, sig?: string) {
    if (phase === "updating") return;
    phase = "updating";
    progress = null;
    failure = null;
    failLog = null;
    arming = false;
    try {
      await applyMachineUpdate(machine.instanceId, discard, sig);
    } catch (e) {
      if (e instanceof StaleDirtyError) {
        // the tree drifted since the list was shown → show it fresh and confirm again
        staleHint = true;
        showDirty(e.dirty);
      } else {
        failure = e instanceof Error ? e.message : m.updatemodal_update_failed();
        phase = "failed";
      }
      return;
    }
    staleHint = false;
    watch();
  }

  function showDirty(fresh: DirtyStatus) {
    if (fresh.dirty) {
      dirty = fresh;
      phase = "dirty";
    } else {
      failure = m.updatemodal_now_clean();
      phase = "failed";
    }
  }

  function watch() {
    let lastAnswer = Date.now();
    const tick = async () => {
      if (!alive) return;
      try {
        const st = await getMachineUpdateLog(machine.instanceId);
        lastAnswer = Date.now();
        if (st.phase === "done") {
          phase = "done";
          // re-probe now so the badge and this list read the new version without waiting a round
          void checkRemoteInstance(machine.instanceId).catch(() => {});
          return;
        }
        if (st.phase === "failed") {
          await settle(st);
          return;
        }
        progress = st.log ? lastLogLine(st.log) : null;
      } catch {
        // expected while the machine restarts — keep asking, but not forever
        if (Date.now() - lastAnswer > GONE_MS) {
          failure = m.updatemodal_machine_gone({ name: machine.name });
          phase = "failed";
          return;
        }
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
  }

  /** A failed deploy: a dirty or stale tree goes through the dirty flow, anything else shows why. */
  async function settle(st: DeployState) {
    if (st.reason === "dirty" || st.reason === "stale") {
      try {
        staleHint = st.reason === "stale";
        showDirty(await getMachineUpdateDirty(machine.instanceId));
        return;
      } catch {
        // could not read the tree → fall back to the raw log
      }
    }
    failure = m.updatemodal_deploy_failed();
    failLog = st.log || null;
    phase = "failed";
  }

  function skip() {
    arming = false;
    phase = "skipped";
  }
</script>

{#snippet status()}
  {#if !reachable}
    <svg class="mark warn" viewBox="0 0 24 24" aria-hidden="true"
      ><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></svg
    >
    <span class="warn">{machineStatusLabel(machine.status)}</span>
  {:else if phase === "updating"}
    <span class="spin" aria-hidden="true"></span>
    <span class="amber" aria-live="polite">{m.updatemodal_updating()}</span>
  {:else if phase === "done"}
    <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="M5 12.5l4.5 4.5L19 7.5" /></svg
    >
    <span class="done">{m.updatemodal_row_done()}</span>
  {:else if phase === "failed"}
    <span class="err">{m.updatemodal_row_failed()}</span>
  {:else if phase === "dirty"}
    <span class="err">{m.updatemodal_row_blocked()}</span>
  {:else if phase === "skipped"}
    <span class="muted">{m.updatemodal_row_skipped()}</span>
  {:else if !update}
    <span class="muted">{m.updatemodal_row_unknown()}</span>
  {:else if update.behind > 0}
    <button
      type="button"
      class="run small"
      aria-label={m.updatemodal_update_named({ name: machine.name })}
      onclick={() => start()}>{m.updatemodal_row_update()}</button
    >
  {:else}
    <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="M5 12.5l4.5 4.5L19 7.5" /></svg
    >
    <span class="muted">{m.updatemodal_row_current()}</span>
  {/if}
{/snippet}

{#snippet dirtyDetail()}
  <UpdateDirty
    {dirty}
    body={m.updatemodal_machine_dirty_body({ name: machine.name })}
    stale={staleHint}
    {arming}
  >
    {#snippet actions()}
      <button
        type="button"
        class="later small"
        onclick={() => (arming ? (arming = false) : skip())}
      >
        {arming ? m.common_cancel() : m.updatemodal_skip()}
      </button>
      {#if dirty?.sig != null}
        {#if arming}
          <button
            type="button"
            class="run small danger"
            onclick={() => start(true, dirty?.sig ?? undefined)}
          >
            {m.updatemodal_discard_confirm_yes()}
          </button>
        {:else}
          <button type="button" class="run small danger" onclick={() => (arming = true)}>
            {m.updatemodal_discard_and_update()}
          </button>
        {/if}
      {/if}
    {/snippet}
  </UpdateDirty>
{/snippet}

{#snippet failedDetail()}
  <div class="failure">
    <div class="err">{failure}</div>
    {#if failLog}<pre class="log">{failLog}</pre>{/if}
    <div class="row-actions">
      <button type="button" class="later small" onclick={skip}>{m.updatemodal_skip()}</button>
      <button type="button" class="run small" onclick={() => start()}
        >{m.updatemodal_retry()}</button
      >
    </div>
  </div>
{/snippet}

<UpdateRow
  name={machine.name}
  platform={machine.platform}
  from={update?.current ?? null}
  to={update?.latest ?? null}
  behind={due ? (update?.behind ?? 0) : 0}
  {at}
  commits={update?.commits ?? []}
  progress={phase === "updating" ? progress : null}
  {status}
  detail={phase === "dirty" ? dirtyDetail : phase === "failed" ? failedDetail : undefined}
/>

<style>
  .mark.warn {
    stroke: var(--color-warn);
    stroke-width: 2.2;
  }
  .warn {
    color: var(--color-warn);
  }
  .done {
    color: var(--color-muted);
  }
  .failure {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
</style>
