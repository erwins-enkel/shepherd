<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { dialog } from "$lib/a11yDialog";

  type Confirm =
    | { kind: "install"; url: string }
    | { kind: "uninstall"; folder: string; name: string; loaded: boolean };

  let {
    confirm,
    onconfirm,
    onconfirmrestart,
    oncancel,
  }: {
    confirm: Confirm;
    onconfirm: (c: Confirm) => void;
    onconfirmrestart: (c: Extract<Confirm, { kind: "uninstall" }>) => void;
    oncancel: () => void;
  } = $props();

  const isInstall = $derived(confirm.kind === "install");
  const title = $derived(
    isInstall ? m.plugins_confirm_install_title() : m.plugins_confirm_uninstall_title(),
  );
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) oncancel();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    use:dialog={{ onclose: oncancel }}
  >
    <div class="chead">
      <span class="micro">{title}</span>
      <button type="button" class="x" onclick={oncancel} aria-label={m.common_close()}>✕</button>
    </div>

    {#if confirm.kind === "install"}
      <p class="desc">{m.plugins_trust_warning()}</p>
      <code class="cmd wrap">{confirm.url}</code>
    {:else}
      <p class="desc">{m.plugins_confirm_uninstall_body({ name: confirm.name })}</p>
    {/if}

    <div class="actions">
      <button type="button" class="ghost" onclick={oncancel}>{m.common_cancel()}</button>
      {#if confirm.kind === "uninstall" && confirm.loaded}
        <button type="button" class="run danger wide" onclick={() => onconfirmrestart(confirm)}>
          {m.plugins_uninstall_restart_shepherd()}
        </button>
      {/if}
      <button
        type="button"
        class="run"
        class:danger={!isInstall}
        onclick={() => onconfirm(confirm)}
      >
        {isInstall ? m.plugins_install_button() : m.plugins_uninstall()}
      </button>
    </div>
  </div>
</div>

<style>
  /* Canonical scrim (dim + blur) via .overlay. */
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }
  .card {
    width: min(440px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .chead {
    display: flex;
    align-items: center;
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .desc {
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.4;
  }
  .cmd {
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-micro);
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    padding: 3px 6px;
    color: var(--color-ink);
  }
  .cmd.wrap {
    word-break: break-all;
    white-space: pre-wrap;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 2px;
  }
  .ghost,
  .run {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .run {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .run.danger {
    border-color: var(--color-red);
    color: var(--color-red);
  }
  .run.wide {
    max-width: 100%;
    white-space: normal;
    text-align: center;
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      height: 100dvh;
      border: 0;
      overflow-y: auto;
    }
  }
</style>
