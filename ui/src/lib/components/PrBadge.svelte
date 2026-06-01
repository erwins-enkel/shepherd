<script lang="ts">
  import type { GitState } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { prBadgeLabel } from "./pr-badge";

  let { git }: { git?: GitState } = $props();
  const label = $derived(prBadgeLabel(git));
  // CI only matters on an open PR; `none` means no checks reported.
  const showCi = $derived(git?.state === "open" && git.checks !== "none");
</script>

{#if label}
  <span class="pr-wrap">
    <span class="pr-badge pr-{git!.state}">{label}</span>
    {#if showCi}
      <span
        class="dot dot-{git!.checks}"
        title={m.gitrail_ci_status({ status: git!.checks })}
        aria-label={m.gitrail_ci_status({ status: git!.checks })}
      ></span>
    {/if}
  </span>
{/if}

<style>
  .pr-wrap {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .pr-badge {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: nowrap;
    color: var(--color-muted);
  }
  .pr-open {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .pr-merged {
    color: var(--color-slate);
  }
  .pr-none,
  .pr-closed {
    color: var(--color-faint);
  }

  /* mirrors GitRail's CI dot so the list reads the same as the detail panel */
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
    background: var(--color-faint);
  }
  .dot-pending {
    background: var(--color-amber);
  }
  .dot-success {
    background: var(--color-blue, #4a90d9);
  }
  .dot-failure {
    background: var(--color-red, #d9534f);
  }
</style>
