<script lang="ts">
  import type { GhPermissionRequest } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { answerGhPermissionRequest } from "#lib/gh-grant.js";

  // gh permission request (#4119): the sandboxed agent's push needs an opt-in gh permission
  // (`workflows`). `reason`/`files` are agent text — plain text only. A failed Grant keeps the
  // strip and shows the server's reason. Strip chrome (`auth-*`) is styled by
  // ViewportTermBanners' `.top-strips`.
  let { request, sessionId }: { request: GhPermissionRequest; sessionId: string } = $props();

  const FILES_SHOWN = 3;
  const shown = $derived(request.files.slice(0, FILES_SHOWN));
  const more = $derived(request.files.length - shown.length);

  let answering = $state(false);
  let error = $state<{ requestId: string; text: string } | null>(null);

  async function answer(outcome: "granted" | "denied") {
    const requestId = request.id;
    answering = true;
    error = null;
    const r = await answerGhPermissionRequest(sessionId, outcome);
    answering = false;
    if (!r.ok) error = { requestId, text: r.error };
  }
</script>

<div class="auth-banner gh-perm-banner" role="status">
  <span class="auth-icon" aria-hidden="true">⚿</span>
  <div class="auth-text">
    <span class="auth-title">{m.gh_request_banner_title({ permission: request.permission })}</span>
    <span class="gh-perm-reason" title={request.reason}>{request.reason}</span>
    {#if shown.length}
      <span class="auth-url" title={request.files.join("\n")}>
        {shown.join(", ")}{more > 0 ? ` ${m.gh_request_banner_more({ count: more })}` : ""}
      </span>
    {/if}
    {#if error && error.requestId === request.id}
      <span class="gh-perm-error" role="alert">{error.text}</span>
    {/if}
  </div>
  <div class="auth-actions">
    <button
      class="auth-btn primary"
      type="button"
      disabled={answering}
      onclick={() => answer("granted")}
    >
      {m.gh_request_grant()}
    </button>
    <button class="auth-btn" type="button" disabled={answering} onclick={() => answer("denied")}>
      {m.gh_request_deny()}
    </button>
  </div>
</div>

<style>
  /* Same wrap rules as the login bar: the text keeps a usable floor and the actions drop to
     their own row when the strip is narrow. */
  .gh-perm-banner {
    flex-wrap: wrap;
  }
  .gh-perm-banner .auth-text {
    flex: 1 1 14rem;
  }
  .gh-perm-banner .auth-actions {
    flex-wrap: wrap;
  }
  .gh-perm-reason {
    color: var(--color-ink);
    font-size: var(--fs-base);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .gh-perm-error {
    color: var(--color-red);
    font-size: var(--fs-base);
    overflow-wrap: anywhere;
  }
</style>
