<script lang="ts">
  // Test-only harness: reproduces the /design-system route's setContext(INFO_TIPS_FORCE, true)
  // so the exemption can be asserted without mounting the whole catalogue page.
  import { setContext } from "svelte";
  import { INFO_TIPS_FORCE } from "$lib/info-tips.svelte";
  import InfoTip from "./InfoTip.svelte";
  import GlossaryText from "./GlossaryText.svelte";

  setContext(INFO_TIPS_FORCE, true);
</script>

<InfoTip text="Explanation body" label="What this does" />
<GlossaryText text="Shepherd groups sessions under an [[epic|epic]]." />
