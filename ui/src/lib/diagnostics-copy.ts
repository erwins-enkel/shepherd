import type { DiagnosticCheck } from "$lib/types";

/**
 * Which "the fix ran but the check is still not OK" message a diagnostics row should show.
 *
 * Extracted from `SettingsDiagnosePanel` (#1862) purely to have a seam: the selection used to be an
 * inline if/else chain inside the panel's fix handler, and there is no `SettingsDiagnosePanel` test
 * of any kind — so neither this branch nor the pre-existing `host_capacity` one was covered. A pure
 * key-returning function is testable without rendering; the panel just resolves the key.
 *
 * The generic `_code` copy ("Claude Code may need a restart") is folder-trust-specific, so any code
 * fix whose failure mode differs must claim its own key here — otherwise the operator is sent after
 * the wrong thing.
 *
 * The return type is a closed union so the panel's key→message map is exhaustive: adding a branch
 * here without adding its message fails the build. `check:i18n` would NOT catch that — it enforces
 * key PARITY across locales, not key existence.
 */
export type UnresolvedFixKey =
  | "diagnostics_fix_unresolved"
  | "diagnostics_fix_unresolved_code"
  | "diagnostics_fix_unresolved_host_capacity"
  | "diagnostics_fix_unresolved_tmp_inodes";

export function unresolvedFixKey(
  check: Pick<DiagnosticCheck, "fixActionKey"> | undefined,
): UnresolvedFixKey {
  // host_capacity (#1839): a set-property takes effect live but the check re-reads systemd state.
  if (check?.fixActionKey === "diagnostics_fix_action_host_capacity") {
    return "diagnostics_fix_unresolved_host_capacity";
  }
  // tmp_inodes (#1862): staying non-ok after a SUCCESSFUL sweep is the COMMON case, not a failure —
  // the sweep drops the caches Shepherd knows how to reclaim, while the biggest consumers (a forked
  // pnpm store, an abandoned tmp worktree) are not reclaimed yet. Restarting anything would not
  // help, so this must never fall through to the generic code copy.
  if (check?.fixActionKey === "diagnostics_fix_action_tmp_inodes") {
    return "diagnostics_fix_unresolved_tmp_inodes";
  }
  // Any other code fix (fixActionKey, no shell command) — "the command ran" wording is wrong for a
  // config seed, so the code-specific copy applies.
  if (check?.fixActionKey) return "diagnostics_fix_unresolved_code";
  // A shell remediation: the command genuinely ran.
  return "diagnostics_fix_unresolved";
}
