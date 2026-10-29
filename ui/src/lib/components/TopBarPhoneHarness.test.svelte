<script lang="ts">
  import type { ComponentProps } from "svelte";
  import TopBar from "./TopBar.svelte";
  import ActionBar from "./ActionBar.svelte";
  import { diagnosticsPip } from "./top-bar/gear-pip";

  // Test harness: TopBar as the page mounts it. On a phone the Menu sheet opens from the
  // ActionBar's Menu tab (variant E), so `mobile` renders that tab beside the bar exactly as
  // +page.svelte wires it; on desktop this is a plain pass-through.
  let { menuOpen: initialOpen = false, ...rest }: ComponentProps<typeof TopBar> = $props();
  // svelte-ignore state_referenced_locally
  let menuOpen = $state(initialOpen);
</script>

<TopBar {...rest} bind:menuOpen />
{#if rest.mobile}
  <ActionBar
    mobile
    onnew={() => {}}
    onmenu={() => (menuOpen = !menuOpen)}
    {menuOpen}
    menuPip={diagnosticsPip(rest.diagnosticsOverall ?? "ok")}
  />
{/if}
