<script lang="ts">
  let { slug, webUrl }: { slug: string | null; webUrl: string | null } = $props();
</script>

{#if slug}<span class="sep">·</span
  >{#if webUrl}<!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
    <a class="repo-link" href={webUrl} target="_blank" rel="noopener">{slug}</a
    >{:else}{slug}{/if}{/if}

<style>
  .sep {
    color: var(--color-faint);
    margin: 0 0.35em;
  }

  .repo-link {
    color: inherit;
    text-decoration: none;
  }

  .repo-link:hover,
  .repo-link:focus-visible {
    text-decoration: underline;
  }

  .repo-link:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: 1px;
  }
</style>
