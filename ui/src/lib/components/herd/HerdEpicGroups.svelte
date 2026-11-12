<script lang="ts">
  import type { DrainStatus, Epic } from "#lib/types.js";
  import HerdGroup from "./HerdGroup.svelte";
  import type { HerdRowCtx } from "./HerdGroup.svelte";
  import EpicGroupHeader from "../EpicGroupHeader.svelte";
  import EpicGroupMenu from "../EpicGroupMenu.svelte";
  import EpicDiagnosisModal from "../EpicDiagnosisModal.svelte";
  import type { SessionlessEpicWait } from "../epic-sessionless";
  import { isRemoteEpic } from "../epic-grouping";
  import { m } from "#lib/paraglide/messages.js";

  type EpicGroupEntry = {
    key: string;
    epic: Epic;
    sessions: import("#lib/types.js").Session[];
    /** Set on a running/paused epic with no child session (#3814): the group says why it waits
     *  instead of listing rows. */
    wait?: SessionlessEpicWait;
  };

  let {
    groups,
    collapsedKeys,
    cuesFor,
    onepic,
    oncollapsetoggle,
    slotsFor = () => null,
    drainFor = () => undefined,
    onaskepic,
    ctx,
  }: {
    groups: EpicGroupEntry[];
    collapsedKeys: Set<string>;
    cuesFor: (g: { key: string; sessions: import("#lib/types.js").Session[] }) => {
      ciFailed: number;
      needsRework: number;
      branchProtectionBlocked: number;
      ready: number;
      blocked: number;
    };
    onepic?: (repoPath: string, issueNumber: number) => void;
    oncollapsetoggle?: (key: string) => void;
    /** A repo's agent slots (its drain cap); null when unknown. */
    slotsFor?: (repoPath: string) => number | null;
    /** A repo's drain status — the epic menu reads its run picture. */
    drainFor?: (repoPath: string) => DrainStatus | undefined;
    /** Opens the Operator Assistant with a question about an epic typed in. */
    onaskepic?: (repoPath: string, parent: number) => void;
    ctx: HerdRowCtx;
  } = $props();

  // The epic menu (right-click / long-press on a group's header or session-less note). Keyed by
  // group, so a group that leaves the herd takes its menu with it.
  let menu = $state<{ key: string; x: number; y: number; opener: HTMLElement } | null>(null);
  const menuGroup = $derived(menu ? groups.find((g) => g.key === menu!.key) : undefined);
  let diagnosing = $state<{ repoPath: string; parent: number } | null>(null);
  // The session-less note's details button, per group: focus returns there from its menu.
  const noteButtons: Record<string, HTMLButtonElement> = {};

  function openMenu(key: string, x: number, y: number, opener: HTMLElement): boolean {
    if (menuGroup) return false;
    menu = { key, x, y, opener };
    return true;
  }
  function onNoteMenu(e: MouseEvent, key: string) {
    const opener = noteButtons[key];
    if (!opener) return;
    e.preventDefault();
    openMenu(key, e.clientX, e.clientY, opener);
  }
  function closeMenu() {
    menu = null;
  }
  function openMenuEpic() {
    const epic = menuGroup?.epic;
    if (epic) onepic?.(epic.repoPath, epic.parentIssueNumber);
  }
  function askMenuEpic() {
    const epic = menuGroup?.epic;
    if (epic) onaskepic?.(epic.repoPath, epic.parentIssueNumber);
  }
  function diagnoseMenuEpic() {
    const epic = menuGroup?.epic;
    if (epic) diagnosing = { repoPath: epic.repoPath, parent: epic.parentIssueNumber };
  }
</script>

{#each groups as g, i (g.key)}
  <!-- An epic another machine leads is view-only: its machine badge, no backlog link, no menu —
       it is run and landed there. Collapsing still works. -->
  {@const remote = isRemoteEpic(g.epic) ? g.epic : null}
  <!-- Only the first badge anchors the coachmark: coachTargets keys one node per id. -->
  <EpicGroupHeader
    epic={g.epic}
    collapsed={collapsedKeys.has(g.key)}
    cues={cuesFor(g)}
    nowMs={ctx.nowMs}
    slots={remote ? null : slotsFor(g.epic.repoPath)}
    coachId={i === 0 ? "epic-timing" : ""}
    sessionless={!!g.wait}
    host={remote?.host}
    connection={remote?.connection}
    ontoggle={() => oncollapsetoggle?.(g.key)}
    onepic={remote ? undefined : onepic}
    onmenu={remote ? undefined : (x, y, opener) => openMenu(g.key, x, y, opener)}
  />
  {#if !collapsedKeys.has(g.key)}
    {#if g.wait}
      <!-- Right-click here is a pointer shortcut to the header's menu, which keyboard users
           reach from the header toggle (context-menu key / Shift+F10). -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="epic-sessionless" oncontextmenu={(e) => onNoteMenu(e, g.key)}>
        <p class="sl-status">{g.wait.status}</p>
        {#each g.wait.lines as line, j (j)}
          <p class="sl-line">{line}</p>
        {/each}
        {#if !remote}
          <button
            bind:this={noteButtons[g.key]}
            type="button"
            class="gbtn"
            onclick={() => onepic?.(g.epic.repoPath, g.epic.parentIssueNumber)}
            >{m.epic_sessionless_open()}</button
          >
        {/if}
      </div>
    {:else}
      <div class="epic-children">
        <HerdGroup sessions={g.sessions} withPreview={true} {ctx} />
      </div>
    {/if}
  {/if}
{/each}

{#if menu && menuGroup}
  <EpicGroupMenu
    epic={menuGroup.epic}
    drain={drainFor(menuGroup.epic.repoPath)}
    x={menu.x}
    y={menu.y}
    opener={menu.opener}
    onopen={onepic ? openMenuEpic : undefined}
    onask={onaskepic ? askMenuEpic : undefined}
    ondiagnose={diagnoseMenuEpic}
    onclose={closeMenu}
  />
{/if}
{#if diagnosing}
  <EpicDiagnosisModal
    repoPath={diagnosing.repoPath}
    parent={diagnosing.parent}
    onclose={() => (diagnosing = null)}
  />
{/if}

<style>
  /* Child rows of an epic group nest by indentation alone: their pips shift one --nest step
     right of the top-level pips. No rail — a vertical line here doubled up with the rows'
     own edges. */
  .epic-children {
    --nest: 20px;
  }
  .epic-children :global(.unit) {
    padding-left: calc(14px + var(--nest));
  }
  @container herd (max-width: 300px) {
    .epic-children {
      --nest: 12px;
    }
  }

  /* #3814: a session-less epic's wait note, nested like child rows would be. */
  .epic-sessionless {
    --nest: 20px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 4px 8px 8px calc(14px + var(--nest));
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  @container herd (max-width: 300px) {
    .epic-sessionless {
      --nest: 12px;
    }
  }
  .epic-sessionless p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .sl-status {
    color: var(--color-ink);
  }
  /* canonical .gbtn recipe (/design-system) */
  .gbtn {
    margin-top: 2px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
