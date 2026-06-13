import type { DiagnosticsSnapshot } from "../../src/types";

/** hintKey → verbatim shell remediation, keyed by the advice identifier Shepherd
 *  emits. Lives in the HARNESS (not the diagnostics payload) so the shipped
 *  DiagnosticCheck contract is unchanged. Only keys whose canonical fix is a
 *  single non-interactive command appear; prose-only coaching (interactive
 *  `gh auth login`, tailscale serve setup) is intentionally absent and stays on
 *  the agent path. Every `coaching: "structured"` scenario must have a matching
 *  entry here — otherwise it silently falls through to the LLM agent path,
 *  breaking the deterministic LLM-free gate guarantee. */
const NODE_INSTALL = "curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts";
const HERDR_INSTALL = "curl -fsSL https://herdr.dev/install.sh | bash";

export const REMEDIATIONS: Record<string, string> = {
  diagnostics_hint_bun_missing: "curl -fsSL https://bun.sh/install | bash",
  diagnostics_hint_node_missing: NODE_INSTALL,
  diagnostics_hint_node_outdated: NODE_INSTALL,
  diagnostics_hint_herdr_missing: HERDR_INSTALL,
  diagnostics_hint_herdr_outdated: HERDR_INSTALL,
  diagnostics_hint_claude_missing: "curl -fsSL https://claude.ai/install.sh | bash",
  diagnostics_hint_tailscale_missing: "curl -fsSL https://tailscale.com/install.sh | sh",
};

/** Verbatim commands for every non-ok check whose emitted hintKey has a known fix. */
export function remediationsFor(snapshot: DiagnosticsSnapshot): string[] {
  return snapshot.checks
    .filter((c) => c.state !== "ok" && REMEDIATIONS[c.hintKey])
    .map((c) => REMEDIATIONS[c.hintKey]!);
}
