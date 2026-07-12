<script lang="ts">
  // Thin Svelte 5 wrapper around @pierre/diffs' vanilla `FileDiff` API, rendering
  // ONE file's diff. Everything Pierre-related is CLIENT-ONLY: all `@pierre/diffs`
  // access is dynamic-imported inside `$effect` (which never runs during SSR), so
  // this component is safe to render on the server (it emits just the empty host
  // `<div>`).
  //
  // Custom-element registration: dynamic-importing `@pierre/diffs` transitively
  // runs `dist/components/web-components.js` (a side-effect module FileDiff.js
  // statically imports), which calls `customElements.define("diffs-container", …)`.
  // So merely importing FileDiff upgrades the `<diffs-container>` host — no
  // separate submodule import is needed. (package.json lists that file under
  // `sideEffects`, so bundlers keep it.)
  //
  // The `<diffs-container>` host is created and appended by PIERRE (we pass
  // `containerWrapper: root`, and `render()` builds + inserts the host into it) —
  // not by us. That is deliberate: Pierre owns the host's light DOM (it slots
  // annotation nodes into it) and removes it on `cleanUp()`, so it must not be a
  // Svelte-managed template element. Svelte only owns the empty wrapper `<div>`.
  //
  // Split-vs-unified is driven via `setOptions(opts) + rerender()`. NOTE Pierre's
  // `setOptions` REPLACES the options object wholesale (no merge) — and Pierre's
  // own `setThemeType()` also swaps in a NEW `fd.options` object behind our back —
  // so we spread `fd.options` (the single live source of truth) when toggling
  // `diffStyle`, NOT a component-side copy that would drift (e.g. freeze themeType
  // at mount and silently revert the theme on toggle).
  import type { DiffLineAnnotation, FileDiff, FileDiffOptions } from "@pierre/diffs";
  import { theme } from "$lib/theme.svelte";
  import { registerShepherdThemes, parseFilePatch } from "$lib/pierre-diff";

  type Annotation = DiffLineAnnotation;

  let {
    patch,
    signature,
    diffStyle,
    lineAnnotations = [],
    renderAnnotation,
  }: {
    patch: string;
    signature: string;
    diffStyle: "split" | "unified";
    lineAnnotations?: Annotation[];
    renderAnnotation?: (a: Annotation) => HTMLElement | undefined;
  } = $props();

  // Wrapper the `<diffs-container>` host is appended into (by Pierre).
  let root = $state<HTMLDivElement>();

  // Non-reactive instance state (deliberately plain `let`, not `$state`: these
  // drive the external Pierre lib, never the template).
  let fd: FileDiff | undefined; // the FileDiff instance (fd.options is the live options source of truth)
  let lastSignature: string | undefined; // content-gate: skip re-render when unchanged
  // Render-generation counter: every (re-)render bumps it and captures the value;
  // after each `await` a stale generation bails, so a rapid prop change or teardown
  // can never interleave two `render()` calls on the same host.
  let gen = 0;

  // Lazily import + instantiate Pierre once. Reads the CURRENT `diffStyle`/theme
  // for the initial construction; subsequent changes are handled by the reaction
  // effects below.
  async function ensureInit(): Promise<void> {
    if (fd) return;
    const { FileDiff } = await import("@pierre/diffs");
    await registerShepherdThemes();
    if (fd) return; // another call won the race while we awaited
    const options: FileDiffOptions<undefined> = {
      theme: { dark: "shepherd-dark", light: "shepherd-light" },
      themeType: theme.resolved,
      diffStyle,
      lineDiffType: "word",
      diffIndicators: "bars",
      // `overflow: "wrap"` is REQUIRED — otherwise side-by-side split silently
      // collapses to stacked.
      overflow: "wrap",
      renderAnnotation,
    };
    fd = new FileDiff(options);
  }

  // Parse `patch` and (re-)render into the host. Guarded by `gen` so overlapping
  // async calls can't interleave. `containerWrapper: root` lets Pierre create +
  // insert the `<diffs-container>` host itself on first render.
  async function renderContent(): Promise<void> {
    const myGen = ++gen;
    await ensureInit();
    if (myGen !== gen || !fd || !root) return;
    const meta = await parseFilePatch(patch);
    if (myGen !== gen || !fd || !root) return;
    if (meta == null) return; // empty/invalid patch — nothing to render
    fd.render({ fileDiff: meta, containerWrapper: root, lineAnnotations });
    lastSignature = signature;
  }

  // Content reaction: (re-)render only when the signature actually changes.
  // `signature` is a hash of the patch content, so it is the sole gate — an
  // unchanged file (e.g. a 15s poll returning identical content) has an identical
  // signature and is skipped, preventing a flash/re-render.
  $effect(() => {
    if (signature === lastSignature) return;
    void renderContent();
  });

  // Theme reaction: instant swap, no re-render (Pierre keeps both themes' CSS).
  $effect(() => {
    const resolved = theme.resolved;
    fd?.setThemeType(resolved);
  });

  // View reaction: toggle split↔unified. `setOptions` replaces options wholesale,
  // so spread `fd.options` (the live source of truth — Pierre mutates it via
  // setThemeType, so any component-side copy would drift and revert the theme);
  // `rerender()` re-lays-out from the stored fileDiff (a full re-parse is NOT
  // needed — proven in PierreDiff.browser.test.ts).
  $effect(() => {
    const style = diffStyle;
    if (!fd || fd.options.diffStyle === style) return;
    fd.setOptions({ ...fd.options, diffStyle: style });
    fd.rerender();
  });

  // Teardown: `cleanUp()` disposes Pierre's Resize/Interaction/ScrollSync managers
  // and (since the container is Pierre-managed) removes the host node it created —
  // so there is no manager-listener leak and Svelte's own removal of the empty
  // wrapper never collides with a node it doesn't track. Bump `gen` first to
  // cancel any in-flight async render.
  $effect(() => {
    return () => {
      gen++;
      fd?.cleanUp();
      fd = undefined;
    };
  });
</script>

<div bind:this={root} class="pierre-diff"></div>

<style>
  /* Layout only — the diff BODY themes itself via injected Shiki themes inside
     the shadow DOM (app tokens can't cascade in). The wrapper needs no chrome. */
  .pierre-diff {
    display: block;
  }
</style>
