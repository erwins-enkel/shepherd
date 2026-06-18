<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import GlossaryTerm from "../GlossaryTerm.svelte";
</script>

<span class="inferred-badge">
  <GlossaryTerm id="inferred" label={m.vblock_inferred()} />
</span>

<style>
  .inferred-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border: 1px dashed var(--color-amber);
    border-radius: 3px;
    font-size: var(--fs-micro);
    color: var(--color-amber);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
</style>
