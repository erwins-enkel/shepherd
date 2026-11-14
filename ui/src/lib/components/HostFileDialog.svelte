<script lang="ts">
  import MarkdownBody from "#lib/components/MarkdownBody.svelte";
  import { getHostFile } from "#lib/api.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { m } from "#lib/paraglide/messages.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import type { HostFileText } from "#lib/types.js";

  // Read-only view of a host file the session reported outside its worktree/scratchpad (#4017).
  // The server decides what may be shown (src/host-file.ts); this only renders the text: Markdown
  // through MarkdownBody (without onOpenFile, so links inside stay copy-only), anything else as-is.
  let { sessionId, path, onclose }: { sessionId: string; path: string; onclose: () => void } =
    $props();

  let file = $state<HostFileText | null | undefined>(undefined);
  const name = $derived(path.split("/").pop() || path);
  const markdown = $derived(/\.(md|markdown)$/i.test(path));

  $effect(() => {
    const id = sessionId;
    const p = path;
    let alive = true;
    file = undefined;
    getHostFile(id, p)
      .catch(() => null)
      .then((r) => alive && (file = r));
    return () => {
      alive = false;
    };
  });

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(path);
      toasts.info(m.markdown_host_path_copied());
    } catch {
      toasts.info(m.clipboard_copy_failed(), { alert: true });
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.hostfile_title()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <div class="who">
        <span class="micro">{m.hostfile_title()} · {m.hostfile_readonly()}</span>
        <span class="name">{name}</span>
        <span class="path">{path}</span>
      </div>
      <button
        type="button"
        class="icon-btn"
        onclick={copyPath}
        title={m.markdown_copy_host_path()}
        aria-label={m.markdown_copy_host_path()}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><rect x="9" y="9" width="13" height="13" rx="2" /><path
            d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
          /></svg
        >
      </button>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    <div class="body">
      {#if file === undefined}
        <p class="note">{m.hostfile_loading()}</p>
      {:else if file === null}
        <p class="note" role="status">{m.hostfile_unavailable()}</p>
      {:else if markdown}
        <MarkdownBody source={file.text} copyCode />
      {:else}
        <pre class="text">{file.text}</pre>
      {/if}
    </div>
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
    z-index: 20;
  }
  .card {
    width: min(860px, 94vw);
    max-height: 88vh;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
  }
  .chead {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-line);
  }
  .who {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .name {
    color: var(--color-ink);
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  .path {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .body {
    overflow: auto;
    padding: 12px 16px 16px;
    min-height: 0;
  }
  .note {
    color: var(--color-muted);
    margin: 0;
  }
  .text {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--color-ink);
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      max-height: none;
      height: 100dvh;
      padding-top: env(safe-area-inset-top);
      padding-right: env(safe-area-inset-right);
      padding-bottom: env(safe-area-inset-bottom);
      padding-left: env(safe-area-inset-left);
      border: 0;
    }
  }
</style>
