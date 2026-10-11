<script lang="ts">
  import type { Leftover } from "#lib/types.js";
  import type { TooltipExplanation } from "#lib/tooltips/content.js";
  import { type MirroredSession, remoteActionMessage } from "#lib/remote-sessions.js";
  import { getLeftovers, interruptSession } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import SteerBar from "../SteerBar.svelte";
  import LeftoverDialog from "../LeftoverDialog.svelte";

  // What the operator can do to a session on a connected machine (#2765): the actions this server
  // forwards to the machine that the detail has a surface for — steer, stop, archive. Each runs on
  // the machine, never here. While the machine is disconnected they stay visible but disabled, with
  // the reason in their tooltip: the server would refuse them without asking the machine.
  let {
    session,
    tip,
    ondecommission = undefined,
    onedit = undefined,
  }: {
    session: MirroredSession;
    tip: TooltipExplanation;
    /** Archive (with the leftover keys to terminate) — the page's undo-windowed decommission. */
    ondecommission?: (id: string, reap?: string[]) => void;
    /** Open the steers editor — the steers themselves are this Shepherd's settings. */
    onedit?: (steerId?: string) => void;
  } = $props();

  const live = $derived(session.connection.state === "connected");
  const machine = $derived(session.host.name);
  const disabledLabels = $derived([
    m.remote_detail_steer(),
    m.remote_detail_stop(),
    m.remote_detail_archive(),
  ]);

  // Archive arms first, like the Viewport's decommission control: one stray click never queues it.
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(armTimer));
  // What archiving would leave running, for the session it was probed for.
  let pending = $state<{ id: string; leftovers: Leftover[] } | null>(null);

  // A lone ESC to the session's pane on its machine. Both outcomes toast, keyed per session, like
  // the card menu's Stop; a failure that never reached the machine says so instead.
  async function stop() {
    const key = `session-interrupt:${session.id}`;
    try {
      await interruptSession(session.id);
      toasts.info(m.cardmenu_stop_toast({ name: session.name }), { key });
    } catch (err) {
      toasts.info(
        remoteActionMessage(err, machine) ?? m.cardmenu_stop_failed({ name: session.name }),
        {
          alert: true,
          key,
        },
      );
    }
  }

  // Same leftover probe as the Viewport's decommission: what would keep running on the machine is
  // offered for termination first. A failed probe never blocks the archive.
  async function archive() {
    if (!armed) {
      armed = true;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => (armed = false), 3000);
      return;
    }
    armed = false;
    clearTimeout(armTimer);
    const id = session.id;
    const { leftovers: found, probesUnavailable } = await getLeftovers(id).catch(() => ({
      leftovers: [] as Leftover[],
      probesUnavailable: false,
    }));
    if (probesUnavailable) {
      toasts.info(m.toast_decom_probes_unavailable(), {
        alert: true,
        key: `decom-no-detection-${id}`,
      });
    }
    if (found.length === 0) ondecommission?.(id);
    else pending = { id, leftovers: found };
  }

  function finish(reap?: string[]) {
    const id = pending?.id;
    pending = null;
    if (id) ondecommission?.(id, reap);
  }
</script>

{#if live}
  <SteerBar
    focusedId={session.id}
    repoPath={session.repoPath}
    agentProvider={session.agentProvider ?? "claude"}
    {onedit}
  />
  <div class="actions" role="group" aria-label={m.remote_detail_actions_aria({ machine })}>
    <button type="button" class="gbtn" onclick={stop}>{m.remote_detail_stop()}</button>
    <button type="button" class="gbtn" class:armed onclick={archive}
      >{armed ? m.viewport_confirm_decommission() : m.remote_detail_archive()}</button
    >
  </div>
{:else}
  <div
    class="actions"
    role="group"
    aria-label={m.remote_detail_actions_unavailable_aria({ machine })}
  >
    {#each disabledLabels as label (label)}
      <button
        type="button"
        class="gbtn"
        aria-disabled="true"
        use:statusTip={{ text: tip, wide: true }}>{label}</button
      >
    {/each}
  </div>
{/if}
{#if pending}
  <LeftoverDialog
    leftovers={pending.leftovers}
    onclose={() => finish()}
    onconfirm={(keys) => finish(keys)}
  />
{/if}

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
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
    cursor: pointer;
  }
  .gbtn:hover:not([aria-disabled="true"]) {
    color: var(--color-ink);
    border-color: var(--color-line-bright);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn.armed {
    color: var(--color-red);
    border-color: var(--color-red);
  }
  .gbtn[aria-disabled="true"] {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
