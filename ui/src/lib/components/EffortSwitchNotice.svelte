<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { effortSwitchLine, type EffortSwitchState } from "#lib/effort-switch.js";

  // PlanPanel's effort-switch notice (#3434). A withheld Go is a warning with its two ways out;
  // an unrestored planning effort is informational only — nothing the operator can act on now.
  let {
    state,
    busy,
    ongo,
  }: {
    state: EffortSwitchState;
    busy: boolean;
    /** `skipEffortSwitch` = Go at planning effort; false = plain Retry Go. */
    ongo: (skipEffortSwitch: boolean) => void;
  } = $props();
</script>

{#if state.kind === "withheld"}
  <div class="es-notice warn" role="alert">
    <p>{effortSwitchLine(state)}</p>
    <div class="es-actions">
      <button type="button" class="es-btn" disabled={busy} onclick={() => ongo(false)}
        >{m.effort_switch_retry_go()}</button
      >
      <button type="button" class="es-btn primary" disabled={busy} onclick={() => ongo(true)}
        >{m.effort_switch_go_planning()}</button
      >
    </div>
  </div>
{:else}
  <p class="es-notice" role="status">{effortSwitchLine(state)}</p>
{/if}

<style>
  .es-notice {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.4;
  }
  .es-notice.warn {
    border-color: color-mix(in srgb, var(--color-amber) 52%, var(--color-line));
    background: color-mix(in srgb, var(--color-amber) 10%, transparent);
    color: var(--color-ink);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .es-notice p {
    margin: 0;
  }
  .es-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .es-btn {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 8px 14px;
    border-radius: 2px;
    cursor: pointer;
  }
  .es-btn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .es-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
