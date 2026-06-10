<script lang="ts">
  // Inline-SVG replacements for the old moon/sun/half-circle theme-toggle text
  // glyphs (U+263E/U+2600/U+25D0), which rendered as tofu boxes on minimal font
  // sets (e.g. Omarchy Linux + Chrome). "auto" (Settings' follow-system option) and
  // "contrast" (ActionBar's WCAG toggle) share the half-filled-circle shape
  // for now but stay distinct variants so call sites remain self-describing.
  let { icon }: { icon: "moon" | "sun" | "auto" | "contrast" } = $props();
</script>

<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true">
  {#if icon === "moon"}
    <path d="M14 8.53A6 6 0 1 1 7.47 2a4.67 4.67 0 0 0 6.53 6.53z" />
  {:else if icon === "sun"}
    <circle cx="8" cy="8" r="3.4" />
    <path
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      d="M8 0.9v1.8M8 13.3v1.8M0.9 8h1.8M13.3 8h1.8M2.98 2.98l1.27 1.27M11.75 11.75l1.27 1.27M13.02 2.98l-1.27 1.27M4.25 11.75l-1.27 1.27"
    />
  {:else}
    <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M8 2.5a5.5 5.5 0 0 0 0 11z" />
  {/if}
</svg>

<style>
  svg {
    vertical-align: -0.125em;
  }
</style>
