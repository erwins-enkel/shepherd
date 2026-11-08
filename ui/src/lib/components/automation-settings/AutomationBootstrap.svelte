<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoBootstrap } from "#lib/repo-bootstrap.svelte.js";
  import { bootstrapExplanation } from "#lib/tooltips/explanations.js";
  import RepoSettingRow from "../repo-settings/RepoSettingRow.svelte";
  import AutomationBootstrapFields from "./AutomationBootstrapFields.svelte";
  import "./automation-fields.css";

  // Project bootstrap (#3105): the on/off switch for an adopted repo, a suggestion for a repo
  // without a manifest, and — while active — the phase/missing/override fields beneath it.
  // Self-contained so the section that hosts it only gains one tag.
  let { repoPath }: { repoPath: string } = $props();

  $effect(() => {
    void repoBootstrap.load(repoPath);
  });

  const view = $derived(repoBootstrap.viewFor(repoPath));
  const on = $derived(view?.state === "active");
  const busy = $derived(repoBootstrap.busyFor(repoPath));
</script>

{#if view}
  <RepoSettingRow
    field="bootstrap"
    glyph="⚑"
    name={m.automation_bootstrap_name()}
    explanation={bootstrapExplanation()}
    desc={view.state === "done" ? m.automation_bootstrap_done() : m.automation_bootstrap_desc()}
    checked={on}
    pending={busy}
    ontoggle={() => repoBootstrap.setActive(repoPath, !on)}
  />
  {#if on}
    <AutomationBootstrapFields {repoPath} {view} {busy} />
  {:else if view.suggested}
    <div class="drain-fields">
      <p class="bs-hint">{m.automation_bootstrap_suggest()}</p>
      <button
        class="bs-btn"
        type="button"
        disabled={busy}
        onclick={() => repoBootstrap.setActive(repoPath, true)}
        >{m.automation_bootstrap_suggest_enable()}</button
      >
    </div>
  {/if}
{/if}

<style>
  .bs-hint {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.4;
  }
</style>
