<!--
  Mounts a code-split component once its chunk arrives (#3233). Renders nothing while loading;
  a failed load (dropped chunk, or a deploy that moved the hashes) raises one sticky toast whose
  Reload action recovers both cases, and calls `onerror` so the caller can drop its open flag —
  otherwise the flag stays set with nothing mounted, blocking shortcuts and the lazy() retry. Usage keeps the child's props type-checked:

    <LazyMount load={loadSettings}>{#snippet children(Settings)}<Settings … />{/snippet}</LazyMount>
-->
<script lang="ts" generics="C extends Component<never>">
  import type { Component, Snippet } from "svelte";
  import type { Loader } from "#lib/lazy-component.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { m } from "#lib/paraglide/messages.js";

  let {
    load,
    children,
    onerror,
  }: { load: Loader<C>; children: Snippet<[C]>; onerror?: () => void } = $props();

  const component = $derived(
    load().then(
      (mod) => mod.default,
      () => {
        toasts.info(m.lazy_load_failed(), {
          alert: true,
          sticky: true,
          key: "lazy-load-failed",
          action: { label: m.viewport_browser_reload(), run: () => location.reload() },
        });
        onerror?.();
        return null;
      },
    ),
  );
</script>

{#await component then Loaded}
  {#if Loaded}{@render children(Loaded)}{/if}
{/await}
