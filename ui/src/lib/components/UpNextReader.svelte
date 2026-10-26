<script lang="ts">
  import { isPrKey, upNextUi } from "#lib/up-next-ui.svelte.js";
  import type { UpNextLaunchContext } from "#lib/up-next-start.svelte.js";
  import UpNextPreview from "./UpNextPreview.svelte";
  import UpNextPrPreview from "./UpNextPrPreview.svelte";

  // Up Next's reading view for whatever row is open: a PR in the PR preview, an issue (or
  // nothing yet) in the issue preview. Desktop renders it in the main area; the phone swaps it
  // in place of the list and passes `onback`.
  let {
    launchContext = null,
    onback = undefined,
  }: {
    launchContext?: UpNextLaunchContext | null;
    onback?: () => void;
  } = $props();
</script>

{#if isPrKey(upNextUi.previewKey)}
  <UpNextPrPreview {launchContext} {onback} />
{:else}
  <UpNextPreview {launchContext} {onback} />
{/if}
