<script lang="ts">
  import { firstSafeHttpUrl } from "#lib/url.js";
  import type { PreviewReach } from "#lib/types.js";
  import { type MirroredSession, remoteActionMessage } from "#lib/remote-sessions.js";
  import { getPreviewReach, startPreview, stopPreview } from "#lib/api.js";
  import { remotePreviewUrl } from "#lib/previewUrl.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { m } from "#lib/paraglide/messages.js";

  // The preview of a session on a connected machine (#2767). Its machine starts and stops the dev
  // server and serves the preview from its OWN tailnet host and slot; this server only forwards
  // the requests. So the frame opens the URL the machine answered with — never a port of this
  // server — and a machine that cannot publish previews is explained instead of offered.
  let { session, tick = 0 }: { session: MirroredSession; tick?: number } = $props();

  const machine = $derived(session.host.name);
  // Memoized primitives, so the read below re-runs on a preview change or a reconnect — not on
  // every status frame that re-evaluates the props (a prop read is a getter into the parent).
  const id = $derived(session.id);
  const connectedSince = $derived(session.connection.since);
  const previewTick = $derived(tick);

  let reach = $state<PreviewReach | null>(null);
  let loadError = $state<string | null>(null);
  /** Bumped to re-read on demand; `tick` (the machine's preview frames) and a reconnect also do. */
  let reload = $state(0);

  $effect(() => {
    void previewTick;
    void reload;
    void connectedSince;
    let current = true;
    getPreviewReach(id).then(
      (r) => {
        if (!current) return;
        reach = r;
        loadError = null;
      },
      (err: unknown) => {
        if (!current) return;
        reach = null;
        loadError = remoteActionMessage(err, machine) ?? m.remote_preview_load_failed({ machine });
      },
    );
    return () => {
      current = false;
    };
  });

  const url = $derived(reach?.bound ? remotePreviewUrl(reach.url) : null);
  const host = $derived(url ? new URL(url).host : "");
  // Why a bound preview has no URL — or, while nothing is bound, why starting one would not give
  // one here. A bound slot whose URL this HUD refuses to open reads as unreadable.
  const reason = $derived.by(() => {
    if (!reach || url) return null;
    switch (reach.unavailable) {
      case "not_served":
        return m.remote_preview_not_served({ machine });
      case "serve_denied":
        return m.remote_preview_serve_denied({ machine });
      case "serve_failed":
        return m.remote_preview_serve_failed({ machine });
      case "serve_pending":
        return m.remote_preview_serve_pending({ machine });
      default:
        return reach.bound ? m.remote_preview_load_failed({ machine }) : null;
    }
  });

  // ── start ──
  const PENDING_MS = 60_000;
  let starting = $state(false);
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let startArmed = $state(false);
  let startArmTimer: ReturnType<typeof setTimeout> | undefined;
  let commandOpen = $state(false);
  let commandDraft = $state("");
  // The machine bound it: the start is over.
  $effect(() => {
    if (reach?.bound && starting) {
      starting = false;
      clearTimeout(startTimer);
    }
  });

  function setStarting() {
    starting = true;
    clearTimeout(startTimer);
    startTimer = setTimeout(() => (starting = false), PENDING_MS);
  }

  async function start(command?: string) {
    const key = `remote-preview-start-${session.id}`;
    let result: Awaited<ReturnType<typeof startPreview>>;
    try {
      result = await startPreview(session.id, command);
    } catch (err) {
      toasts.info(remoteActionMessage(err, machine) ?? m.viewport_preview_start_failed(), {
        alert: true,
        key,
      });
      return;
    }
    if ("needCommand" in result) {
      commandDraft = command ?? "";
      commandOpen = true;
      return;
    }
    commandOpen = false;
    if ("alreadyBound" in result || (result.mode === "local" && result.alreadyRunning)) {
      toasts.info(
        "alreadyBound" in result
          ? m.viewport_preview_already_bound()
          : m.viewport_preview_already_running(),
      );
      reload++;
      return;
    }
    if (result.probesUnavailable) {
      toasts.info(m.remote_preview_start_no_detection({ machine }), { alert: true, key });
      return;
    }
    setStarting();
    const name = session.name;
    toasts.info(
      result.mode === "agent_setup"
        ? m.viewport_preview_setup_sent({ name })
        : result.mode === "local"
          ? m.viewport_preview_start_local({ name, command: result.command })
          : m.viewport_preview_start_sent({ name, command: result.command }),
    );
  }

  // A start can steer the agent on the machine (it sets up the preview script once), so a busy
  // agent takes a confirming second click — as the local Start does.
  async function onStart() {
    if (starting) return;
    if (session.status === "running" && !startArmed) {
      startArmed = true;
      clearTimeout(startArmTimer);
      startArmTimer = setTimeout(() => (startArmed = false), 3000);
      return;
    }
    startArmed = false;
    clearTimeout(startArmTimer);
    await start();
  }

  async function submitCommand(e: SubmitEvent) {
    e.preventDefault();
    const command = commandDraft.trim();
    if (command) await start(command);
  }

  // ── stop ──
  let stopArmed = $state(false);
  let stopArmTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = $state(false);

  $effect(() => () => {
    clearTimeout(startTimer);
    clearTimeout(startArmTimer);
    clearTimeout(stopArmTimer);
  });

  async function onStop() {
    if (stopping) return;
    if (!stopArmed) {
      stopArmed = true;
      clearTimeout(stopArmTimer);
      stopArmTimer = setTimeout(() => (stopArmed = false), 3000);
      return;
    }
    stopArmed = false;
    clearTimeout(stopArmTimer);
    stopping = true;
    const key = `remote-preview-stop-${session.id}`;
    try {
      const res = await stopPreview(session.id);
      if ("notBound" in res) reload++;
      else if ("unsupported" in res)
        toasts.info(m.remote_preview_stop_unsupported({ machine }), { alert: true, key });
      else if ("refused" in res)
        toasts.info(m.viewport_preview_stop_refused(), { alert: true, key });
      else if (res.killed === 0)
        toasts.info(m.viewport_preview_stop_nothing(), { alert: true, key });
      // The pane clears once the machine reports its preview gone.
      else toasts.info(m.viewport_preview_stopping());
    } catch (err) {
      toasts.info(remoteActionMessage(err, machine) ?? m.viewport_preview_stop_failed(), {
        alert: true,
        key,
      });
    } finally {
      stopping = false;
    }
  }
</script>

{#snippet stopButton()}
  <button type="button" class="stop" class:armed={stopArmed} disabled={stopping} onclick={onStop}
    >{stopArmed ? m.viewport_preview_stop_confirm() : m.viewport_preview_stop()}</button
  >
{/snippet}

<div class="remote-preview">
  {#if loadError}
    <p class="note">{loadError}</p>
  {:else if !reach}
    <p class="note">{m.common_loading()}</p>
  {:else if url}
    <!-- The machine's preview, on its own origin (its tailnet host and slot) — that distinct
         origin is the trust boundary, as for a local preview; same sandbox as the Viewport's. -->
    <iframe
      class="frame"
      src={url}
      title={m.viewport_preview_tab()}
      referrerpolicy="no-referrer"
      sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
    ></iframe>
    <div class="foot">
      <span class="hint" title={m.remote_preview_served_by({ machine, host })}
        >{m.remote_preview_served_by({ machine, host })}</span
      >
      {@render stopButton()}
      <!-- eslint-disable svelte/no-navigation-without-resolve -- the machine's preview origin, not an app route -->
      <a
        class="open"
        href={firstSafeHttpUrl(url) ?? undefined}
        target="_blank"
        rel="noopener noreferrer">{m.viewport_preview_open_new_tab()}</a
      >
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    </div>
  {:else}
    {#if reason}
      <p class="note warn">{reason}</p>
    {/if}
    {#if reach.bound}
      <div class="row">{@render stopButton()}</div>
    {:else}
      <p class="note">{m.remote_preview_none({ machine })}</p>
      <div class="row">
        <button
          type="button"
          class="gbtn"
          class:armed={startArmed}
          disabled={starting}
          onclick={onStart}
          >{startArmed
            ? m.viewport_preview_start_confirm_working()
            : m.viewport_preview_start()}</button
        >
        {#if starting}
          <span class="note">{m.remote_preview_starting({ machine })}</span>
        {/if}
      </div>
      {#if commandOpen}
        <form class="command" onsubmit={submitCommand}>
          <label class="command-label" for="remote-preview-cmd-{session.id}"
            >{m.viewport_preview_command_prompt()}</label
          >
          <input
            id="remote-preview-cmd-{session.id}"
            class="command-input"
            type="text"
            bind:value={commandDraft}
            placeholder={m.viewport_preview_command_placeholder()}
          />
          <button type="submit" class="gbtn">{m.viewport_preview_command_send()}</button>
        </form>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .remote-preview {
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1 1 auto;
    min-height: 0;
  }
  .note {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }
  .note.warn {
    color: var(--color-amber);
  }
  /* The detail scrolls, so the frame takes a fixed share of the viewport instead of "the rest". */
  .frame {
    flex: 1 1 auto;
    width: 100%;
    min-height: 60vh;
    border: 1px solid var(--color-line);
    background: var(--color-bg);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .hint {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .open {
    margin-left: auto;
    flex: none;
    color: var(--color-blue);
    text-decoration: none;
    letter-spacing: 0.04em;
  }
  .open:hover,
  .open:focus-visible {
    text-decoration: underline;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  /* The canonical .gbtn recipe (/design-system). */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    color: var(--color-ink);
    border-color: var(--color-line-bright);
  }
  .gbtn:focus-visible,
  .stop:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn.armed {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .gbtn:disabled,
  .stop:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* The Viewport's stop-preview treatment: faint until hovered or armed, then danger red. */
  .stop {
    flex: none;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    padding: 2px 7px;
    cursor: pointer;
  }
  .stop:hover:not(:disabled) {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 45%, transparent);
  }
  .stop.armed {
    color: var(--color-red);
    border-color: var(--color-red);
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
  }
  .command {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .command-label {
    flex-basis: 100%;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .command-input {
    flex: 1 1 16em;
    min-width: 0;
    background: var(--color-bg);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 3px 7px;
    outline: none;
  }
  .command-input:focus {
    border-color: var(--color-blue);
  }
</style>
