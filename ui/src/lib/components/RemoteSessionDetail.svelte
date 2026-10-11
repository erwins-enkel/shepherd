<script lang="ts">
  import type { Session, TerminalClientInfo } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusLabel } from "#lib/format.js";
  import { isMirrored, qualifiedDesig } from "#lib/remote-sessions.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { remoteSessionExplanation } from "#lib/tooltips/explanations.js";
  import StatusPip from "./StatusPip.svelte";
  import MachineBadge from "./MachineBadge.svelte";
  import RemoteConnectionNote from "./RemoteConnectionNote.svelte";
  import RemoteTerminal from "./RemoteTerminal.svelte";
  import { basename } from "./learnings-drawer";

  // The detail of a session mirrored from a connected machine (#2762), mounted in place of the
  // Viewport: what the machine reports, and its live terminal, which this server bridges to the
  // machine (#2764). Nothing reads or acts on this machine — no per-session reads. Its other
  // actions are shown disabled, each explaining why.
  let {
    session,
    nowMs,
    terminalOwners = null,
    onback = undefined,
  }: {
    session: Session;
    nowMs: number;
    /** Who holds each terminal, the machines' included; null until the event stream reports. */
    terminalOwners?: Record<string, TerminalClientInfo> | null;
    onback?: () => void;
  } = $props();

  const mirrored = $derived(isMirrored(session) ? session : null);
  const tip = $derived(
    session.host && session.connection
      ? remoteSessionExplanation(session.host, session.connection, nowMs)
      : null,
  );
  const actions = $derived([
    m.remote_detail_steer(),
    m.remote_detail_stop(),
    m.remote_detail_archive(),
  ]);
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
    <MachineBadge {session} {nowMs} />
  </header>
  <RemoteConnectionNote {session} {nowMs} />
  <dl class="facts">
    <dt>{m.remote_detail_status()}</dt>
    <dd>{statusLabel(session.status)}</dd>
    <dt>{m.remote_detail_repo()}</dt>
    <dd title={session.repoPath}>{basename(session.repoPath)}</dd>
    <dt>{m.remote_detail_branch()}</dt>
    <dd>{session.branch ?? session.baseBranch}</dd>
  </dl>
  <h3 class="label">{m.remote_detail_task()}</h3>
  <p class="prompt">{session.prompt}</p>
  <div class="actions" role="group" aria-label={m.remote_detail_actions_aria()}>
    {#each actions as label (label)}
      <button
        type="button"
        class="gbtn"
        aria-disabled="true"
        use:statusTip={tip ? { text: tip, wide: true } : null}>{label}</button
      >
    {/each}
  </div>
  {#if mirrored}
    {#key mirrored.id}
      <RemoteTerminal
        session={mirrored}
        owner={terminalOwners === null ? undefined : (terminalOwners[mirrored.id] ?? null)}
      />
    {/key}
  {/if}
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
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  /* The canonical .gbtn recipe (/design-system), disabled through aria-disabled so it keeps
     focus and hover — and with them the tooltip that says why. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn[aria-disabled="true"] {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
