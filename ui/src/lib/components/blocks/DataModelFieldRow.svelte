<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  type Field = Extract<VisualBlock, { type: "data-model" }>["entities"][number]["fields"][number];

  const CHANGE_COLOR: Record<string, string> = {
    added: "var(--color-green)",
    modified: "var(--color-amber)",
    removed: "var(--color-red)",
    renamed: "var(--color-amber)",
  };

  let { field }: { field: Field } = $props();
</script>

<tr
  class="dm-field"
  class:dm-field-changed={!!field.change}
  style:color={field.change ? CHANGE_COLOR[field.change] : undefined}
>
  <td class="dm-field-name">
    {field.name}
    {#if field.pk}<span class="dm-tag dm-pk">{m.vblock_datamodel_pk()}</span>{/if}
    {#if field.fk}<span class="dm-tag dm-fk">{m.vblock_datamodel_fk()}</span>{/if}
    {#if field.nullable !== undefined && !field.nullable}<span class="dm-tag dm-nn"
        >{m.vblock_datamodel_nullable()}</span
      >{/if}
  </td>
  <td class="dm-field-type">{field.type}</td>
  {#if field.was}
    <td class="dm-field-was">{m.vblock_datamodel_was({ was: field.was })}</td>
  {:else}
    <td></td>
  {/if}
</tr>
