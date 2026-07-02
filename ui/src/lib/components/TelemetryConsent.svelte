<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { dialog } from "$lib/a11yDialog";
  import GlossaryText from "./GlossaryText.svelte";
  import { putTelemetryConsent } from "$lib/api";

  const { show, onresolved }: { show: boolean; onresolved: () => void } = $props();
  let busy = $state(false);

  async function choose(consent: "granted" | "denied") {
    if (busy) return;
    busy = true;
    try {
      await putTelemetryConsent(consent);
    } catch {
      // best-effort; if the PUT fails the prompt reappears next load
    } finally {
      busy = false;
      onresolved();
    }
  }
</script>

{#if show}
  <!-- Blocking first-run surface over the app: canonical scrim backdrop (design
       system rule #5) — the global `.scrim` class provides the dim + blur. -->
  <div class="scrim" role="presentation">
    <div
      class="card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="telemetry-consent-title"
      use:dialog={{}}
    >
      <header class="head">
        <h2 id="telemetry-consent-title">{m.telemetry_consent_title()}</h2>
      </header>
      <div class="body">
        <p><GlossaryText text={m.telemetry_consent_body()} /></p>
      </div>
      <footer class="foot">
        <button type="button" class="gbtn" disabled={busy} onclick={() => choose("denied")}>
          {m.telemetry_consent_decline()}
        </button>
        <button
          type="button"
          class="gbtn primary"
          disabled={busy}
          onclick={() => choose("granted")}
        >
          {m.telemetry_consent_accept()}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .scrim {
    z-index: 61;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom));
  }
  .card {
    width: min(440px, 100%);
    display: flex;
    flex-direction: column;
    gap: 14px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 10px;
    padding: 20px;
  }
  .head h2 {
    margin: 0;
    font-size: var(--fs-lg);
    color: var(--color-ink);
  }
  .body p {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  /* Canonical button recipe (.gbtn) — see /design-system and Onboarding.svelte. */
  .gbtn {
    background: none;
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-base);
    padding: 7px 16px;
    cursor: pointer;
    min-height: 44px;
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
  .gbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
