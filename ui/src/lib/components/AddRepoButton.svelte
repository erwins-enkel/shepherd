<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import AddRepoMenu from "./AddRepoMenu.svelte";

  // "+ Add repo" trigger for the Backlog repos panel. Owns the popover open state
  // and mounts the scrim-exempt AddRepoMenu anchored to this button. The three
  // actions bubble up to the page, which opens the already-mounted modals.
  //
  // No use:coachTarget: the only <Coachmark> host (GitRail) arms exclusively from
  // PILL_FEATURE_IDS and isn't mounted in the Backlog overlay, so an arbitrary
  // targetId would be a dead anchor — this feature is surfaced via the What's-New
  // drawer instead (see feature-announcements.ts → "backlog-add-repo").
  let {
    onclone,
    onfork,
    onnewproject,
  }: {
    onclone: () => void;
    onfork: () => void;
    onnewproject: () => void;
  } = $props();

  let open = $state(false);
  let btn = $state<HTMLButtonElement>();

  function choose(action: () => void) {
    open = false;
    action();
  }
</script>

<button
  bind:this={btn}
  class="add-repo-btn"
  type="button"
  aria-haspopup="menu"
  aria-expanded={open}
  onclick={() => (open = !open)}
>
  {m.backlog_add_repo()}
</button>

{#if open && btn}
  <AddRepoMenu
    anchor={btn}
    onnewproject={() => choose(onnewproject)}
    onclone={() => choose(onclone)}
    onfork={() => choose(onfork)}
    onclose={() => (open = false)}
  />
{/if}

<style>
  /* Secondary/outline action — neutral line colour so it reads as a lower-priority
     affordance next to the repo list (mirrors the .clone-trigger shape removed from
     Settings, on tokens). */
  .add-repo-btn {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 0 10px;
    min-height: 36px;
    cursor: pointer;
    touch-action: manipulation;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  .add-repo-btn:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink);
  }
</style>
