<script lang="ts">
  import { onMount } from "svelte";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import { diagnoseEpic, importEpic } from "$lib/api";
  import type { EpicDiagnosis, EpicDiagnosisFinding, EpicDiagnosisSeverity } from "$lib/types";
  import { toasts } from "$lib/toasts.svelte";
  import { DOCS_URL } from "$lib/build-info";

  let { repoPath, parent, onclose }: { repoPath: string; parent: number; onclose: () => void } =
    $props();

  const GUIDE_URL = `${DOCS_URL}authoring-epics/`;

  let result = $state<"loading" | "error" | EpicDiagnosis>("loading");
  // Two-step import confirm: idle → confirming → importing.
  let importPhase = $state<"idle" | "confirming" | "importing">("idle");

  async function runDiagnosis() {
    result = "loading";
    try {
      result = await diagnoseEpic(repoPath, parent);
    } catch {
      result = "error";
    }
  }

  onMount(runDiagnosis);

  // Findings carrying an import remediation — collapsed to a single shared control.
  const importable = $derived(
    typeof result === "object" && result.findings.some((f) => f.action === "import-structure"),
  );

  async function confirmImport() {
    importPhase = "importing";
    try {
      await importEpic(repoPath, parent);
      toasts.info(m.epic_diag_import_success(), { key: "epic-diag-import-ok" });
      importPhase = "idle";
      await runDiagnosis();
    } catch {
      toasts.info(m.epic_import_failed(), {
        sticky: true,
        alert: true,
        key: "epic-diag-import-fail",
      });
      importPhase = "confirming";
    }
  }

  function sourceLine(source: EpicDiagnosis["source"]): string {
    if (source === "native") return m.epic_diag_source_native();
    if (source === "markdown") return m.epic_diag_source_markdown();
    return m.epic_diag_source_none();
  }

  function severityWord(sev: EpicDiagnosisSeverity): string {
    if (sev === "error") return m.epic_diag_sev_error();
    if (sev === "warning") return m.epic_diag_sev_warning();
    return m.epic_diag_sev_info();
  }

  function severityGlyph(sev: EpicDiagnosisSeverity): string {
    if (sev === "error") return "✕";
    if (sev === "warning") return "▲";
    return "ℹ";
  }

  // id → localized { title, body }; unknown ids render nothing (forward-compatible).
  function renderFinding(f: EpicDiagnosisFinding): { title: string; body: string } | null {
    switch (f.id) {
      case "no-children":
        return { title: m.epic_diag_no_children_title(), body: m.epic_diag_no_children_body() };
      case "markdown-source":
        return {
          title: m.epic_diag_markdown_source_title(),
          body: m.epic_diag_markdown_source_body(),
        };
      case "truncated-open-list":
        return { title: m.epic_diag_truncated_title(), body: m.epic_diag_truncated_body() };
      case "all-parallel":
        return {
          title: m.epic_diag_all_parallel_title(),
          body: m.epic_diag_all_parallel_body({ count: Number(f.params?.count ?? 0) }),
        };
      case "self-dependency":
        return {
          title: m.epic_diag_self_dep_title(),
          body: m.epic_diag_self_dep_body({ child: Number(f.params?.child ?? 0) }),
        };
      case "outside-epic-dependency":
        return {
          title: m.epic_diag_outside_dep_title(),
          body: m.epic_diag_outside_dep_body({
            child: Number(f.params?.child ?? 0),
            blocker: Number(f.params?.blocker ?? 0),
          }),
        };
      case "native-body-disagree":
        return {
          title: m.epic_diag_native_body_disagree_title(),
          body: m.epic_diag_native_body_disagree_body({
            onlyInBody: String(f.params?.onlyInBody ?? ""),
            onlyInNative: String(f.params?.onlyInNative ?? ""),
          }),
        };
      default:
        return null;
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
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.epic_diag_title()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.epic_diag_title()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    <div class="content">
      {#if result === "loading"}
        <div class="status" aria-live="polite">{m.epic_diag_loading()}</div>
      {:else if result === "error"}
        <div class="err" role="alert">{m.epic_diag_error()}</div>
        <div class="actions">
          <button type="button" class="gbtn" onclick={runDiagnosis}>{m.common_retry()}</button>
        </div>
      {:else}
        <p class="source">{sourceLine(result.source)}</p>

        {#if result.findings.length === 0 && result.recognized}
          <p class="clean">{m.epic_diag_clean()}</p>
        {/if}

        <ul class="findings">
          {#each result.findings as f (f.id + JSON.stringify(f.params ?? {}))}
            {@const r = renderFinding(f)}
            {#if r}
              <li class="finding sev-{f.severity}">
                <div class="finding-head">
                  <span class="glyph" aria-hidden="true">{severityGlyph(f.severity)}</span>
                  <span class="sev-word">{severityWord(f.severity)}</span>
                  <span class="finding-title">{r.title}</span>
                </div>
                <p class="finding-body">{r.body}</p>
              </li>
            {/if}
          {/each}
        </ul>

        {#if importable}
          <div class="import-zone">
            {#if importPhase === "idle"}
              <button type="button" class="gbtn" onclick={() => (importPhase = "confirming")}>
                {m.epic_diag_import()}
              </button>
            {:else}
              <p class="import-hint">{m.epic_diag_import_hint()}</p>
              <div class="actions">
                <button
                  type="button"
                  class="gbtn"
                  disabled={importPhase === "importing"}
                  onclick={() => (importPhase = "idle")}
                >
                  {m.common_cancel()}
                </button>
                <button
                  type="button"
                  class="gbtn primary"
                  disabled={importPhase === "importing"}
                  onclick={confirmImport}
                >
                  {m.epic_diag_import_confirm()}
                </button>
              </div>
            {/if}
          </div>
        {/if}

        {#if result.additionalWarnings.length}
          <div class="extra-warnings">
            <div class="ew-head">{m.epic_diag_other_warnings()}</div>
            <ul class="ew-list">
              {#each result.additionalWarnings as w (w)}
                <li>{w}</li>
              {/each}
            </ul>
          </div>
        {/if}

        <div class="footer">
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external docs URL -->
          <a class="guide" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
            {m.epic_diag_guide_link()}
          </a>
        </div>
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
    z-index: 40;
    padding: 16px;
  }
  .card {
    position: relative;
    box-sizing: border-box;
    width: min(520px, 100%);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    box-shadow: inset 0 0 30px -16px var(--color-blue);
    font-family: var(--font-mono);
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
    flex-shrink: 0;
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
  .x:hover {
    color: var(--color-amber);
  }

  .content {
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .status {
    font-size: var(--fs-base);
    color: var(--color-amber);
  }
  .err {
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-red);
  }

  .source {
    margin: 0;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .clean {
    margin: 0;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-green);
  }

  .findings {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .finding {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--color-line);
    border-left-width: 3px;
    padding: 8px 10px;
    background: var(--color-inset);
  }
  .finding-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .glyph {
    flex-shrink: 0;
  }
  .sev-word {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .finding-title {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .finding-body {
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }

  /* Severity toning — tokens only. info=blue, warning=amber, error=red. */
  .sev-info {
    border-left-color: var(--color-blue);
  }
  .sev-info .glyph,
  .sev-info .sev-word {
    color: var(--color-blue);
  }
  .sev-warning {
    border-left-color: var(--color-amber);
  }
  .sev-warning .glyph,
  .sev-warning .sev-word {
    color: var(--color-amber);
  }
  .sev-error {
    border-left-color: var(--color-red);
  }
  .sev-error .glyph,
  .sev-error .sev-word {
    color: var(--color-red);
  }

  .import-zone {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border: 1px solid var(--color-line);
    padding: 10px;
    background: var(--color-panel);
  }
  .import-hint {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }

  .extra-warnings {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ew-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-amber);
  }
  .ew-list {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }

  .footer {
    padding-top: 2px;
  }
  .guide {
    color: var(--color-blue);
    font-size: var(--fs-micro);
    text-decoration: none;
  }
  .guide:hover {
    text-decoration: underline;
  }

  /* Canonical .gbtn recipe from /design-system. Scoped-duplicated because Svelte
     scopes styles per-component and there is no global .gbtn in app.css. */
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
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* Modal action a11y floor: 44×44px tap targets on mobile. */
  @media (max-width: 768px) {
    .gbtn {
      min-height: 44px;
      padding: 2px 14px;
    }
  }
</style>
