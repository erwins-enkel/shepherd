<script lang="ts">
  // Single-operator login (issue #1079). Full-view takeover shown by the root layout while the
  // session is unauthenticated. Tokens-only per the design system; reuses the .gbtn + field recipes.
  import { login } from "$lib/api";
  import { m } from "$lib/paraglide/messages";

  let password = $state("");
  let busy = $state(false);
  let error = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || password === "") return;
    busy = true;
    error = false;
    try {
      const ok = await login(password);
      if (ok) {
        password = "";
        // success: auth.unauthenticated is cleared by login(); the layout re-renders the app.
      } else {
        error = true;
      }
    } catch {
      error = true;
    } finally {
      busy = false;
    }
  }
</script>

<div class="login-scrim">
  <form class="login-card panel" onsubmit={submit}>
    <h1 class="title">{m.login_title()}</h1>
    <p class="subtitle">{m.login_subtitle()}</p>
    <label class="field">
      <span class="label">{m.login_password_label()}</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="password"
        class="input"
        bind:value={password}
        disabled={busy}
        placeholder={m.login_password_placeholder()}
        aria-label={m.login_password_label()}
        autocomplete="current-password"
        autofocus
      />
    </label>
    {#if error}
      <p class="error" role="alert">{m.login_error()}</p>
    {/if}
    <button type="submit" class="gbtn submit" disabled={busy || password === ""}>
      {busy ? m.login_busy() : m.login_submit()}
    </button>
  </form>
</div>

<style>
  /* Blocking surface: dim + blur behind the card (honors the design-system scrim rule). There is
     no app rendered behind it, so this reads as the focused entry point on the app background. */
  .login-scrim {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--color-scrim, color-mix(in srgb, var(--color-bg) 70%, transparent));
    backdrop-filter: blur(6px);
  }
  .login-card {
    width: min(360px, 100%);
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
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field .label {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    letter-spacing: 0.08em;
  }
  .input {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 8px 10px;
  }
  .input:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
    border-color: var(--color-amber);
  }
  .error {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-red);
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
  .submit {
    margin-top: 4px;
  }
  @media (prefers-reduced-motion: reduce) {
    .login-scrim {
      backdrop-filter: none;
    }
  }
</style>
