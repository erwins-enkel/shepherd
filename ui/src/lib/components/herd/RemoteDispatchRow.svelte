<script lang="ts">
  import type { RemoteDispatch } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { ApiError, cancelRemoteDispatch } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { remoteDispatchExplanation } from "#lib/tooltips/explanations.js";

  // A task sent to a connected machine that has not confirmed it (#2774), at the top of that
  // machine's group: its start status is unknown, or a cancel is on its way. The server settles
  // it and `remote:dispatch` then drops this row — a started task's session is in the group
  // already. Cancel makes sure it never starts there, even if it arrives late.
  let { dispatch }: { dispatch: RemoteDispatch } = $props();

  let busy = $state(false);
  const machine = $derived(dispatch.host.name);
  const label = $derived(
    dispatch.state === "canceling" ? m.remote_dispatch_canceling() : m.remote_dispatch_unknown(),
  );

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
</script>

<div
  class="dispatch-row"
  role="group"
  aria-label={m.remote_dispatch_row_aria({ machine, state: label })}
>
  <span
    class="dispatch-state"
    class:canceling={dispatch.state === "canceling"}
    use:statusTip={{ text: remoteDispatchExplanation(dispatch), wide: true }}>{label}</span
  >
  <span class="dispatch-summary">{dispatch.summary}</span>
  {#if dispatch.state === "unknown"}
    <button
      type="button"
      class="cancel"
      disabled={busy}
      aria-label={m.remote_dispatch_cancel_aria({ machine })}
      onclick={cancel}>{m.common_cancel()}</button
    >
  {/if}
</div>

<style>
  /* Not yet a session: a quiet row above the machine's sessions. The state word is amber — a
     standing condition Shepherd is resolving, not a call to act; a pending cancel stays slate. */
  .dispatch-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
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
  .dispatch-state.canceling {
    color: var(--color-slate);
  }
  .dispatch-summary {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  /* The .gbtn recipe, compact for a row. */
  .cancel {
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
  .cancel:hover:not(:disabled) {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .cancel:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .cancel:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
</style>
