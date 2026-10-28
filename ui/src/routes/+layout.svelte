<script lang="ts">
  // Self-hosted (was Google Fonts): a cross-origin stylesheet in app.html blocked the inline
  // boot script, so an unreachable fonts.googleapis.com stalled the whole PWA on a slow link.
  import "@fontsource-variable/inter";
  import "@fontsource/jetbrains-mono/400.css";
  import "@fontsource/jetbrains-mono/500.css";
  import "@fontsource/jetbrains-mono/700.css";
  import "../app.css";
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { theme } from "#lib/theme.svelte.js";
  import { motionSettle } from "#lib/motion-settle.js";
  import { m } from "#lib/paraglide/messages.js";
  import { auth } from "#lib/auth.svelte.js";
  import { getMe } from "#lib/api.js";
  import Login from "#lib/components/Login.svelte";
  import { resetAutoReload } from "#lib/client-error.js";
  // Demo-only marketing chrome (Task 7). __DEMO__ is a compile-time constant
  // (vite `define`), so the `{#if __DEMO__}` guard below dead-code-eliminates
  // both this import and the component from a production build.
  import DemoRibbon from "#lib/demo/DemoRibbon.svelte";

  let { children } = $props();

  // Something real is on screen (app, login or error page): retire app.html's boot shell. Only a
  // genuine boot resets the reload budget — resetting while the error page renders through this
  // layout would let a dead link reload forever.
  $effect(() => {
    if (!auth.checked && !page.error) return;
    document.getElementById("boot-shell")?.remove();
    if (!page.error) resetAutoReload(globalThis.sessionStorage);
  });

  // keep `data-theme` in sync with OS changes when the preference is "system"
  onMount(() => {
    theme.init();
    // Endless animations rest after a quiet spell so an idle HUD stops producing frames (#3035).
    const stopMotionSettle = motionSettle.start();
    // Single-operator auth (issue #1079): probe /api/me before rendering the app so an
    // unauthenticated session goes straight to the login view with no flash of failing calls.
    getMe()
      .then((ok) => (auth.unauthenticated = !ok))
      .catch(() => (auth.unauthenticated = true))
      .finally(() => (auth.checked = true));
    return stopMotionSettle;
  });
</script>

<!-- Skip link: first focusable element, visually hidden until focused, jumps
     keyboard users straight past the chrome to the primary <main> region. -->
<a class="skip-link" href="#main-content">{m.a11y_skip_to_main()}</a>

{#if page.error}
  <!-- `+error.svelte` renders through this slot. It must bypass the auth gate below: an error
       thrown before `getMe()` settles leaves `auth.checked` false, and gating it would render a
       blank page instead of the error surface — the failure mode this boundary exists to fix. -->
  {@render children()}
{:else if auth.checked && auth.unauthenticated}
  <Login />
{:else if auth.checked}
  {@render children()}
{/if}

{#if __DEMO__}
  <DemoRibbon />
{/if}

<style>
  .skip-link {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 100;
    /* off-screen until focused */
    transform: translateY(-150%);
    padding: 8px 14px;
    background: var(--color-panel);
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    font-size: var(--fs-base);
    letter-spacing: 0.08em;
    text-decoration: none;
    transition: transform 0.12s ease-out;
  }
  .skip-link:focus {
    transform: translateY(0);
    outline: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .skip-link {
      transition: none;
    }
  }
</style>
