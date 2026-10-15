<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoBootstrap } from "#lib/repo-bootstrap.svelte.js";
  import { bootstrapExplanation } from "#lib/tooltips/explanations.js";
  import InfoTip from "../InfoTip.svelte";
  import AutomationBootstrapFields from "./AutomationBootstrapFields.svelte";
  import "./automation-fields.css";

  // Project bootstrap (#3105): the on/off switch for an adopted repo, a suggestion for a repo
  // without a manifest, and — while active — the phase/missing/override fields beneath it.
  // Self-contained (own row + switch styles) so AutomationSettings' template, which sits at its
  // complexity bar, only gains one tag.
  let { repoPath }: { repoPath: string } = $props();

  $effect(() => {
    void repoBootstrap.load(repoPath);
  });

  const view = $derived(repoBootstrap.viewFor(repoPath));
  const on = $derived(view?.state === "active");
  const busy = $derived(!!repoBootstrap.busy[repoPath]);
</script>

{#if view}
  <div class="bs-row">
    <div class="bs-meta">
      <div class="bs-name">
        ⚑ {m.automation_bootstrap_name()}
        <InfoTip text={bootstrapExplanation()} label={m.tooltip_bootstrap_title()} />
      </div>
      <div class="bs-desc">
        {view.state === "done" ? m.automation_bootstrap_done() : m.automation_bootstrap_desc()}
      </div>
    </div>
    <button
      class={["bs-sw", { on }]}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={m.automation_bootstrap_name()}
      disabled={busy}
      onclick={() => repoBootstrap.setActive(repoPath, !on)}
    >
      <span class="knob"></span>
    </button>
  </div>
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
  /* Mirrors AutomationSettings' .auto-row / .sw (scoped there, so not reachable from here). */
  .bs-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--color-line);
  }
  .bs-meta {
    min-width: 0;
  }
  .bs-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .bs-desc {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin-top: 2px;
  }
  .bs-sw {
    flex: 0 0 auto;
    margin-top: 2px;
    width: 30px;
    height: 17px;
    border-radius: 2px;
    border: 1px solid var(--color-line);
    background: var(--color-faint);
    position: relative;
    cursor: pointer;
    padding: 0;
    transition: background 0.12s;
  }
  .bs-sw:disabled {
    cursor: not-allowed;
  }
  .bs-sw .knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 13px;
    height: 13px;
    border-radius: 2px;
    background: var(--color-slate);
    transition:
      left 0.12s,
      background 0.12s;
  }
  .bs-sw.on {
    background: var(--color-amber);
  }
  .bs-sw.on .knob {
    left: 15px;
    background: var(--color-inset);
  }
  .bs-hint {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.4;
  }
</style>
