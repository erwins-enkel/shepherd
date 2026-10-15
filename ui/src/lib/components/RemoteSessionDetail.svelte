<script lang="ts">
  import type { Session, SessionUsage, TerminalClientInfo } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { getSessionUsage } from "#lib/api.js";
  import { pollWhileVisible } from "#lib/visibility.js";
  import { isMirrored, qualifiedDesig } from "#lib/remote-sessions.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { remoteFactsExplanation, remoteSessionExplanation } from "#lib/tooltips/explanations.js";
  import StatusPip from "./StatusPip.svelte";
  import MachineBadge from "./MachineBadge.svelte";
  import RemoteConnectionNote from "./RemoteConnectionNote.svelte";
  import RemoteTerminal from "./RemoteTerminal.svelte";
  import ActivityFeed from "./ActivityFeed.svelte";
  import DiffPanel from "./DiffPanel.svelte";
  import FilesPanel from "./viewport/FilesPanel.svelte";
  import SessionStatusBar from "./SessionStatusBar.svelte";
  import SteerBar from "./SteerBar.svelte";
  import ViewportFootHints from "./viewport/ViewportFootHints.svelte";
  import RemoteSessionActions from "./remote-session/RemoteSessionActions.svelte";
  import RemotePreview from "./remote-session/RemotePreview.svelte";

  // The detail of a session mirrored from a connected machine (#2762), mounted in place of the
  // Viewport and laid out like it: one header row (identity, tabs, machine, status, stop and
  // archive), the live terminal (bridged by this server, #2764) filling the body, then the status
  // bar, the steer bar and the keyboard hints. What the machine reports about the task sits in the
  // designator's hover panel, as the Viewport's meta popover does locally. Every action and read is
  // forwarded to the machine and runs there (#2765, #2767). While it is disconnected only the
  // terminal tab (which says so) and the disabled, explained actions remain.
  let {
    session,
    nowMs,
    terminalOwners = null,
    previewTick = 0,
    compact = false,
    onback = undefined,
    ondecommission = undefined,
    onedit = undefined,
  }: {
    session: Session;
    nowMs: number;
    /** Who holds each terminal, the machines' included; null until the event stream reports. */
    terminalOwners?: Record<string, TerminalClientInfo> | null;
    /** Bumped whenever the machine reports a change of this session's preview (#2767). */
    previewTick?: number;
    /** Phone or touch layout, as the Viewport's: the header wraps, the keyboard hints go. */
    compact?: boolean;
    onback?: () => void;
    /** Archive the session on its machine — the page's undo-windowed decommission. */
    ondecommission?: (id: string, reap?: string[]) => void;
    /** Open this Shepherd's steers editor (the steer bar's pencil). */
    onedit?: (steerId?: string) => void;
  } = $props();

  const mirrored = $derived(isMirrored(session) ? session : null);
  const live = $derived(session.connection?.state === "connected");
  const tip = $derived(
    session.host && session.connection
      ? remoteSessionExplanation(session.host, session.connection, nowMs)
      : null,
  );
  const facts = $derived(mirrored ? { text: remoteFactsExplanation(mirrored), wide: true } : null);

  // The Viewport's header branch label: every session branch is cut as `shepherd/<name>`, so the
  // prefix goes, and a branch that only repeats the session's name is not shown twice.
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const branchLabel = $derived(session.branch?.replace(/^shepherd\//, ""));
  const showBranch = $derived(!!branchLabel && slug(branchLabel) !== slug(session.name));

  type Tab = "term" | "activity" | "diff" | "files" | "preview";
  const TABS: { id: Tab; label: () => string }[] = [
    { id: "term", label: m.viewport_terminal_tab },
    { id: "activity", label: m.viewport_activity_tab },
    { id: "diff", label: m.viewport_diff_tab },
    { id: "files", label: m.viewport_files_tab },
    { id: "preview", label: m.viewport_preview_tab },
  ];
  // The chosen tab belongs to the session it was chosen on: another session — or a lost link,
  // which leaves nothing to read — shows the terminal again.
  let chosen = $state<{ id: string; tab: Tab }>({ id: "", tab: "term" });
  const tab = $derived(live && chosen.id === session.id ? chosen.tab : "term");
  const panelId = $derived(`remote-panel-${session.id}`);
  const tabId = (t: Tab) => `remote-tab-${session.id}-${t}`;

  // Token usage for the status bar, read from the machine (forwarded like the other reads) while it
  // is connected; kept per session, so another session never shows this one's numbers.
  const sessionId = $derived(session.id);
  let usageOf = $state<{ id: string; usage: SessionUsage } | null>(null);
  const usage = $derived(usageOf?.id === session.id ? usageOf.usage : null);
  $effect(() => {
    const id = sessionId;
    if (!live) return;
    let alive = true;
    const load = () =>
      getSessionUsage(id)
        .then((u) => {
          if (alive) usageOf = { id, usage: u };
        })
        .catch(() => {});
    load();
    const stop = pollWhileVisible(load, 5000); // skip hidden-tab ticks; refresh on return
    return () => {
      alive = false;
      stop();
    };
  });

  let terminal = $state<RemoteTerminal>();
  /** Hand the keyboard back to the terminal — the page's Enter, as the Viewport's focusTerminal. */
  export function focusTerminal() {
    if (tab === "term") terminal?.focus();
  }
</script>

<section class="remote-detail" aria-label={qualifiedDesig(session)}>
  <header class="head" class:compact>
    {#if onback}
      <button type="button" class="back" aria-label={m.viewport_back_aria()} onclick={onback}
        >{m.viewport_back_button()}</button
      >
    {/if}
    <button type="button" class="desig" use:statusTip={facts}>{qualifiedDesig(session)}</button>
    <span class="name" title={session.name}>{session.name}</span>
    {#if !compact && showBranch}
      <span class="sep">·</span>
      <span class="branch" title={session.branch}>{branchLabel}</span>
    {/if}
    <div class="spacer"></div>
    <div class="tabs" role="tablist" aria-label={m.viewport_tablist_aria()}>
      {#each TABS as t (t.id)}
        <button
          type="button"
          class="tab"
          class:active={tab === t.id}
          role="tab"
          id={tabId(t.id)}
          aria-selected={tab === t.id}
          aria-controls={panelId}
          disabled={!live && t.id !== "term"}
          onclick={() => (chosen = { id: session.id, tab: t.id })}>{t.label()}</button
        >
      {/each}
    </div>
    <span class="sep">·</span>
    {#if session.host}
      <MachineBadge host={session.host} connection={session.connection} {nowMs} />
    {/if}
    <StatusPip status={session.status} ready={session.readyToMerge} tip />
    {#if mirrored && tip}
      <!-- Keyed: an Archive armed on one session must never confirm another. -->
      {#key mirrored.id}
        <RemoteSessionActions session={mirrored} {tip} {ondecommission} />
      {/key}
    {/if}
  </header>
  <RemoteConnectionNote {session} {nowMs} />
  <div class="body" id={panelId} role="tabpanel" aria-labelledby={tabId(tab)}>
    {#if mirrored}
      <!-- Kept mounted (hidden) under the other tabs, so its socket and scrollback survive. -->
      <div class="term" hidden={tab !== "term"}>
        {#key mirrored.id}
          <RemoteTerminal
            bind:this={terminal}
            session={mirrored}
            owner={terminalOwners === null ? undefined : (terminalOwners[mirrored.id] ?? null)}
          />
        {/key}
      </div>
    {/if}
    {#if tab === "activity"}
      <ActivityFeed sessionId={session.id} />
    {:else if tab === "diff"}
      <DiffPanel sessionId={session.id} />
    {:else if tab === "files"}
      <FilesPanel sessionId={session.id} />
    {:else if tab === "preview" && mirrored}
      {#key mirrored.id}
        <RemotePreview session={mirrored} tick={previewTick} />
      {/key}
    {/if}
  </div>
  <SessionStatusBar {session} {usage} />
  {#if tab === "term"}
    {#if live}
      <SteerBar
        focusedId={session.id}
        repoPath={session.repoPath}
        agentProvider={session.agentProvider ?? "claude"}
        {onedit}
      />
    {:else if tip}
      <!-- Where the steer bar stands: disabled, saying why, like the header's actions. -->
      <div class="steer-off">
        <button
          type="button"
          class="gbtn"
          aria-disabled="true"
          use:statusTip={{ text: tip, wide: true }}>{m.remote_detail_steer()}</button
        >
      </div>
    {/if}
  {/if}
  {#if !compact}
    <ViewportFootHints showEnter={tab === "term"} />
  {/if}
</section>

<style>
  /* The Viewport's frame (.viewport): the body fills, nothing scrolls the whole detail. */
  .remote-detail {
    display: flex;
    flex-direction: column;
    flex: 1;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    overflow: hidden;
  }
  /* The Viewport's header row (.vp-head). */
  .head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 12px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    font-size: var(--fs-meta);
    flex-shrink: 0;
    white-space: nowrap;
    min-width: 0;
  }
  .head.compact {
    flex-wrap: wrap;
  }
  .back {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 4px 9px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .back:hover {
    background: var(--color-hover);
  }
  .desig {
    flex-shrink: 0;
    background: transparent;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: 6px;
    padding: 3px 9px;
    cursor: default;
  }
  .desig:hover {
    color: var(--color-ink);
  }
  .desig:focus-visible {
    color: var(--color-ink);
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .name {
    color: var(--color-ink);
    font-size: var(--fs-base);
    min-width: 0;
    flex: 1 1 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .branch {
    color: var(--color-ink);
    font-size: var(--fs-base);
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22ch;
  }
  .spacer {
    flex: 1;
  }
  .sep {
    color: var(--color-faint);
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    flex-shrink: 0;
  }
  /* The Viewport tab strip's recipe (viewport/ViewportTabBar). */
  .tab {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .tab:hover:not(:disabled) {
    color: var(--color-ink);
  }
  .tab:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .tab.active {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
    background: var(--color-inset);
  }
  .tab:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* The Viewport's body (.vp-body): takes the height, with a floor so a sliver always remains. */
  .body {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 4rem;
    overflow: hidden;
  }
  .term {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
  }
  .term[hidden] {
    display: none;
  }
  /* Stands where the steer bar would (SteerBar .steer-row). */
  .steer-off {
    display: flex;
    padding: 6px 12px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  /* The canonical .gbtn recipe (/design-system); disabled through aria-disabled so it keeps focus
     and hover — and with them the tooltip that says why. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
