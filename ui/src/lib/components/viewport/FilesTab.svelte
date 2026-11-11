<script lang="ts">
  import { untrack } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import DiffPanel from "#lib/components/DiffPanel.svelte";
  import FilesPanel from "./FilesPanel.svelte";
  import FilesSourceSwitch, { type FilesSource } from "./FilesSourceSwitch.svelte";

  // The Files tab: Scratchpad · Worktree · Diff. `filesAvailable` (computeHasFiles) gates the two
  // listings; without them there is no switch and the Diff (formerly its own tab) renders directly.
  // `withDiff` false (a host with its own Diff tab) drops the Diff source.
  let {
    sessionId,
    filesAvailable,
    withDiff = true,
  }: { sessionId: string; filesAvailable: boolean; withDiff?: boolean } = $props();

  const initial = (): FilesSource => (filesAvailable ? "scratchpad" : "diff");
  let source = $state<FilesSource>(untrack(initial));

  // A session switch starts on the default source again.
  $effect(() => {
    void sessionId;
    untrack(() => (source = initial()));
  });
  // The listings went away: fall back to the Diff rather than keep a source the switch hides.
  $effect(() => {
    if (!filesAvailable) source = "diff";
  });
</script>

<div class="files-tab">
  {#if filesAvailable}
    <FilesSourceSwitch {source} {withDiff} onswitch={(s) => (source = s)} />
  {/if}
  {#if source === "diff"}
    <div class="diff-wrap" role="region" aria-label={m.files_diff_aria()}>
      <DiffPanel {sessionId} />
    </div>
  {:else}
    <!-- keyed: each source starts fresh (root, default sort, no stale uploads or listing) -->
    {#key source}
      <div class="listing"><FilesPanel {sessionId} {source} /></div>
    {/key}
  {/if}
</div>

<style>
  .files-tab {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .diff-wrap,
  .listing {
    flex: 1;
    min-height: 0;
  }
</style>
