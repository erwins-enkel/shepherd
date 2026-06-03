<script lang="ts">
  import type { Session } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let { session }: { session: Session } = $props();
</script>

{#if session.auto}
  <span
    class="auto-pip"
    title={session.issueNumber != null
      ? m.autopip_title({ number: session.issueNumber })
      : m.autopip_label()}
  >
    {m.autopip_label()}{#if session.issueNumber != null}&nbsp;#{session.issueNumber}{/if}
  </span>
{/if}

<style>
  .auto-pip {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-blue);
    border-radius: 2px;
    color: var(--color-blue);
    white-space: nowrap;
    font-weight: 600;
  }
</style>
