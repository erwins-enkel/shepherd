<script lang="ts">
  import { parseGlossary } from "$lib/glossary-parse";
  import GlossaryTerm from "./GlossaryTerm.svelte";

  const { text }: { text: string } = $props();

  const segments = $derived(parseGlossary(text));
</script>

{#each segments as seg, i (i)}
  {#if seg.t === "text"}
    {seg.value}
  {:else}
    <GlossaryTerm id={seg.id} label={seg.label} />
  {/if}
{/each}
