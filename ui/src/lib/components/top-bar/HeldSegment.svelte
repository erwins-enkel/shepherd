<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { formatResetIn } from "#lib/format.js";

  // The hourglass + held count, shared by both usage-panel triggers: the standalone held badge and
  // the segment the usage gauge grows while tasks are held. `full` adds the label and the reset;
  // compact keeps the label for screen readers only.
  let {
    count,
    full,
    resetAt,
    nowMs,
  }: {
    count: number;
    full: boolean;
    /** When held tasks can start again (Claude's hotter window); null hides the reset. */
    resetAt: number | null;
    nowMs: number;
  } = $props();
</script>

<span class="held-seg">
  <svg
    class="held-glyph"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M5 2h14M5 22h14" />
    <path d="M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2" />
    <path d="M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22" />
  </svg>
  {#if full}
    <span>{m.topbar_held_badge({ count })}</span>
    {#if resetAt}
      <span class="held-reset">{m.topbar_held_resets({ time: formatResetIn(resetAt, nowMs) })}</span
      >
    {/if}
  {:else}
    <span class="held-n">{count}</span>
    <span class="vh">{m.topbar_held_badge({ count })}</span>
  {/if}
</span>

<style>
  .held-seg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--color-amber);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    line-height: 1;
    white-space: nowrap;
  }
  /* The hourglass (#1122) centers instead of stretching the box, so the control keeps the shared
     bar height. */
  .held-glyph {
    display: block;
    width: 1.15em;
    height: 1.15em;
    flex-shrink: 0;
  }
  .held-n {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .held-reset {
    color: color-mix(in srgb, var(--color-amber) 70%, transparent);
    font-size: var(--fs-micro);
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
