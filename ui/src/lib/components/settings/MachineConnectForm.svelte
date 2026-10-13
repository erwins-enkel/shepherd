<script lang="ts">
  import { onMount } from "svelte";
  import { connectRemoteInstance } from "#lib/api.js";
  import type { RemoteInstance } from "#lib/types.js";
  import { connectErrorMessage } from "#lib/machines.js";
  import { m } from "#lib/paraglide/messages.js";

  // Connect another Shepherd as a machine (#2759). The server checks the target before it stores
  // anything, so a refusal names what to fix. The token lives in this form only until it is sent;
  // it is cleared on success and never comes back from the server. The machines list unfolds it
  // under its header and unmounts it on cancel, so a cancelled token is dropped with the form.
  let {
    onconnected,
    oncancel,
    name = "",
  }: {
    onconnected: (instance: RemoteInstance) => void;
    oncancel: () => void;
    /** The name to start from: "Connect <name> here" for a Shepherd that mirrors this one (#3056). */
    name?: string;
  } = $props();

  let urlInput = $state<HTMLInputElement>();
  let url = $state("");
  let token = $state("");
  // Read once: the form starts from it, then it is the operator's to change.
  // svelte-ignore state_referenced_locally
  let label = $state(name);
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

  // Opened on purpose, so the address is the next thing to type.
  onMount(() => urlInput?.focus());
</script>

<p class="mch-hint">{m.settings_machines_connect_hint()}</p>
<form class="mch-form" onsubmit={connect}>
  <label class="mch-fld">
    <span class="mch-lbl">{m.settings_machines_url_label()}</span>
    <input
      class="pui-input"
      type="url"
      bind:this={urlInput}
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
      class="pui-input"
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
    <input class="pui-input" type="text" bind:value={label} maxlength="64" disabled={connecting} />
  </label>
  <button
    type="submit"
    class="set-gbtn mch-primary"
    disabled={connecting || url.trim() === "" || token.trim() === ""}
  >
    {connecting ? m.settings_machines_connecting() : m.settings_machines_connect_button()}
  </button>
  <button type="button" class="set-gbtn" disabled={connecting} onclick={oncancel}
    >{m.common_cancel()}</button
  >
</form>
<p class="mch-hint mch-warn">{m.settings_machines_trust()}</p>
{#if error}<p class="mch-hint mch-err" role="alert">{error}</p>{/if}
