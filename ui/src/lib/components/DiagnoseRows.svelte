<script lang="ts">
  import type { DiagnosticCheck } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { DOC_LINKS } from "$lib/diagnostics-docs";
  import GlossaryText from "./GlossaryText.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { SvelteSet } from "svelte/reactivity";

  let {
    checks,
    failed = false,
    onretry,
    onfix,
  }: {
    checks: DiagnosticCheck[] | null;
    failed?: boolean;
    onretry?: () => void;
    /** Parent-owned: run the check's remediation, update state, surface failure toast. */
    onfix?: (checkId: string) => Promise<void>;
  } = $props();

  // The check whose Fix button was clicked → renders the confirm modal. null = closed.
  let confirming = $state<DiagnosticCheck | null>(null);
  // ids currently running a fix (button disabled + "Running…"); cleared on settle.
  const busyIds = new SvelteSet<string>();

  // A Fix button shows iff the check is non-ok AND carries a one-click fix — either a
  // shell `remediation` command OR a path-free `fixActionKey` (server-side code fix, e.g.
  // claude folder-trust). Guidance-only rows (tailscale) and ok rows carry neither → no button.
  function fixable(check: DiagnosticCheck): boolean {
    return check.state !== "ok" && (!!check.remediation || !!check.fixActionKey);
  }

  async function runFix() {
    const check = confirming;
    if (!check) return;
    confirming = null;
    busyIds.add(check.id);
    try {
      await onfix?.(check.id);
    } catch {
      // Parent surfaces the failure toast; we only clear busy so the row is retryable.
    } finally {
      busyIds.delete(check.id);
    }
  }

  // Dynamic message key lookup — m is typed as specific functions; cast for dynamic access. The
  // optional params bag lets code-fix messages (e.g. host_capacity #1839) interpolate their concrete
  // values; param-less messages simply ignore the extra arg.
  const msg = m as unknown as Record<string, (p?: Record<string, string>) => string>;

  function label(id: string): string {
    return msg[`diagnostics_label_${id}`]?.() ?? id;
  }

  function hint(hintKey: string): string {
    return msg[hintKey]?.() ?? "";
  }

  // Confirm-modal prose for a `fixActionKey` code fix, interpolating its `fixActionParams` (if any).
  function fixActionText(check: DiagnosticCheck): string {
    return check.fixActionKey ? (msg[check.fixActionKey]?.(check.fixActionParams) ?? "") : "";
  }

  // Per-code-fix confirm chrome (title + run label). The generic *_code strings are folder-trust
  // -specific, so each fixActionKey maps to its own copy — a new code fix must register here.
  const codeFixChrome: Record<string, { title: () => string; run: () => string }> = {
    diagnostics_fix_action_claude_trust: {
      title: m.diagnostics_fix_confirm_title_code,
      run: m.diagnostics_fix_confirm_run_code,
    },
    diagnostics_fix_action_host_capacity: {
      title: m.diagnostics_fix_confirm_title_host_capacity,
      run: m.diagnostics_fix_confirm_run_host_capacity,
    },
    diagnostics_fix_action_tmp_inodes: {
      title: m.diagnostics_fix_confirm_title_tmp_inodes,
      run: m.diagnostics_fix_confirm_run_tmp_inodes,
    },
  };
  function codeFixTitle(check: DiagnosticCheck): string {
    return (
      (check.fixActionKey && codeFixChrome[check.fixActionKey]?.title()) ||
      m.diagnostics_fix_confirm_title_code()
    );
  }
  function codeFixRun(check: DiagnosticCheck): string {
    return (
      (check.fixActionKey && codeFixChrome[check.fixActionKey]?.run()) ||
      m.diagnostics_fix_confirm_run_code()
    );
  }

  function stateWord(state: DiagnosticCheck["state"]): string {
    return msg[`diagnostics_state_${state}`]?.() ?? state;
  }

  // State → color token. Design rule: never --color-green for healthy.
  // ok/optional → --status-done (slate), warning → --status-warn, error → --color-red.
  const stateColor: Record<DiagnosticCheck["state"], string> = {
    ok: "var(--status-done)",
    optional: "var(--status-done)",
    warning: "var(--status-warn)",
    error: "var(--color-red)",
  };

  function isClear(state: DiagnosticCheck["state"]): boolean {
    return state === "ok" || state === "optional";
  }
</script>

<!-- Data wins: once checks arrive (HTTP seed or the WS push) they render even if
     an earlier seed fetch had failed. `failed` only matters while checks are null. -->
{#if checks !== null}
  {#if checks.length === 0}
    <div class="all-ok micro">{m.diagnostics_all_ok()}</div>
  {:else}
    {@const allOk = checks.every((c) => isClear(c.state))}
    {#each checks as check (check.id)}
      <div class="rc">
        <div class="row-head">
          <span class="glyph" style="color:{stateColor[check.state]}" aria-hidden="true">
            {#if check.state === "ok"}✓{:else if check.state === "optional"}–{:else if check.state === "warning"}⚠{:else}✗{/if}
          </span>
          <span class="micro label">{label(check.id)}</span>
          <span class="state-word micro" style="color:{stateColor[check.state]}"
            >{stateWord(check.state)}</span
          >
        </div>
        {#if check.state !== "ok"}
          <p class="hint"><GlossaryText text={hint(check.hintKey)} /></p>
        {/if}
        {#if onfix && fixable(check)}
          <div class="fix-wrap">
            <button
              type="button"
              class="fix micro"
              disabled={busyIds.has(check.id)}
              onclick={() => (confirming = check)}
            >
              {busyIds.has(check.id) ? m.diagnostics_fix_running() : m.diagnostics_fix()}
            </button>
          </div>
        {:else if check.state !== "ok" && DOC_LINKS[check.hintKey]}
          <!-- Guidance-only row (no auto-Fix): external how-to-fix doc-link instead. -->
          <div class="fix-wrap">
            <!-- eslint-disable svelte/no-navigation-without-resolve -- external how-to-fix doc URL -->
            <a
              class="fix doc-link micro"
              href={DOC_LINKS[check.hintKey]}
              target="_blank"
              rel="noopener noreferrer"
            >
              {m.diagnostics_doc_link()}<span aria-hidden="true"> ↗</span>
            </a>
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
          </div>
        {/if}
      </div>
    {/each}
    {#if allOk}
      <div class="all-ok micro">{m.diagnostics_all_ok()}</div>
    {/if}
  {/if}
{:else if failed}
  <div class="load-error">
    <span class="micro">{m.diagnostics_load_error()}</span>
    {#if onretry}
      <button type="button" class="retry micro" onclick={onretry}>{m.diagnostics_rerun()}</button>
    {/if}
  </div>
{:else}
  <div class="all-ok micro">{m.common_loading()}</div>
{/if}

{#if confirming}
  {@const cmd = confirming.remediation}
  <!-- Code fix (claude folder-trust): no shell command — it runs a server-side config
       seed, so the modal uses code-fix chrome (title/run label) and renders the
       `fixActionKey` sentence as PROSE, never the command-styled <code> block. -->
  {@const codeFix = !confirming.remediation && confirming.fixActionKey}
  {@const title = codeFix ? codeFixTitle(confirming) : m.diagnostics_fix_confirm_title()}
  <!-- Blocking confirm: scoped .overlay supplies position/scrim; the global .overlay
       rule (app.css) layers the blur so the diagnose tab recedes behind it. -->
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) confirming = null;
    }}
  >
    <div
      class="card"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      use:dialog={{ onclose: () => (confirming = null) }}
    >
      <span class="micro chead">{title}</span>
      {#if codeFix}
        <p class="desc">{fixActionText(confirming)}</p>
      {:else}
        <p class="desc">{m.diagnostics_fix_confirm_body()}</p>
        <!-- Verbatim command — data, not chrome → never translated. -->
        <code class="cmd">{cmd}</code>
      {/if}
      <div class="actions">
        <button type="button" class="ghost micro" onclick={() => (confirming = null)}>
          {m.common_cancel()}
        </button>
        <button type="button" class="run micro" onclick={runFix}>
          {codeFix ? codeFixRun(confirming) : m.diagnostics_fix_confirm_run()}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .rc {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 0;
    border-bottom: 1px solid var(--color-line);
  }
  .rc:last-of-type {
    border-bottom: none;
  }
  .row-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .glyph {
    font-size: var(--fs-base);
    width: 14px;
    text-align: center;
    flex-shrink: 0;
  }
  .label {
    flex: 1;
    color: var(--color-ink);
  }
  .state-word {
    flex-shrink: 0;
  }
  .hint {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0 0 0 22px;
    line-height: 1.5;
  }
  .all-ok {
    color: var(--color-muted);
    padding: 4px 0;
  }
  .load-error {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
    color: var(--color-red);
  }
  .retry {
    background: none;
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    padding: 4px 10px;
    cursor: pointer;
  }
  .retry:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .fix-wrap {
    margin: 2px 0 0 22px;
  }
  .fix {
    background: none;
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    padding: 4px 10px;
    cursor: pointer;
  }
  .fix:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .fix:disabled {
    opacity: 0.6;
    cursor: default;
  }
  /* Doc-link styled as the fix button (it's a link, not a button). */
  .doc-link {
    display: inline-block;
    text-decoration: none;
  }
  .doc-link:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* Blocking confirm modal — scrim + (global) blur per the design rule. */
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
    display: block;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    padding: 8px 10px;
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    overflow-x: auto;
    white-space: pre;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
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
