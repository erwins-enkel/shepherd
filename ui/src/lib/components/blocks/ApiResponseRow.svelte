<script lang="ts">
  import type { VisualBlock } from "$lib/types";

  let {
    resp,
  }: { resp: NonNullable<Extract<VisualBlock, { type: "api-endpoint" }>["responses"]>[number] } =
    $props();
</script>

<tr class="ae-row">
  <td class="ae-resp-status">{resp.status}</td>
  {#if resp.description}
    <td class="ae-resp-desc">{resp.description}</td>
  {:else}
    <td></td>
  {/if}
  {#if resp.example}
    <td class="ae-resp-example"><code>{resp.example}</code></td>
  {:else}
    <td></td>
  {/if}
</tr>
