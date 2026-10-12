<script lang="ts">
  import type { RemoteDispatch, SessionHost } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { ApiError, cancelRemoteDispatch, redirectRemoteDispatch } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { remoteDispatchExplanation } from "#lib/tooltips/explanations.js";
  import {
    dispatchDetail,
    dispatchLabel,
    isBlocked,
    redirectLabel,
  } from "#lib/remote-dispatches.js";
  import { placementFailureMessage, runOnFailureMessage } from "../new-task/run-on.js";

  // A task for a connected machine that is not settled, at the top of that machine's group: its
  // start status is unknown or a cancel is on its way (#2774); it waits here for the machine,
  // which is out of reach or blocked; or the machine holds it, busy (#2775). The server settles it
  // and `remote:dispatch` then drops this row — a started task's session is in the group already.
  // Cancel makes sure it never starts there. A waiting task can also be run on another machine
  // that fits it now, never on its own.
  let { dispatch }: { dispatch: RemoteDispatch } = $props();

  let busy = $state(false);
  const machine = $derived(dispatch.host.name);
  const label = $derived(dispatchLabel(dispatch));
  const detail = $derived(dispatchDetail(dispatch));
  const waiting = $derived(dispatch.state === "waiting");
  const cancelable = $derived(waiting || dispatch.state === "unknown" || dispatch.state === "held");

  async function cancel() {
    busy = true;
    try {
      const d = await cancelRemoteDispatch(dispatch.id);
      if (d.state === "canceling") toasts.info(m.toast_dispatch_cancel_pending({ machine }));
    } catch (err) {
      const arrived = err instanceof ApiError && err.code === "remote_dispatch_not_cancelable";
      toasts.info(
        arrived ? m.toast_dispatch_not_cancelable({ machine }) : m.toast_dispatch_cancel_failed(),
        { alert: true },
      );
    } finally {
      busy = false;
    }
  }

  async function redirect(to: SessionHost) {
    busy = true;
    try {
      const r = await redirectRemoteDispatch(dispatch.id, to.instanceId);
      if (!("held" in r)) toasts.info(m.toast_dispatch_started_on({ machine: to.name }));
      else if (r.waiting) toasts.info(m.toast_task_waiting_for({ machine: to.name }));
      else
        toasts.info(r.host ? m.toast_task_held_on({ machine: r.host.name }) : m.toast_task_held());
    } catch (err) {
      const why =
        placementFailureMessage(err) ??
        runOnFailureMessage(err, to.name) ??
        m.toast_dispatch_redirect_failed();
      toasts.info(why, { alert: true });
    } finally {
      busy = false;
    }
  }
</script>

<div
  class="dispatch-row"
  role="group"
  aria-label={m.remote_dispatch_row_aria({ machine, state: label })}
>
  <span
    class="dispatch-state"
    class:canceling={dispatch.state === "canceling"}
    class:held={dispatch.state === "held"}
    class:blocked={isBlocked(dispatch)}
    use:statusTip={{ text: remoteDispatchExplanation(dispatch), wide: true }}>{label}</span
  >
  {#if detail}<span class="dispatch-detail">{detail}</span>{/if}
  <span class="dispatch-summary">{dispatch.summary}</span>
  {#if waiting}
    {#each dispatch.alternatives ?? [] as to (to.instanceId)}
      <button
        type="button"
        class="act"
        disabled={busy}
        aria-label={m.remote_dispatch_redirect_aria({ machine, target: to.name })}
        onclick={() => redirect(to)}>{redirectLabel(dispatch, to)}</button
      >
    {/each}
  {/if}
  {#if cancelable}
    <button
      type="button"
      class="act"
      disabled={busy}
      aria-label={m.remote_dispatch_cancel_aria({ machine })}
      onclick={cancel}>{m.common_cancel()}</button
    >
  {/if}
</div>

<style>
  /* Not yet a session: a quiet row above the machine's sessions. The state word is amber — a
     standing condition Shepherd is resolving, not a call to act: an unknown start, a task waiting
     for its machine. Blocked needs someone to fix the machine: warn. Held there and a pending
     cancel are the machine's to settle: slate. */
  /* Wraps on a narrow screen: the actions move below rather than squeezing the summary away. */
  .dispatch-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    min-width: 0;
    padding: 6px 8px;
    border-bottom: 1px dashed var(--color-line);
  }
  .dispatch-state {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    font-weight: 600;
    color: var(--color-amber);
    white-space: nowrap;
  }
  .dispatch-state.canceling,
  .dispatch-state.held {
    color: var(--color-slate);
  }
  .dispatch-state.blocked {
    color: var(--status-warn);
  }
  .dispatch-detail {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  /* Keeps the reason apart from the task's own summary that follows it. */
  .dispatch-detail::after {
    content: " ·";
  }
  .dispatch-summary {
    flex: 1 1 8rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  /* The .gbtn recipe, compact for a row. */
  .act {
    flex: none;
    padding: 2px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: none;
    color: var(--color-muted);
    font: var(--fs-meta) var(--font-mono);
    letter-spacing: 0.08em;
    cursor: pointer;
  }
  .act:hover:not(:disabled) {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .act:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .act:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
</style>
