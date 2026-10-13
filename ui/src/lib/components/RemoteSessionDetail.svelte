<script lang="ts">
  import type { Session, TerminalClientInfo } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusLabel } from "#lib/format.js";
  import { isMirrored, qualifiedDesig } from "#lib/remote-sessions.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { placementExplanation, remoteSessionExplanation } from "#lib/tooltips/explanations.js";
  import { placementReason } from "#lib/placement.js";
  import StatusPip from "./StatusPip.svelte";
  import MachineBadge from "./MachineBadge.svelte";
  import RemoteConnectionNote from "./RemoteConnectionNote.svelte";
  import RemoteTerminal from "./RemoteTerminal.svelte";
  import ActivityFeed from "./ActivityFeed.svelte";
  import DiffPanel from "./DiffPanel.svelte";
  import FilesPanel from "./viewport/FilesPanel.svelte";
  import RemoteSessionActions from "./remote-session/RemoteSessionActions.svelte";
  import RemotePreview from "./remote-session/RemotePreview.svelte";
  import { basename } from "./learnings-drawer";

  // The detail of a session mirrored from a connected machine (#2762), mounted in place of the
  // Viewport: what the machine reports, its live terminal (bridged by this server, #2764), and the
  // actions and reads this server forwards to the machine (#2765) — steer, stop, archive, the
  // Activity / Diff / Files tabs, and the Preview the machine serves itself (#2767). Every one of
  // them runs on the machine. While it is disconnected only the terminal tab (which says so) and
  // the disabled, explained actions remain.
  let {
    session,
    nowMs,
    terminalOwners = null,
    previewTick = 0,
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
</script>

<section class="remote-detail" aria-label={qualifiedDesig(session)}>
  {#if onback}
    <button type="button" class="back" aria-label={m.viewport_back_aria()} onclick={onback}
      >{m.viewport_back_button()}</button
    >
  {/if}
  <header class="head">
    <StatusPip status={session.status} ready={session.readyToMerge} tip />
    <div class="ident">
      <div class="desig">{qualifiedDesig(session)}</div>
      <h2 class="name">{session.name}</h2>
    </div>
    {#if session.host}
      <MachineBadge host={session.host} connection={session.connection} {nowMs} />
    {/if}
  </header>
  <RemoteConnectionNote {session} {nowMs} />
  <dl class="facts">
    <dt>{m.remote_detail_status()}</dt>
    <dd>{statusLabel(session.status)}</dd>
    <dt>{m.remote_detail_repo()}</dt>
    <dd title={session.repoPath}>{basename(session.repoPath)}</dd>
    <dt>{m.remote_detail_branch()}</dt>
    <dd>{session.branch ?? session.baseBranch}</dd>
    {#if session.baseCommit}
      <!-- The commit the machine actually started from (#2763): its origin, not this checkout. -->
      <dt>{m.remote_detail_base()}</dt>
      <dd class="base" title={session.baseCommit}>
        {session.baseBranch} @ {session.baseCommit.slice(0, 7)}
      </dd>
    {/if}
    {#if session.launchMetadata?.placement}
      <!-- Why it runs on that machine (#2772), as the Shepherd that chose it recorded. -->
      {@const placement = session.launchMetadata.placement}
      <dt>{m.remote_detail_placement()}</dt>
      <dd class="placement" use:statusTip={{ text: placementExplanation(placement), wide: true }}>
        {placementReason(placement)}
      </dd>
    {/if}
    {#if session.sandboxDegraded}
      <dt>{m.remote_detail_sandbox()}</dt>
      <dd class="degraded" use:statusTip={{ text: m.session_sandbox_degraded_title() }}>
        {m.session_sandbox_degraded_label()}
      </dd>
    {/if}
  </dl>
  <h3 class="label">{m.remote_detail_task()}</h3>
  <p class="prompt">{session.prompt}</p>
  {#if mirrored && tip}
    <!-- Keyed: an Archive armed on one session must never confirm another. -->
    {#key mirrored.id}
      <RemoteSessionActions session={mirrored} {tip} {ondecommission} {onedit} />
    {/key}
  {/if}
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
  <div class="panel" id={panelId} role="tabpanel" aria-labelledby={tabId(tab)}>
    {#if mirrored}
      <!-- Kept mounted (hidden) under the other tabs, so its socket and scrollback survive. -->
      <div class="term" hidden={tab !== "term"}>
        {#key mirrored.id}
          <RemoteTerminal
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
</section>

<style>
  .remote-detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: 16px;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    overflow-y: auto;
  }
  .back {
    align-self: flex-start;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .ident {
    flex: 1;
    min-width: 0;
  }
  .desig {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    color: var(--color-faint);
  }
  .name {
    margin: 0;
    font-size: var(--fs-lg);
    color: var(--color-ink-bright);
    overflow-wrap: anywhere;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 14px;
    margin: 0;
    font-size: var(--fs-meta);
  }
  .facts dt {
    color: var(--color-muted);
  }
  .facts dd {
    margin: 0;
    color: var(--color-ink);
    overflow-wrap: anywhere;
  }
  .facts dd.base {
    font-family: var(--font-mono);
  }
  .facts dd.degraded {
    color: var(--status-warn);
  }
  .label {
    margin: 0;
    font-size: var(--fs-meta);
    font-weight: normal;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .prompt {
    /* the terminal below gets the room; a long task scrolls in place */
    max-height: 7.5em;
    overflow-y: auto;
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--color-ink);
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
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
  .panel {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 240px;
  }
  .term {
    display: flex;
    flex: 1 1 auto;
  }
  .term[hidden] {
    display: none;
  }
</style>
