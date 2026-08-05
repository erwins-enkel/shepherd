<script lang="ts">
  import type { Session } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { statusTip } from "$lib/actions/statusTip.svelte";

  // `tip` (Herd card only): swap the native title for the styled statusTip tooltip.
  let { session, tip = false }: { session: Session; tip?: boolean } = $props();
</script>

{#if session.terminal}
  <span
    class="terminal-badge"
    role="img"
    aria-label={m.terminal_badge_label()}
    title={tip ? undefined : m.terminal_badge_title()}
    use:statusTip={tip ? { text: m.terminal_badge_title() } : null}
  >
    {m.terminal_badge_label()}
  </span>
{/if}

<style>
  /* Quiet informational kind-marker — same "noted info" tier as the research badge
     (slate, never green: green is reserved for READY). */
  .terminal-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-slate);
    border-radius: 2px;
    color: var(--color-slate);
    white-space: nowrap;
    font-weight: 600;
  }
</style>
