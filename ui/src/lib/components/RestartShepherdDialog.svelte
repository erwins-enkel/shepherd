<script lang="ts">
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import { triggerRestart } from "$lib/api";

  let { onclose }: { onclose?: () => void } = $props();

  const RESTART_CMD = "systemctl --user restart shepherd";
  /** give systemctl this long to take the old process down before assuming the
   *  down-blink happened between two polls and reloading anyway */
  const DOWN_WINDOW_MS = 30_000;
  /** once the server was seen down, wait this long for it to come back */
  const UP_TIMEOUT_MS = 90_000;
  const POLL_MS = 700;

  let phase = $state<"confirm" | "restarting" | "failed">("confirm");
  let alsoHerdr = $state(false);
  let error = $state<string | null>(null);

  /** Map a stable server error CODE to a message (never render the raw code). */
  function restartErr(code: string): string {
    switch (code) {
      case "not_systemd":
        return m.restart_err_not_systemd();
      case "already_restarting":
        return m.restart_err_already();
      default:
        return m.restart_err_generic();
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Ride through the restart: wait for /api/health to go down, then come back,
   *  then reload so the page reattaches (and picks up fresh assets). A restart
   *  faster than one poll interval never shows a down sample — after
   *  DOWN_WINDOW_MS of continuous "up" we assume the blink was missed and
   *  reload anyway (harmless when wrong). */
  async function rideThrough() {
    const start = Date.now();
    let sawDown = false;
    for (;;) {
      let up: boolean;
      try {
        up = (await fetch("/api/health", { cache: "no-store" })).ok;
      } catch {
        up = false;
      }
      if (!up) sawDown = true;
      if (up && sawDown) break;
      if (up && Date.now() - start > DOWN_WINDOW_MS) break;
      if (sawDown && Date.now() - start > UP_TIMEOUT_MS) {
        phase = "failed";
        return;
      }
      await sleep(POLL_MS);
    }
    location.reload();
  }

  async function confirm() {
    error = null;
    const res = await triggerRestart({ herdr: alsoHerdr });
    if (!res.ok) {
      error = restartErr(res.error);
      return;
    }
    phase = "restarting";
    void rideThrough();
  }

  // the dialog blocks dismissal mid-restart: there is nothing sensible to go
  // back to while the server is down
  const closable = $derived(phase !== "restarting");
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && closable) onclose?.();
  }}
>
  <div
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.restart_title()}
    use:dialog={{ onclose: () => closable && onclose?.() }}
  >
    <div class="chead">
      <span class="micro">{m.restart_title()}</span>
      {#if closable}
        <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
          >✕</button
        >
      {/if}
    </div>

    {#if phase === "confirm"}
      <p class="body">{m.restart_confirm_body()}</p>
      <label class="herdr">
        <input type="checkbox" bind:checked={alsoHerdr} />
        <span>
          <span class="herdr-label">{m.restart_herdr_label()}</span>
          <span class="herdr-note">{m.restart_herdr_note()}</span>
        </span>
      </label>
      {#if error}
        <div class="err" role="alert">
          {error}
          <code class="cmd">{RESTART_CMD}</code>
        </div>
      {/if}
      <div class="actions">
        <button type="button" class="later" onclick={() => onclose?.()}>{m.common_cancel()}</button>
        <button type="button" class="gbtn go" onclick={confirm}>{m.restart_confirm_go()}</button>
      </div>
    {:else if phase === "restarting"}
      <div class="status" aria-live="polite">{m.restart_in_progress()}</div>
    {:else}
      <div class="err" role="alert">
        {m.restart_timeout()}
        <code class="cmd">{RESTART_CMD}</code>
      </div>
      <div class="actions">
        <button type="button" class="later" onclick={() => onclose?.()}>{m.common_close()}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    /* above the Settings modal (20) and the plugin-updates modal (30) — this
       dialog is opened from inside both */
    z-index: 40;
    padding: 16px;
  }
  .card {
    position: relative;
    box-sizing: border-box;
    width: min(440px, 100%);
    display: flex;
    flex-direction: column;
    gap: 14px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    box-shadow: inset 0 0 30px -16px var(--color-blue);
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: 0;
    left: 0;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: 0;
    right: 0;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-base);
  }
  .body {
    margin: 0;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-ink-bright);
  }
  .herdr {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    cursor: pointer;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 10px 12px;
  }
  .herdr input {
    margin-top: 3px;
    accent-color: var(--color-amber);
  }
  .herdr-label {
    display: block;
    font-size: var(--fs-base);
    color: var(--color-ink);
  }
  .herdr-note {
    display: block;
    margin-top: 3px;
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-muted);
  }
  .status {
    font-size: var(--fs-base);
    color: var(--color-amber);
  }
  .err {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-red);
  }
  .cmd {
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-micro);
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    padding: 3px 6px;
    color: var(--color-ink);
    align-self: flex-start;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .later {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 8px 14px;
    cursor: pointer;
    letter-spacing: 0.06em;
  }
  .later:hover {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  /* Base gear button recipe (from /design-system); Restart is the primary action. */
  .gbtn {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    padding: 8px 14px;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    cursor: pointer;
    white-space: nowrap;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn.go {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  @media (max-width: 768px) {
    .later,
    .gbtn {
      min-height: 44px;
      flex: 1;
    }
  }
</style>
