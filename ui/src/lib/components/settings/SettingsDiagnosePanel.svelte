<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { getDiagnostics, fixDiagnostic } from "$lib/api";
  import { type DiagnosticCheck } from "$lib/types";
  import DiagnoseRows from "$lib/components/DiagnoseRows.svelte";
  import PwaInstallRow from "$lib/components/PwaInstallRow.svelte";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";

  let {
    initialDiagnostics = null,
  }: {
    /** Pre-seeded diagnostics checks from the store; loaded fresh on tab open if absent. */
    initialDiagnostics?: DiagnosticCheck[] | null;
  } = $props();

  // Diagnose tab — local checks + re-run state.
  // untrack: initialDiagnostics is intentionally only read once as the seed value.
  let diagChecks = $state<DiagnosticCheck[] | null>(untrack(() => initialDiagnostics ?? null));
  let diagBusy = $state(false);
  let diagError = $state<string | null>(null);

  async function rerunDiagnostics() {
    if (diagBusy) return;
    diagBusy = true;
    diagError = null;
    try {
      const snap = await getDiagnostics(true);
      diagChecks = snap.checks;
    } catch {
      diagError = m.diagnostics_rerun_error();
    } finally {
      diagBusy = false;
    }
  }

  // One-click fix: run the check's remediation server-side, re-render from the
  // re-probed snapshot. Fail closed on two levels: a non-2xx surfaces a 12s,
  // deduped failure toast (and rethrows so DiagnoseRows clears busy); a 2xx whose
  // re-probe shows the target check STILL not ok (the command exited 0 but didn't
  // clear it) surfaces a 12s "unresolved" toast — never a green success.
  async function fixCheck(checkId: string) {
    try {
      const snap = await fixDiagnostic(checkId);
      diagChecks = snap.checks;
      const target = snap.checks.find((c) => c.id === checkId);
      const cleared = target?.state === "ok";
      if (cleared) {
        toasts.info(m.diagnostics_fix_success(), { duration: 3000 });
      } else {
        // A code fix (fixActionKey, no shell command) that didn't clear needs code-appropriate
        // wording — "the command ran" is wrong for a config seed (e.g. claude folder-trust).
        toasts.info(
          target?.fixActionKey
            ? m.diagnostics_fix_unresolved_code()
            : m.diagnostics_fix_unresolved(),
          {
            alert: true,
            key: `diagnose-fix:${checkId}`,
          },
        );
      }
    } catch {
      toasts.info(m.diagnostics_fix_failed(), {
        alert: true,
        key: `diagnose-fix:${checkId}`,
      });
      throw new Error("fix failed");
    }
  }

  onMount(async () => {
    // Seed diagnose tab: if no pre-seeded checks from the store, fetch once on mount.
    if (diagChecks === null) {
      try {
        const snap = await getDiagnostics();
        diagChecks = snap.checks;
      } catch {
        // diagnostics unavailable — panel shows empty state gracefully
      }
    }
  });
</script>

<div class="rc">
  <span class="micro">{m.diagnostics_title()}</span>
  <p class="hint">{m.diagnostics_subtitle()}</p>
</div>
<DiagnoseRows checks={diagChecks} onfix={fixCheck} />
<!-- Client-only: install/standalone state can't come from /api/diagnostics, so this
     row renders independently of the server snapshot's load/fail/empty state. -->
<PwaInstallRow />
{#if diagError}
  <p class="hint err">{diagError}</p>
{/if}
<button type="button" class="run" disabled={diagBusy} onclick={rerunDiagnostics}>
  {diagBusy ? m.common_loading() : m.diagnostics_rerun()}
</button>

<style>
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .err {
    color: var(--color-red);
    font-size: var(--fs-meta);
    margin-top: 2px;
  }
  .run {
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .run:disabled {
    opacity: 0.5;
    cursor: default;
    box-shadow: none;
  }
  .rc {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rc .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }

  @media (max-width: 768px) {
    .run {
      min-height: 44px;
    }
  }
</style>
