<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { UpNextStarter } from "#lib/up-next-start.svelte.js";
  import ModelCliPicker from "./new-task/ModelCliPicker.svelte";

  // The anchored CLI picker an UpNextStarter opens when several providers are ready.
  let { starter }: { starter: UpNextStarter } = $props();
</script>

{#if starter.picker}
  <ModelCliPicker
    x={starter.picker.x}
    y={starter.picker.y}
    title={m.upnext_picker_title()}
    confirmLabel={m.upnext_picker_confirm()}
    fableAvailable={starter.fableAvailable}
    initialProvider={starter.suggestedProvider}
    usageLimits={starter.usageLimits}
    nowMs={starter.nowMs}
    holdLikely={starter.holdLikely}
    opener={starter.picker.opener}
    onconfirm={(choice) => starter.confirmPicker(choice)}
    onclose={() => (starter.picker = null)}
  />
{/if}
