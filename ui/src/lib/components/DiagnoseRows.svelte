<script lang="ts">
  import type { DiagnosticCheck } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    checks,
    failed = false,
    onretry,
  }: { checks: DiagnosticCheck[] | null; failed?: boolean; onretry?: () => void } = $props();

  // Dynamic message key lookup — m is typed as specific functions; cast for dynamic access.
  const msg = m as unknown as Record<string, () => string>;

  function label(id: string): string {
    return msg[`diagnostics_label_${id}`]?.() ?? id;
  }

  function hint(hintKey: string): string {
    return msg[hintKey]?.() ?? "";
  }

  function stateWord(state: DiagnosticCheck["state"]): string {
    return msg[`diagnostics_state_${state}`]?.() ?? state;
  }

  // State → color token. Design rule: never --color-green for healthy.
  // ok → --status-done (slate), warning → --color-amber, error → --color-red.
  const stateColor: Record<DiagnosticCheck["state"], string> = {
    ok: "var(--status-done)",
    warning: "var(--color-amber)",
    error: "var(--color-red)",
  };
</script>

<!-- Data wins: once checks arrive (HTTP seed or the WS push) they render even if
     an earlier seed fetch had failed. `failed` only matters while checks are null. -->
{#if checks !== null}
  {#if checks.length === 0}
    <div class="all-ok micro">{m.diagnostics_all_ok()}</div>
  {:else}
    {@const allOk = checks.every((c) => c.state === "ok")}
    {#each checks as check (check.id)}
      <div class="rc">
        <div class="row-head">
          <span class="glyph" style="color:{stateColor[check.state]}" aria-hidden="true">
            {#if check.state === "ok"}✓{:else if check.state === "warning"}⚠{:else}✗{/if}
          </span>
          <span class="micro label">{label(check.id)}</span>
          <span class="state-word micro" style="color:{stateColor[check.state]}"
            >{stateWord(check.state)}</span
          >
        </div>
        {#if check.state !== "ok"}
          <p class="hint">{hint(check.hintKey)}</p>
        {/if}
      </div>
    {/each}
    {#if allOk}
      <div class="all-ok micro">{m.diagnostics_all_ok()}</div>
    {/if}
  {/if}
{:else if failed}
  <div class="load-error">
    <span class="micro">{m.diagnostics_load_error()}</span>
    {#if onretry}
      <button type="button" class="retry micro" onclick={onretry}>{m.diagnostics_rerun()}</button>
    {/if}
  </div>
{:else}
  <div class="all-ok micro">{m.common_loading()}</div>
{/if}

<style>
  .rc {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 0;
    border-bottom: 1px solid var(--color-line);
  }
  .rc:last-of-type {
    border-bottom: none;
  }
  .row-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .glyph {
    font-size: var(--fs-base);
    width: 14px;
    text-align: center;
    flex-shrink: 0;
  }
  .label {
    flex: 1;
    color: var(--color-ink);
  }
  .state-word {
    flex-shrink: 0;
  }
  .hint {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0 0 0 22px;
    line-height: 1.5;
  }
  .all-ok {
    color: var(--color-muted);
    padding: 4px 0;
  }
  .load-error {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
    color: var(--color-red);
  }
  .retry {
    background: none;
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    padding: 4px 10px;
    cursor: pointer;
  }
  .retry:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
</style>
