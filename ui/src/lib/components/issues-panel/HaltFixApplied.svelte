<script lang="ts">
  import type { OverviewFix } from "#lib/repo-precheck.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { overviewConfirmText } from "../repo-halt";
  import "./halt-controls.css";

  // #3456: a fix applied from the repo overview — what it set and Undo — where it was applied:
  // under the repo banner or on the epic's card.
  let {
    fix,
    repoName,
    busy = false,
    onundo,
    undoButton = $bindable(),
    ...rest
  }: {
    fix: OverviewFix;
    repoName: string;
    busy?: boolean;
    onundo: () => void;
    /** The Undo button, so the host can move the focus there once the fix went through. */
    undoButton?: HTMLButtonElement;
    [key: `data-${string}`]: boolean | string | undefined;
  } = $props();
</script>

<p class="hc-fixed" role="status" {...rest}>
  <span class="hc-fixed-mark" aria-hidden="true">✓</span>
  <span>{overviewConfirmText(fix.changes, repoName, fix.parent)}</span>
  <button bind:this={undoButton} class="hc-link" type="button" disabled={busy} onclick={onundo}
    >{m.epic_autofix_undo()}</button
  >
</p>
