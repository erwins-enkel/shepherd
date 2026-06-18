<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import InferredBadge from "./InferredBadge.svelte";

  let { block }: { block: Extract<VisualBlock, { type: "data-model" }> } = $props();

  const CHANGE_COLOR: Record<string, string> = {
    added: "var(--color-green)",
    modified: "var(--color-amber)",
    removed: "var(--color-red)",
    renamed: "var(--color-amber)",
  };
</script>

<div class="dm-block">
  <div class="dm-header">
    {#if block.inferred}
      <InferredBadge />
    {/if}
  </div>

  {#each block.entities as entity (entity.id)}
    <div class="dm-entity">
      <div class="dm-entity-name">{entity.name}</div>
      <table class="dm-table">
        <tbody>
          {#each entity.fields as field, i (i)}
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
          {/each}
        </tbody>
      </table>
    </div>
  {/each}

  {#if block.relations && block.relations.length > 0}
    <div class="dm-relations">
      <span class="dm-relations-label">{m.vblock_datamodel_relations()}</span>
      <ul class="dm-relations-list">
        {#each block.relations as rel, i (i)}
          <li class="dm-relation">
            {rel.from} → {rel.to} <span class="dm-rel-kind">({rel.kind})</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .dm-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dm-header {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 0;
  }
  .dm-header:empty {
    display: none;
  }
  .dm-entity {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    overflow: hidden;
  }
  .dm-entity-name {
    padding: 4px 10px;
    font-size: var(--fs-meta);
    font-weight: 600;
    color: var(--color-ink);
    border-bottom: 1px solid var(--color-line);
    background: var(--color-surface);
  }
  .dm-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }
  .dm-field td {
    padding: 3px 10px;
    vertical-align: top;
  }
  .dm-field:not(:last-child) td {
    border-bottom: 1px solid var(--color-line);
  }
  .dm-field-name {
    color: var(--color-ink);
    white-space: nowrap;
  }
  .dm-field-type {
    color: var(--color-muted);
    white-space: nowrap;
  }
  .dm-field-was {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    white-space: nowrap;
  }
  .dm-tag {
    display: inline-block;
    margin-left: 4px;
    padding: 0 3px;
    font-size: var(--fs-micro);
    border-radius: 2px;
    vertical-align: middle;
    font-family: var(--font-sans, inherit);
    font-weight: 600;
  }
  .dm-pk {
    background: var(--color-amber);
    color: var(--color-surface);
  }
  .dm-fk {
    background: var(--color-blue);
    color: var(--color-surface);
  }
  .dm-nn {
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
  }
  .dm-relations {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .dm-relations-label {
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
  }
  .dm-relations-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .dm-relation {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .dm-rel-kind {
    color: var(--color-muted);
  }
</style>
