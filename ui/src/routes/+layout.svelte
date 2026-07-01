<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { theme } from "$lib/theme.svelte";
  import { m } from "$lib/paraglide/messages";
  import { auth } from "$lib/auth.svelte";
  import { getMe } from "$lib/api";
  import Login from "$lib/components/Login.svelte";
  // Demo-only marketing chrome (Task 7). __DEMO__ is a compile-time constant
  // (vite `define`), so the `{#if __DEMO__}` guard below dead-code-eliminates
  // both this import and the component from a production build.
  import DemoRibbon from "$lib/demo/DemoRibbon.svelte";

  let { children } = $props();

  // keep `data-theme` in sync with OS changes when the preference is "system"
  onMount(() => {
    theme.init();
    // Single-operator auth (issue #1079): probe /api/me before rendering the app so an
    // unauthenticated session goes straight to the login view with no flash of failing calls.
    getMe()
      .then((ok) => (auth.unauthenticated = !ok))
      .catch(() => (auth.unauthenticated = true))
      .finally(() => (auth.checked = true));
  });
</script>

<!-- Skip link: first focusable element, visually hidden until focused, jumps
     keyboard users straight past the chrome to the primary <main> region. -->
<a class="skip-link" href="#main-content">{m.a11y_skip_to_main()}</a>

{#if auth.checked && auth.unauthenticated}
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
