<script lang="ts">
  import { untrack } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import DiffPanel from "#lib/components/DiffPanel.svelte";
  import FilesPanel from "./FilesPanel.svelte";
  import FilesSourceSwitch, { type FilesSource } from "./FilesSourceSwitch.svelte";
  import type { FileTarget } from "#lib/types.js";

  // The Files tab: Scratchpad · Worktree · Diff. `filesAvailable` (computeHasFiles) gates the two
  // listings; without them there is no switch and the Diff (formerly its own tab) renders directly.
  // `withDiff` false (a host with its own Diff tab) drops the Diff source.
  // `focus` (#3997): a chat host-path link to reveal — selects its source and hands the entry to
  // the listing. A new `seq` re-applies it.
  let {
    sessionId,
    filesAvailable,
    withDiff = true,
    focus,
  }: {
    sessionId: string;
    filesAvailable: boolean;
    withDiff?: boolean;
    focus?: FileTarget & { source: "scratchpad" | "worktree"; seq: number };
  } = $props();

  // A focus present at mount picks the first source, so no other listing loads first.
  const initial = (): FilesSource => (filesAvailable ? (focus?.source ?? "scratchpad") : "diff");
  const initialReveal = () =>
    filesAvailable && focus ? { path: focus.path, type: focus.type, seq: focus.seq } : undefined;
  let source = $state<FilesSource>(untrack(initial));
  let reveal = $state<{ path: string; type: FileTarget["type"]; seq: number } | undefined>(
    untrack(initialReveal),
  );

  // A session switch starts on the default source again.
  $effect(() => {
    void sessionId;
    untrack(() => {
      source = initial();
      reveal = initialReveal();
    });
  });
  $effect(() => {
    const f = focus;
    if (!f || !filesAvailable) return;
    untrack(() => {
      source = f.source;
      reveal = { path: f.path, type: f.type, seq: f.seq };
    });
  });
  // The listings went away: fall back to the Diff rather than keep a source the switch hides.
  $effect(() => {
    if (!filesAvailable) source = "diff";
  });
</script>

<div class="files-tab">
  {#if filesAvailable}
    <FilesSourceSwitch
      {source}
      {withDiff}
      onswitch={(s) => {
        source = s;
        reveal = undefined;
      }}
    />
  {/if}
  {#if source === "diff"}
    <div class="diff-wrap" role="region" aria-label={m.files_diff_aria()}>
      <DiffPanel {sessionId} />
    </div>
  {:else}
    <!-- keyed: each source starts fresh (root, default sort, no stale uploads or listing) -->
    {#key source}
      <div class="listing"><FilesPanel {sessionId} {source} {reveal} /></div>
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
