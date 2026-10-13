<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { LocalUpdate } from "./local-update.svelte.js";

  // The two-click discard of this Shepherd's dirty tree: the first click only arms.
  let { local }: { local: LocalUpdate } = $props();
</script>

{#if local.arming}
  <button
    type="button"
    class="run danger"
    onclick={() => local.confirmDiscard()}
    disabled={local.busy}
  >
    {m.updatemodal_discard_confirm_yes()}
  </button>
{:else}
  <button type="button" class="run danger" onclick={() => (local.arming = true)}>
    {m.updatemodal_discard_and_update()}
  </button>
{/if}
