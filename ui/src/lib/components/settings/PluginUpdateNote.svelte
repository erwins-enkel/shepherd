<script lang="ts" module>
  /** Persisted result of an inline apply. `commits` marks a drift update — one that
   *  brought new commits without moving the version, so naming the version would read
   *  as "updated to the version you already had". */
  export type PluginApplyOutcome =
    | { kind: "live" | "restart"; version: string; commits?: boolean }
    | { kind: "error"; msg: string; detail?: string };

  /** What the last check concluded for a plugin with NO pending update. */
  export type PluginCheckedNote = { label: string; detail?: string };
</script>

<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  // The one-line note under a plugin row: either what an apply just did, or — when
  // there is nothing to apply — what the last check concluded. The second half is the
  // whole point: before it existed, a check that found nothing rendered NOTHING, so it
  // was indistinguishable from a check that never ran.
  //
  // Shared by the loaded card and the panel's minimal rows so the two can't drift apart
  // (and so neither parent template pays the branching cost twice).
  let {
    outcome = null,
    checked = null,
  }: { outcome?: PluginApplyOutcome | null; checked?: PluginCheckedNote | null } = $props();
</script>

{#if outcome}
  {@const o = outcome}
  {#if o.kind === "error"}
    <p class="upd-outcome error micro" role="alert">{o.msg}</p>
    {#if o.detail}
      <!-- server-authored diagnostic (verbatim) — makes the failure debuggable -->
      <p class="upd-detail micro">{o.detail}</p>
    {/if}
  {:else if o.kind === "restart"}
    <p class="upd-outcome micro">
      {o.commits
        ? m.pluginupdate_applied_commits_restart()
        : m.pluginupdate_applied_restart({ version: o.version })}
    </p>
  {:else}
    <p class="upd-outcome live micro">
      {o.commits
        ? m.pluginupdate_applied_commits_live()
        : m.pluginupdate_applied_live({ version: o.version })}
    </p>
  {/if}
{:else if checked}
  <p class="upd-checked micro">
    {checked.label}{#if checked.detail}<span class="reason"> — {checked.detail}</span>{/if}
  </p>
{/if}

<style>
  .upd-outcome {
    margin: 6px 0 0;
    color: var(--color-amber);
  }
  .upd-outcome.live {
    color: var(--color-green, var(--color-blue));
  }
  .upd-outcome.error {
    color: var(--color-red);
    word-break: break-word;
  }
  .upd-detail {
    margin: 4px 0 0;
    color: var(--color-muted);
    font-family: var(--font-mono, monospace);
    word-break: break-word;
  }
  /* Steady-state check result — quiet by design: it reports that this row WAS looked
     at, it is not an alert. Never amber, which belongs to a pending update. */
  .upd-checked {
    margin: 6px 0 0;
    color: var(--color-muted);
    word-break: break-word;
  }
  .upd-checked .reason {
    font-family: var(--font-mono, monospace);
  }
</style>
