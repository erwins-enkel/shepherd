<script lang="ts">
  import type { Leftover } from "#lib/types.js";
  import type { TooltipExplanation } from "#lib/tooltips/content.js";
  import { type MirroredSession, remoteActionMessage } from "#lib/remote-sessions.js";
  import { getLeftovers, interruptSession } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import LeftoverDialog from "../LeftoverDialog.svelte";

  // The header controls for a session on a connected machine (#2765), where the Viewport keeps its
  // own: stop, and archive as the quiet ✕. Each is forwarded to the machine and runs there, never
  // here. While the machine is disconnected they stay visible but disabled, with the reason in
  // their tooltip: the server would refuse them without asking the machine. Steering is the steer
  // bar's, under the terminal.
  let {
    session,
    tip,
    ondecommission = undefined,
  }: {
    session: MirroredSession;
    tip: TooltipExplanation;
    /** Archive (with the leftover keys to terminate) — the page's undo-windowed decommission. */
    ondecommission?: (id: string, reap?: string[]) => void;
  } = $props();

  const live = $derived(session.connection.state === "connected");
  const machine = $derived(session.host.name);

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

{#snippet cross()}
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg
  >
{/snippet}
{#if live}
  <div class="actions" role="group" aria-label={m.remote_detail_actions_live_aria({ machine })}>
    <button type="button" class="stop" onclick={stop}>{m.remote_detail_stop()}</button>
    <button
      type="button"
      class="decom icon-btn"
      class:armed
      onclick={archive}
      title={armed ? m.viewport_confirm_decommission() : m.remote_detail_archive()}
      aria-label={armed ? m.viewport_confirm_decommission() : m.remote_detail_archive()}
      >{@render cross()}</button
    >
  </div>
{:else}
  <div
    class="actions"
    role="group"
    aria-label={m.remote_detail_actions_unavailable_aria({ machine })}
  >
    <button
      type="button"
      class="stop"
      aria-disabled="true"
      use:statusTip={{ text: tip, wide: true }}>{m.remote_detail_stop()}</button
    >
    <button
      type="button"
      class="decom icon-btn"
      aria-disabled="true"
      aria-label={m.remote_detail_archive()}
      use:statusTip={{ text: tip, wide: true }}>{@render cross()}</button
    >
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
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  /* The Viewport header's quiet text pill (ViewportHeaderActions .decom:not(.icon-btn)). */
  .stop {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-faint);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 7px;
    cursor: pointer;
  }
  .stop:hover:not([aria-disabled="true"]) {
    color: var(--color-ink);
    border-color: var(--color-line-bright);
  }
  .stop:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* The Viewport's quiet ✕ (ViewportHeaderActions .decom.quiet.icon-btn): faint at rest, red on
     hover, a solid red square while armed. */
  .decom:hover:not([aria-disabled="true"]) {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 45%, transparent);
  }
  .decom.armed {
    background: var(--color-red);
    border-color: var(--color-red);
    color: var(--color-bg);
  }
  /* Disabled through aria-disabled so they keep focus and hover — and with them the tooltip that
     says why. */
  [aria-disabled="true"] {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
