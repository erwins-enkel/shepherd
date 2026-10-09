<script lang="ts">
  import { page } from "$app/state";
  import BrowserPopout from "#lib/components/viewport/BrowserPopout.svelte";
</script>

{#key page.params.id}
  <BrowserPopout sessionId={page.params.id ?? ""} />
{/key}
