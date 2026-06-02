<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { theme } from "$lib/theme.svelte";
  import { m } from "$lib/paraglide/messages";

  let { children } = $props();

  // keep `data-theme` in sync with OS changes when the preference is "system"
  onMount(() => theme.init());
</script>

<!-- Skip link: first focusable element, visually hidden until focused, jumps
     keyboard users straight past the chrome to the primary <main> region. -->
<a class="skip-link" href="#main-content">{m.a11y_skip_to_main()}</a>

{@render children()}

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
    font-size: 12px;
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
