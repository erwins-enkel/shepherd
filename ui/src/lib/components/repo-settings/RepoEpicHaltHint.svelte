<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { basename } from "#lib/basename.js";
  import { epicAutoFix } from "#lib/epic-auto-fix.svelte.js";
  import type { DrainStatus } from "#lib/types.js";
  import { sandboxHaltedEpic } from "../epic-panel";
  import { haltSummary } from "../epic-auto-fix";
  import "../automation-settings/automation-fields.css";

  // #3443: the epic the drain holds at a sandbox gate, when the cause sits in this repo's settings
  // or on this host — what the Backlog's Automation tab counts in red (#3455) — said at the top of
  // the repo settings, with "Switch to Autonomous" when that clears it here (the repo overview
  // banner's own fix, #3456).
  let { repoPath, drain = null }: { repoPath: string; drain?: DrainStatus | null } = $props();

  $effect(() => epicAutoFix.watch(repoPath, drain));
  const parent = $derived(sandboxHaltedEpic(drain));
  const causes = $derived(
    parent == null
      ? []
      : (epicAutoFix.blockers(repoPath, parent)?.causes ?? []).filter(
          (c) => c.scope === "repo" || c.scope === "host",
        ),
  );
  const autonomous = $derived(
    causes.find((c) => c.code === "sandbox_interactive")?.fix?.enabled === true,
  );
  const busy = $derived(epicAutoFix.busy(repoPath));
</script>

{#if parent != null && causes.length > 0}
  <div class="auto-hold" role="status" data-epic-halt>
    <div class="auto-hold-head">
      <span class="auto-hold-glyph" aria-hidden="true">⚠</span>{m.repooverview_halt_title({
        repo: basename(repoPath),
      })}
    </div>
    <p class="auto-hold-text">{haltSummary(causes)}</p>
    {#if autonomous}
      <div class="auto-hold-actions">
        <button
          type="button"
          class="bs-btn primary"
          disabled={busy}
          aria-busy={busy}
          onclick={() => epicAutoFix.applyCause(repoPath, parent, "sandbox_interactive")}
          >{m.repooverview_halt_autonomous()}</button
        >
      </div>
    {/if}
  </div>
{/if}
