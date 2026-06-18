<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    param,
  }: { param: NonNullable<Extract<VisualBlock, { type: "api-endpoint" }>["params"]>[number] } =
    $props();
</script>

<tr class="ae-row">
  <td class="ae-param-name">
    {param.name}
    {#if param.required}<span class="ae-required">{m.vblock_apiendpoint_required()}</span>{/if}
  </td>
  <td class="ae-param-in">{param.in}</td>
  <td class="ae-param-type">{param.type}</td>
  {#if param.note}
    <td class="ae-param-note">{param.note}</td>
  {:else}
    <td></td>
  {/if}
</tr>
