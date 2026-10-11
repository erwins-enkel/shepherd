<script lang="ts">
  import { connectRemoteInstance } from "#lib/api.js";
  import type { RemoteInstance } from "#lib/types.js";
  import { connectErrorMessage } from "#lib/machines.js";
  import HighlightText from "./HighlightText.svelte";
  import { m } from "#lib/paraglide/messages.js";

  // Connect another Shepherd as a machine (#2759). The server checks the target before it stores
  // anything, so a refusal names what to fix. The token lives in this form only until it is sent;
  // it is cleared on success and never comes back from the server.
  let {
    query = "",
    onconnected,
  }: {
    query?: string;
    onconnected: (instance: RemoteInstance) => void;
  } = $props();

  let url = $state("");
  let token = $state("");
  let label = $state("");
  let connecting = $state(false);
  let error = $state("");

  async function connect(e: SubmitEvent) {
    e.preventDefault();
    if (connecting) return;
    connecting = true;
    error = "";
    try {
      const result = await connectRemoteInstance({
        url: url.trim(),
        token: token.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      if (result.ok) {
        url = token = label = "";
        onconnected(result.instance);
      } else {
        error = connectErrorMessage(result.error, result.reason);
      }
    } catch {
      error = m.settings_machines_error_generic();
    } finally {
      connecting = false;
    }
  }
</script>

<div class="mch-block">
  <span class="mch-micro"><HighlightText text={m.settings_machines_connect_title()} {query} /></span
  >
  <p class="mch-hint">{m.settings_machines_connect_hint()}</p>
  <form class="mch-form" onsubmit={connect}>
    <label class="mch-fld">
      <span class="mch-lbl">{m.settings_machines_url_label()}</span>
      <input
        class="mch-txt"
        type="url"
        bind:value={url}
        required
        autocomplete="off"
        disabled={connecting}
        placeholder={m.settings_machines_url_placeholder()}
      />
    </label>
    <label class="mch-fld">
      <span class="mch-lbl">{m.settings_machines_token_label()}</span>
      <input
        class="mch-txt"
        type="password"
        bind:value={token}
        required
        autocomplete="off"
        spellcheck="false"
        disabled={connecting}
      />
    </label>
    <label class="mch-fld">
      <span class="mch-lbl">{m.settings_machines_label_label()}</span>
      <input class="mch-txt" type="text" bind:value={label} maxlength="64" disabled={connecting} />
    </label>
    <button
      type="submit"
      class="mch-run"
      disabled={connecting || url.trim() === "" || token.trim() === ""}
    >
      {connecting ? m.settings_machines_connecting() : m.settings_machines_connect_button()}
    </button>
  </form>
  <p class="mch-hint mch-warn">{m.settings_machines_trust()}</p>
  {#if error}<p class="mch-hint mch-err" role="alert">{error}</p>{/if}
</div>
