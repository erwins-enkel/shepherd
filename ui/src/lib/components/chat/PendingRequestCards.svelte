<script lang="ts">
  import type { GhPermissionRequest, LoginRequest } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { answerGhPermissionRequest } from "#lib/gh-grant.js";
  import { answerLoginRequest } from "#lib/login-request.js";

  // The session's open Login Request (#2897) and gh permission request (#4119), answered from the
  // Chat. Same store and helpers as the Terminal strips, so answering either place clears both.
  // Agent text (url, reason, files) is plain text only. Chrome is ChatView's global `ac-notice`.
  let {
    sessionId,
    loginRequest = null,
    ghPermissionRequest = null,
    openBrowser = null,
  }: {
    sessionId: string;
    loginRequest?: LoginRequest | null;
    ghPermissionRequest?: GhPermissionRequest | null;
    /** Switches to the Browser tab; null hides "Open browser". */
    openBrowser?: (() => void) | null;
  } = $props();

  const FILES_SHOWN = 3;
  const files = $derived(ghPermissionRequest?.files ?? []);
  const shown = $derived(files.slice(0, FILES_SHOWN));
  const more = $derived(files.length - shown.length);

  let loginBusy = $state(false);
  let ghBusy = $state(false);
  let ghError = $state<{ requestId: string; text: string } | null>(null);

  async function answerLogin(outcome: "done" | "cancelled") {
    loginBusy = true;
    await answerLoginRequest(sessionId, outcome);
    loginBusy = false;
  }

  async function answerGh(request: GhPermissionRequest, outcome: "granted" | "denied") {
    ghBusy = true;
    ghError = null;
    const r = await answerGhPermissionRequest(sessionId, outcome);
    ghBusy = false;
    if (!r.ok) ghError = { requestId: request.id, text: r.error };
  }
</script>

{#if loginRequest}
  <div class="ac-notice prc" role="alert">
    <div class="prc-text">
      <p class="prc-title">{m.viewport_login_bar_title()}</p>
      <span class="prc-mono" title={loginRequest.url}>{loginRequest.url}</span>
      <span class="prc-sub">{loginRequest.reason}</span>
    </div>
    <div class="ac-actions">
      {#if openBrowser}
        <button type="button" class="gbtn" onclick={openBrowser}>
          {m.viewport_login_bar_open()}
        </button>
      {/if}
      <button
        type="button"
        class="gbtn primary"
        disabled={loginBusy}
        onclick={() => answerLogin("done")}
      >
        {m.viewport_browser_login_done()}
      </button>
      <button
        type="button"
        class="gbtn"
        disabled={loginBusy}
        onclick={() => answerLogin("cancelled")}
      >
        {m.viewport_browser_login_cancel()}
      </button>
    </div>
  </div>
{/if}
{#if ghPermissionRequest}
  {@const request = ghPermissionRequest}
  <div class="ac-notice prc" role="alert">
    <div class="prc-text">
      <p class="prc-title">{m.gh_request_banner_title({ permission: request.permission })}</p>
      <span class="prc-sub">{request.reason}</span>
      {#if shown.length}
        <span class="prc-mono" title={files.join("\n")}>
          {shown.join(", ")}{more > 0 ? ` ${m.gh_request_banner_more({ count: more })}` : ""}
        </span>
      {/if}
      {#if ghError && ghError.requestId === request.id}
        <span class="prc-error" role="alert">{ghError.text}</span>
      {/if}
    </div>
    <div class="ac-actions">
      <button
        type="button"
        class="gbtn primary"
        disabled={ghBusy}
        onclick={() => answerGh(request, "granted")}
      >
        {m.gh_request_grant()}
      </button>
      <button
        type="button"
        class="gbtn"
        disabled={ghBusy}
        onclick={() => answerGh(request, "denied")}
      >
        {m.gh_request_deny()}
      </button>
    </div>
  </div>
{/if}

<style>
  .prc-text {
    display: flex;
    flex: 1 1 14rem;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .prc-title {
    margin: 0;
  }
  .prc-sub,
  .prc-mono {
    color: var(--color-ink);
    font-size: var(--fs-meta);
    overflow-wrap: anywhere;
  }
  .prc-mono {
    font-family: var(--font-mono);
  }
  .prc-error {
    color: var(--color-red);
    font-size: var(--fs-meta);
    overflow-wrap: anywhere;
  }
</style>
