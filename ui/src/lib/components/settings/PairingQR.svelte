<script lang="ts">
  import { onMount } from "svelte";
  import { renderSVG } from "uqr";
  import { createPairingCode } from "#lib/api.js";
  import { buildPairingPayload, pairingServer } from "#lib/pairing.js";
  import { m } from "#lib/paraglide/messages.js";
  import HighlightText from "./HighlightText.svelte";

  let {
    previewHost = null,
    initiallyOpen = false,
    query = "",
  }: {
    previewHost?: string | null;
    initiallyOpen?: boolean;
    query?: string;
  } = $props();
  let open = $state(false);
  let busy = $state(false);
  let error = $state(false);
  let invitation = $state<{ code: string; expiresAt: number } | null>(null);
  let origin = $state("");
  let now = $state(Date.now());
  let generation = 0;
  const address = $derived(pairingServer(origin, previewHost));
  const seconds = $derived(Math.max(0, Math.ceil(((invitation?.expiresAt ?? now) - now) / 1000)));
  // uqr emits only QR geometry, never payload text. Keep the SVG in an image, not HTML markup.
  // Black/white are the library's protocol defaults so camera contrast survives either theme.
  const image = $derived(
    invitation && seconds > 0
      ? `data:image/svg+xml,${encodeURIComponent(renderSVG(buildPairingPayload(address.server, invitation.code), { border: 4 }))}`
      : "",
  );

  async function renew() {
    if (busy || !open) return;
    busy = true;
    error = false;
    invitation = null;
    const current = ++generation;
    try {
      const fresh = await createPairingCode();
      if (open && generation === current) {
        invitation = fresh;
        now = Date.now();
      }
    } catch {
      if (open && generation === current) error = true;
    } finally {
      if (generation === current) busy = false;
    }
  }
  function hide() {
    open = false;
    invitation = null;
    generation++;
    busy = false;
    error = false;
  }
  onMount(() => {
    origin = window.location.origin;
    if (initiallyOpen) {
      open = true;
      void renew();
    }
    const timer = setInterval(() => {
      now = Date.now();
      if (open && invitation && now >= invitation.expiresAt) void renew();
    }, 1000);
    return () => {
      clearInterval(timer);
      hide();
    };
  });
</script>

<div class="block">
  <span class="micro"><HighlightText text={m.pairing_title()} {query} /></span>
  <p class="hint">{m.pairing_hint()}</p>
  {#if !open}
    <button
      class="set-gbtn"
      onclick={() => {
        open = true;
        void renew();
      }}>{m.pairing_show()}</button
    >
  {:else}
    {#if busy}<p class="hint" role="status">{m.common_loading()}</p>{/if}
    {#if image}
      <img class="qr" src={image} alt={m.pairing_qr_alt()} width="280" height="280" />
      <p class="hint">{m.pairing_countdown({ seconds })}</p>
    {/if}
    {#if error}
      <p class="hint" role="alert">{m.pairing_create_failed()}</p>
      <button class="set-gbtn" onclick={renew}>{m.pairing_show()}</button>
    {/if}
    <p class="hint address">{address.server}</p>
    {#if address.loopback}<p class="hint">{m.pairing_loopback_hint()}</p>{/if}
    <button class="set-gbtn" onclick={hide}>{m.common_close()}</button>
  {/if}
</div>

<style>
  .block {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .hint {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }

  .qr {
    display: block;
    width: min(280px, 100%);
    height: auto;
    margin: 16px 0;
  }
  .address {
    overflow-wrap: anywhere;
  }
</style>
