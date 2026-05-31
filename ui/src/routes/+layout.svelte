<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { theme } from "$lib/theme.svelte";

  let { children } = $props();

  // keep `data-theme` in sync with OS changes when the preference is "system"
  onMount(() => theme.init());
</script>

{@render children()}
