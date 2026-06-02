<script lang="ts">
  import type { SessionStatus } from "$lib/types";
  import { STATUS_COLOR } from "$lib/format";
  let { status, ready = false }: { status: SessionStatus; ready?: boolean } = $props();
  // ready overrides status: a green ✓ reads as "parked / done, no next action".
  // A check (not a dot) so it's distinct from a `done` session, whose pip is also
  // green (--status-done === --color-green).
  const color = $derived(ready ? "var(--color-green)" : STATUS_COLOR[status]);
</script>

{#if ready}
  <span class="pip check" style="--c:{color}" aria-hidden="true">✓</span>
{:else}
  <span class="pip" class:pulse={status === "running"} style="--c:{color}"></span>
{/if}

<style>
  .pip {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--c);
    display: inline-block;
    box-shadow: 0 0 0 0 var(--c);
  }
  /* ready: a bare green check, no filled circle — the glyph itself is the signal */
  .pip.check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    box-shadow: none;
    color: var(--c);
    font-size: 10px;
    line-height: 1;
    font-weight: 700;
  }
  .pulse {
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: pip-pulse 1.5s ease-out infinite !important;
  }
</style>
