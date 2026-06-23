<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import AutomationSettings from "./AutomationSettings.svelte";

  let {
    repoPath,
    onconfirm,
    oncancel,
    submitting = false,
  }: {
    repoPath: string;
    onconfirm: () => void;
    oncancel: () => void;
    submitting?: boolean;
  } = $props();

  /** Last path segment of the repo path — the repo's base name shown in the intro. */
  const repoBaseName = $derived(repoPath.split("/").filter(Boolean).at(-1) ?? repoPath);
</script>

<div class="ftac">
  <p class="ftac-title micro">{m.firsttask_confirm_title()}</p>
  <p class="ftac-intro">{m.firsttask_confirm_intro({ repo: repoBaseName })}</p>

  <div class="ftac-settings">
    <AutomationSettings {repoPath} showHeader={false} />
  </div>

  <div class="ftac-actions">
    <button type="button" class="gbtn" onclick={oncancel}>
      {m.common_cancel()}
    </button>
    <button type="button" class="gbtn primary" disabled={submitting} onclick={onconfirm}>
      {m.firsttask_confirm_cta()}
    </button>
  </div>
</div>

<style>
  .ftac {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .ftac-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin: 0;
  }

  .ftac-intro {
    font-size: var(--fs-base);
    color: var(--color-ink);
    margin: 0;
    line-height: 1.45;
  }

  .ftac-settings {
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    overflow: hidden;
  }

  .ftac-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }

  /* Canonical .gbtn recipe — see /design-system */
  .gbtn {
    background: none;
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-base);
    padding: 7px 16px;
    cursor: pointer;
  }

  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
</style>
