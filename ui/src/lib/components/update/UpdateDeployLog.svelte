<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { LocalUpdate } from "./local-update.svelte.js";

  // This Shepherd's deploy as it runs (the tailing log) or after it failed (why, with the log).
  let { local }: { local: LocalUpdate } = $props();
</script>

{#if local.mode === "progress"}
  <div class="status" aria-live="polite">{m.updatemodal_status()}</div>
  {#if local.liveLog}
    <div class="loghead micro">{m.updatemodal_deploy_log()}</div>
    <!-- The concise .status line above is the polite announcement; the raw log
         stays silent so a fast-appending stream doesn't re-announce every line. -->
    <pre class="log">{local.liveLog}</pre>
  {/if}
{:else if local.mode === "rawlog"}
  <div class="failure">
    <div class="err">
      {m.updatemodal_deploy_failed()}
      {#if local.deploy?.exitCode != null}
        <span class="code">{m.updatemodal_exit_code({ code: local.deploy.exitCode })}</span>
      {/if}
    </div>
    {#if local.deploy?.log}
      <div class="loghead micro">{m.updatemodal_deploy_log()}</div>
      <pre class="log">{local.deploy.log}</pre>
    {/if}
  </div>
{/if}

<style>
  .failure {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .failure .code {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
    margin-left: 6px;
  }
</style>
