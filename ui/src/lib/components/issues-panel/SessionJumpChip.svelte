<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { qualifiedDesig } from "#lib/remote-sessions.js";

  // A running epic child's task ID as a one-click jump into its session — in the backlog list
  // row and the epic's child list. Shows the bare designation: the MachineBadge beside it names
  // the machine, and the accessible name carries the qualified one. Click and key events stop
  // here, so a host row (a listbox option) neither selects nor activates along with it.
  let {
    session,
    onopen,
    tabindex = 0,
  }: {
    session: Session;
    onopen: () => void;
    /** -1 inside a listbox whose container owns focus (the backlog list). */
    tabindex?: number;
  } = $props();

  const label = $derived(m.childrun_open_session_desig({ desig: qualifiedDesig(session) }));
</script>

<button
  class="jump"
  type="button"
  {tabindex}
  title={label}
  aria-label={label}
  onclick={(e) => {
    e.stopPropagation();
    onopen();
  }}
  onkeydown={(e) => e.stopPropagation()}
  ><span class="desig">{session.desig}</span><span aria-hidden="true">→</span></button
>

<style>
  .jump {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    white-space: nowrap;
    cursor: pointer;
  }
  .desig {
    font-family: var(--font-mono);
  }
  .jump:hover,
  .jump:focus-visible {
    border-color: var(--color-amber);
    color: var(--color-amber);
    outline: none;
  }

  @media (pointer: coarse) {
    .jump {
      min-height: 44px;
    }
  }
</style>
