<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { pwaRowState, type PwaRowState } from "$lib/pwa";

  // Client-only: install/standalone state isn't knowable on the server, so this row
  // is rendered independently of the /api/diagnostics snapshot (issue #662). It
  // deliberately mirrors the DiagnoseRows row recipe (glyph + label + state word +
  // optional hint) with the same semantic tokens, kept self-contained so it never
  // couples to the server-fed checks list or its all-ok footer.

  // null until mounted — avoids reading window/navigator during SSR.
  let state = $state<PwaRowState | null>(null);
  onMount(() => {
    state = pwaRowState();
  });

  // glyph: ✓ slate (installed) / ⚠ amber (warning) / – muted (optional).
  // Design rule: never --color-green for healthy; ✓ uses --status-done (slate).
  const glyph: Record<PwaRowState, string> = {
    installed: "✓",
    ios: "⚠",
    android: "⚠",
    optional: "–",
  };
  const color: Record<PwaRowState, string> = {
    installed: "var(--status-done)",
    ios: "var(--color-amber)",
    android: "var(--color-amber)",
    optional: "var(--color-muted)",
  };
  function stateWord(s: PwaRowState): string {
    if (s === "installed") return m.diagnostics_state_installed();
    if (s === "optional") return m.diagnostics_state_optional();
    return m.diagnostics_state_not_installed();
  }
  function hint(s: PwaRowState): string {
    if (s === "ios") return m.diagnostics_hint_pwa_ios();
    if (s === "android") return m.diagnostics_hint_pwa_android();
    if (s === "optional") return m.diagnostics_hint_pwa_optional();
    return "";
  }
</script>

{#if state !== null}
  <div class="rc">
    <div class="row-head">
      <span class="glyph" style="color:{color[state]}" aria-hidden="true">{glyph[state]}</span>
      <span class="micro label">{m.diagnostics_label_pwa_install()}</span>
      <span class="state-word micro" style="color:{color[state]}">{stateWord(state)}</span>
    </div>
    {#if state !== "installed"}
      <p class="hint">{hint(state)}</p>
    {/if}
  </div>
{/if}

<style>
  /* Mirrors the DiagnoseRows.svelte row recipe — same structure + tokens. */
  .rc {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 0;
    border-top: 1px solid var(--color-line);
  }
  .row-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .glyph {
    font-size: var(--fs-base);
    width: 14px;
    text-align: center;
    flex-shrink: 0;
  }
  .label {
    flex: 1;
    color: var(--color-ink);
  }
  .state-word {
    flex-shrink: 0;
  }
  .hint {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0 0 0 22px;
    line-height: 1.5;
  }
</style>
