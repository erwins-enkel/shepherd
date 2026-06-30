<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { AgentProvider, Session } from "$lib/types";
  import TaskIdMenu from "./TaskIdMenu.svelte";
  import RecommendDialog from "./RecommendDialog.svelte";

  // The task designation rendered as a button. Clicking it opens a small menu:
  // copy the id, or run a next-prompt recommendation (Opus / GPT-5.5) that analyzes
  // the session's recent terminal history via a transient second agent. Sits above
  // the card's full-area .unit-hit/.tile-hit overlay (position:relative + z-index)
  // with stopPropagation, so its click is its own and doesn't also select the card.
  let {
    session,
    id,
  }: {
    session: Session;
    /** Optional DOM id (the tile's aria-describedby chain references it). */
    id?: string;
  } = $props();

  let btnEl = $state<HTMLButtonElement>();
  let menu = $state<{ anchor: DOMRect } | null>(null);
  let recommend = $state<{ provider: AgentProvider; model: string } | null>(null);
  let copied = $state(false);

  function toggleMenu(e: MouseEvent) {
    e.stopPropagation();
    if (menu) {
      menu = null;
      return;
    }
    if (btnEl) menu = { anchor: btnEl.getBoundingClientRect() };
  }

  async function copyId() {
    menu = null;
    // Copy the task's own identifying facts (built straight from the session prop),
    // not just the bare desig — so an agent it's pasted into knows what the task is
    // and where its work lives without researching. Names/designations are data, so
    // the label is assembled here; only the chrome words are translated.
    const label = session.name ? `${session.desig} (${session.name})` : session.desig;
    const branch = session.branch ?? "—";
    // Non-isolated sessions work in the repo itself (worktreePath === repoPath), so the
    // worktree segment would just repeat the repo path — drop it in that case.
    const text = !session.isolated
      ? m.taskid_copy_payload_inrepo({ label, repoPath: session.repoPath, branch })
      : m.taskid_copy_payload({
          label,
          repoPath: session.repoPath,
          branch,
          worktreePath: session.worktreePath,
        });
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // clipboard blocked (insecure context / denied) — fail quietly.
    }
  }

  function startRecommend(provider: AgentProvider, model: string) {
    menu = null;
    recommend = { provider, model };
  }
</script>

<button
  bind:this={btnEl}
  {id}
  type="button"
  class="desig-btn"
  class:open={!!menu}
  title={m.taskid_button_title({ desig: session.desig })}
  aria-label={m.taskid_button_title({ desig: session.desig })}
  aria-haspopup="menu"
  aria-expanded={!!menu}
  onclick={toggleMenu}
>
  {session.desig}
</button>
{#if copied}
  <span class="sr-only" role="status" aria-live="polite">{m.taskid_copied()}</span>
{/if}

{#if menu}
  <TaskIdMenu
    anchor={menu.anchor}
    opener={btnEl}
    oncopy={copyId}
    onrecommend={startRecommend}
    onclose={() => (menu = null)}
  />
{/if}

{#if recommend}
  <RecommendDialog
    sessionId={session.id}
    provider={recommend.provider}
    model={recommend.model}
    onclose={() => (recommend = null)}
  />
{/if}

<style>
  /* Inherits the surrounding meta typography (color/size/spacing) so it reads as the
     quiet designation it replaces, while being a real, focusable control raised above
     the card's hit overlay. */
  .desig-btn {
    position: relative;
    z-index: 1;
    appearance: none;
    border: 0;
    margin: 0;
    padding: 1px 3px;
    background: transparent;
    color: var(--color-faint);
    font: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    line-height: inherit;
    cursor: pointer;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .desig-btn:hover,
  .desig-btn.open {
    color: var(--color-ink-bright);
    background: var(--color-hover);
  }
  .desig-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
    color: var(--color-ink-bright);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
