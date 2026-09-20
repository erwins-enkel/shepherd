<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { redeemCodexReset, setCodexResetAutomation } from "$lib/api";
  import type { CodexResetStatus } from "$lib/types";
  import type { TooltipExplanation } from "$lib/tooltips/content";
  import { statusTip } from "$lib/tooltips/statusTip.svelte";

  let { status }: { status: CodexResetStatus } = $props();
  let pending = $state(false);
  let failed = $state(false);
  let current = $derived(status);
  let resolving = false;
  let requestId: string | null = null;
  const busy = $derived(pending || current.state === "redeeming" || current.state === "verifying");
  const stateText = $derived(
    {
      ready: m.topbar_codex_reset_ready(),
      waiting: m.topbar_codex_reset_waiting(),
      unavailable: m.topbar_codex_reset_unavailable(),
      redeeming: m.topbar_codex_reset_redeeming(),
      verifying: m.topbar_codex_reset_verifying(),
      account_changed: m.topbar_codex_reset_account_changed(),
    }[current.state],
  );
  const reasonText = $derived(
    current.reason
      ? {
          capacity: m.topbar_codex_reset_reason_capacity(),
          expiry: m.topbar_codex_reset_reason_expiry(),
          manual: m.topbar_codex_reset_reason_manual(),
        }[current.reason]
      : null,
  );
  const outcomeText = $derived(
    current.lastOutcome
      ? {
          reset: m.topbar_codex_reset_outcome_reset(),
          alreadyRedeemed: m.topbar_codex_reset_outcome_alreadyRedeemed(),
          nothingToReset: m.topbar_codex_reset_outcome_nothingToReset(),
          noCredit: m.topbar_codex_reset_outcome_noCredit(),
        }[current.lastOutcome]
      : null,
  );
  const explanation: TooltipExplanation = $derived({
    title: m.topbar_codex_reset_title(),
    summary: m.topbar_codex_reset_summary(),
    sections: [
      { label: m.topbar_codex_reset_when_label(), text: m.topbar_codex_reset_when() },
      { label: m.topbar_codex_reset_cost_label(), text: m.topbar_codex_reset_cost() },
      { label: m.topbar_codex_reset_wait_label(), text: m.topbar_codex_reset_wait() },
    ],
  });
  async function redeem() {
    if (busy) return;
    pending = true;
    failed = false;
    if (resolving) {
      requestId = null;
      resolving = false;
    }
    requestId ??= crypto.randomUUID();
    try {
      current = await redeemCodexReset(requestId);
      resolving = current.state === "redeeming" || current.state === "verifying";
      if (!resolving) requestId = null;
    } catch {
      failed = true;
    } finally {
      pending = false;
    }
  }
  async function toggle(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const enabled = input.checked;
    input.checked = current.autoEnabled;
    pending = true;
    failed = false;
    try {
      current = await setCodexResetAutomation(enabled);
    } catch {
      failed = true;
    } finally {
      pending = false;
    }
  }
</script>

<div class="codex-resets">
  <div class="reset-heading">
    <span
      >{current.availableCount === null
        ? m.topbar_codex_reset_unknown()
        : m.topbar_codex_reset_count({ count: current.availableCount })}</span
    >
    <button
      class="gbtn"
      type="button"
      use:statusTip={{ text: explanation }}
      aria-label={m.topbar_codex_reset_title()}>?</button
    >
  </div>
  {#if current.nextExpiryAt !== null}
    <div>
      {m.topbar_codex_reset_expiry({ time: new Date(current.nextExpiryAt).toLocaleString() })}
    </div>
  {/if}
  <div class="reset-actions">
    <button
      class="gbtn"
      type="button"
      onclick={redeem}
      disabled={busy ||
        current.availableCount === null ||
        current.availableCount === 0 ||
        current.state === "account_changed" ||
        current.state === "unavailable"}>{m.topbar_codex_reset_redeem()}</button
    >
    <label
      ><input
        type="checkbox"
        checked={current.autoEnabled}
        disabled={pending}
        onchange={toggle}
      />{m.topbar_codex_reset_auto()}</label
    >
  </div>
  <div role="status">{stateText}</div>
  {#if current.waitingCount > 0}<div>
      {m.topbar_codex_reset_pending({ count: current.waitingCount })}
    </div>{/if}
  {#if reasonText}<div>{reasonText}</div>{/if}
  {#if outcomeText}<div>{outcomeText}</div>{/if}
  {#if failed}<div class="reset-error" role="alert">{m.topbar_codex_reset_failed()}</div>{/if}
</div>

<style>
  .codex-resets {
    display: grid;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--color-line);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }
  .reset-heading,
  .reset-actions {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  label {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  input {
    accent-color: var(--color-amber);
  }
  .gbtn {
    padding: 5px 9px;
    border: 1px solid var(--color-line-bright);
    border-radius: 4px;
    background: var(--color-inset);
    color: var(--color-ink);
    font: inherit;
    cursor: pointer;
  }
  .gbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .gbtn:focus-visible,
  input:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  .reset-error {
    color: var(--color-red);
  }
  @media (pointer: coarse) {
    .gbtn,
    label {
      min-height: 44px;
    }
  }
</style>
