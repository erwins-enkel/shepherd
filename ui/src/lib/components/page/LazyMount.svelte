<!--
  Mounts a code-split component once its chunk arrives (#3233). Renders nothing while loading;
  a failed load (dropped chunk, or a deploy that moved the hashes) raises one toast whose Reload
  action recovers both cases. Usage keeps the child's props type-checked:

    <LazyMount load={loadSettings}>{#snippet children(Settings)}<Settings … />{/snippet}</LazyMount>
-->
<script lang="ts" generics="C extends Component<never>">
  import type { Component, Snippet } from "svelte";
  import type { Loader } from "#lib/lazy-component.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { m } from "#lib/paraglide/messages.js";

  let { load, children }: { load: Loader<C>; children: Snippet<[C]> } = $props();

  const component = $derived(
    load().then(
      (mod) => mod.default,
      () => {
        toasts.info(m.lazy_load_failed(), {
          alert: true,
          key: "lazy-load-failed",
          action: { label: m.viewport_browser_reload(), run: () => location.reload() },
        });
        return null;
      },
    ),
  );
</script>

{#await component then Loaded}
  {#if Loaded}{@render children(Loaded)}{/if}
{/await}
