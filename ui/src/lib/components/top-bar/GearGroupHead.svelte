<script lang="ts">
  // Group label row for the telemetry menu (PLUGINS · n, SUPPORT): uppercase faint
  // designation, optionally with a right-aligned action ("manage ▾" → a dialog
  // surface, hence aria-haspopup; plain action semantics, never a disclosure).
  let {
    label,
    mobile = false,
    action = "",
    onAction,
  }: {
    label: string;
    mobile?: boolean;
    action?: string;
    onAction?: () => void;
  } = $props();
</script>

<div class="grp-head" class:mobile>
  <span class="grp-label">{label}</span>
  {#if action}
    <button
      class="grp-action"
      type="button"
      data-gear-row
      aria-haspopup="dialog"
      onclick={() => onAction?.()}
    >
      {action} ▾
    </button>
  {/if}
</div>

<style>
  .grp-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 12px 2px;
  }
  .grp-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .grp-action {
    margin-left: auto;
    background: transparent;
    border: 0;
    padding: 0 2px;
    font: inherit;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    cursor: pointer;
  }
  .grp-action:hover {
    color: var(--color-ink);
  }
  .grp-action:focus-visible {
    outline: none;
    background: var(--color-hover);
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }
  .grp-head.mobile {
    padding: 8px 20px 0;
  }
  .grp-head.mobile .grp-label,
  .grp-head.mobile .grp-action {
    font-size: var(--fs-meta);
  }
  .grp-head.mobile .grp-action {
    padding: 8px 4px;
  }
</style>
