<script lang="ts">
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import DiagnoseRows from "$lib/components/DiagnoseRows.svelte";
  import type { DiagnosticCheck } from "$lib/types";

  let {
    checks,
    failed = false,
    onretry,
    ondismiss,
  }: {
    checks: DiagnosticCheck[] | null;
    failed?: boolean;
    onretry?: () => void;
    ondismiss: () => void;
  } = $props();
</script>

<!-- Blocking first-run surface over the app: canonical scrim backdrop (design
     system rule #5) — the global `.scrim` class provides the dim + blur. -->
<div class="scrim" role="presentation">
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="onboarding-title"
    use:dialog={{ onclose: ondismiss }}
  >
    <header class="head">
      <h2 class="title" id="onboarding-title">{m.onboarding_title()}</h2>
      <p class="intro">{m.onboarding_intro()}</p>
    </header>
    <div class="checks">
      <DiagnoseRows {checks} {failed} {onretry} />
    </div>
    <footer class="foot">
      <button class="gbtn primary" onclick={ondismiss}>{m.onboarding_dismiss()}</button>
    </footer>
  </div>
</div>

<style>
  /* The global `.scrim` (app.css) supplies background + blur; we only add the
     positioning context + z-index to float the card centered above the app. */
  .scrim {
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom));
  }
  .card {
    width: min(440px, 100%);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    gap: 14px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 10px;
    padding: 20px;
    overflow: hidden;
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  }
  .title {
    margin: 0;
    font-size: var(--fs-lg);
    color: var(--color-ink);
  }
  .intro {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .checks {
    overflow-y: auto;
    min-height: 0;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    flex-shrink: 0;
  }
  /* Canonical button recipe (.gbtn) — see /design-system. */
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
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
</style>
