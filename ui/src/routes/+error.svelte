<script lang="ts">
  /**
   * Client error boundary. Replaces SvelteKit's unstyled fallback (a bare `500` / `Internal Error`
   * in monospace, no chrome, no way back) with a surface that says what happened and offers the
   * one action that actually helps.
   *
   * Tokens-only per the design system; mirrors the Login full-view takeover, since both are
   * "the app is not usable yet" states rendered on the bare app background.
   */
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { m } from "$lib/paraglide/messages";
  import { shouldAutoReload } from "$lib/client-error";

  // A chunk that never arrived is a transport failure, not an app fault — it gets a different
  // explanation (and the one-shot reload below) from a genuine crash.
  const isChunk = $derived(page.error?.kind === "chunk");
  const detail = $derived(page.error?.message ?? "");

  let reloading = $state(false);

  function retry() {
    reloading = true;
    location.reload();
  }

  onMount(() => {
    // A missing chunk is usually a moved deploy (`bun run update` rewrites every hashed chunk);
    // one reload picks up the new manifest and the operator never sees this page. The guard caps
    // it at once per tab so a flaky link lands here instead of looping.
    if (page.error?.kind && shouldAutoReload(page.error.kind, globalThis.sessionStorage)) {
      reloading = true;
      location.reload();
    }
  });
</script>

<div class="err-scrim">
  <div class="err-card panel" role="alert" aria-live="assertive">
    {#if reloading}
      <h1 class="title">{m.errorpage_reloading_title()}</h1>
      <p class="subtitle">{m.errorpage_reloading_body()}</p>
    {:else}
      <h1 class="title">
        {isChunk ? m.errorpage_chunk_title() : m.errorpage_generic_title()}
      </h1>
      <p class="subtitle">
        {isChunk ? m.errorpage_chunk_body() : m.errorpage_generic_body()}
      </p>
      <button type="button" class="gbtn retry" onclick={retry}>{m.errorpage_retry()}</button>
      {#if detail}
        <!-- Raw engine text: diagnostic data the app did not author, so it stays untranslated. -->
        <p class="detail">
          <span class="detail-label">{m.errorpage_detail_label()}</span>
          <span class="detail-text">{page.status} · {detail}</span>
        </p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .err-scrim {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--color-scrim, color-mix(in srgb, var(--color-bg) 70%, transparent));
    backdrop-filter: blur(6px);
  }
  .err-card {
    width: min(420px, 100%);
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 24px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 4px;
  }
  .title {
    margin: 0;
    font-size: var(--fs-lg);
    color: var(--color-ink-bright, var(--color-ink));
    letter-spacing: 0.06em;
  }
  .subtitle {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  /* .gbtn recipe (design system) */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 8px;
    cursor: pointer;
  }
  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .retry {
    margin-top: 4px;
  }
  .detail {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .detail-label {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    letter-spacing: 0.08em;
  }
  .detail-text {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    /* Chunk URLs are long and unbreakable; keep them inside the card on a phone. */
    overflow-wrap: anywhere;
    opacity: 0.8;
  }
  @media (prefers-reduced-motion: reduce) {
    .err-scrim {
      backdrop-filter: none;
    }
  }
</style>
