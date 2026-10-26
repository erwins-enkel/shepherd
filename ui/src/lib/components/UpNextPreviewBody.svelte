<script lang="ts">
  import type { LazyBody } from "#lib/lazy-body.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import MarkdownBody from "./MarkdownBody.svelte";

  // The rendered description in an Up Next preview: loading, the read's failure with a retry, or
  // the Markdown. `unavailable` names what could not be read (an issue or a pull request).
  let { loader, unavailable }: { loader: LazyBody; unavailable: string } = $props();
</script>

{#if loader.error}
  <div role="alert">
    <p>{unavailable}</p>
    <button type="button" class="gbtn" onclick={() => loader.retry()}>{m.common_retry()}</button>
  </div>
{:else if loader.body === null}
  <p role="status">{m.common_loading()}</p>
{:else}
  <MarkdownBody source={loader.body} />
{/if}
