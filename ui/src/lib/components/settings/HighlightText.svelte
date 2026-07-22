<script lang="ts">
  // Wraps every case-insensitive occurrence of the search query in an amber-24%
  // <mark> (the design handoff's search-match highlight). Renders the plain
  // text unchanged when the query is empty or absent from it.
  let { text, query = "" }: { text: string; query?: string } = $props();

  type Seg = { str: string; hit: boolean };
  const segments = $derived.by((): Seg[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [{ str: text, hit: false }];
    const lower = text.toLowerCase();
    const out: Seg[] = [];
    let i = 0;
    while (i < text.length) {
      const at = lower.indexOf(q, i);
      if (at === -1) {
        out.push({ str: text.slice(i), hit: false });
        break;
      }
      if (at > i) out.push({ str: text.slice(i, at), hit: false });
      out.push({ str: text.slice(at, at + q.length), hit: true });
      i = at + q.length;
    }
    return out;
  });
</script>

<!-- prettier-ignore -->
{#each segments as seg, i (i)}{#if seg.hit}<mark>{seg.str}</mark>{:else}{seg.str}{/if}{/each}

<style>
  mark {
    background: color-mix(in srgb, var(--color-amber) 24%, transparent);
    color: inherit;
  }
</style>
