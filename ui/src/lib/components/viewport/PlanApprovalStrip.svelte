<script lang="ts">
  import type { PendingPlan } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";

  // ExitPlanMode (#2779): the agent waits on plan approval. The plan arrives as data from the
  // PreToolUse hook; it is untrusted agent text, so plain text only. Approval stays in the terminal,
  // where the dialog is live. Strip chrome (`auth-*` classes) is styled by ViewportTermBanners'
  // `.top-strips`, so every top strip shares one look.
  let { plan, sessionId }: { plan: PendingPlan; sessionId: string } = $props();

  // Disclosure: collapsed again for every new plan dialog.
  let openFor = $state<string | null>(null);
  const open = $derived(openFor === plan.toolUseId);
</script>

<div class="auth-banner plan-banner" role="status">
  <span class="auth-icon" aria-hidden="true">✓</span>
  <div class="auth-text">
    <span class="auth-title">{m.plan_banner_title()}</span>
    <span class="auth-url">{m.plan_banner_sub()}</span>
  </div>
  <div class="auth-actions">
    <button
      class="auth-btn primary"
      type="button"
      aria-expanded={open}
      aria-controls="plan-banner-text-{sessionId}"
      onclick={() => (openFor = open ? null : plan.toolUseId)}
    >
      {open ? m.plan_banner_hide() : m.plan_banner_show()}
    </button>
  </div>
</div>
{#if open}
  <div class="plan-panel" id="plan-banner-text-{sessionId}">
    <pre class="plan-text">{plan.plan}</pre>
    {#if plan.truncated}
      <p class="plan-truncated">{m.plan_banner_truncated()}</p>
    {/if}
  </div>
{/if}

<style>
  /* The plan text under its strip, scrolling inside a viewport-bounded box so the terminal's live
     dialog below stays reachable. */
  .plan-panel {
    max-height: 45vh;
    overflow: auto;
    padding: 10px 12px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line-bright);
  }
  .plan-text {
    margin: 0;
    color: var(--color-ink-bright);
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-base);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .plan-truncated {
    margin: 8px 0 0;
    color: var(--color-ink);
    font-size: var(--fs-base);
  }
</style>
