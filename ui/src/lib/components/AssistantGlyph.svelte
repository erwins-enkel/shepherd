<script lang="ts">
  // The Operator Assistant's mark (#1446): a four-point sparkle in stroke, shared by the top-bar
  // Assist toggle, the Controls sheet row and the panel header. Decorative — the label beside it
  // names the control. `size` is any CSS length (a scoped class from the caller can't reach it).
  let { size = "var(--fs-lg)" }: { size?: string } = $props();
</script>

<svg
  class="assistant-glyph"
  style:width={size}
  style:height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M12 3.5 13.9 10.1 20.5 12 13.9 13.9 12 20.5 10.1 13.9 3.5 12 10.1 10.1Z" />
</svg>

<style>
  .assistant-glyph {
    display: block;
    flex-shrink: 0;
  }
</style>
