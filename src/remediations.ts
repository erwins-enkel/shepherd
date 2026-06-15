import type { DiagnosticsSnapshot } from "./types";

/** hintKey → verbatim shell remediation, keyed by the advice identifier Shepherd
 *  emits. Shipped product code so three consumers share one source of truth: the
 *  onboarding harness, the in-app Fix endpoint, and a future cold-start installer.
 *  The map is keyed by the shipped `hintKey` contract; only deterministically-
 *  fixable deficiencies get entries. Interactive/secret fixes (`gh auth login`,
 *  tailscale login/serve) are intentionally absent — they can't run unattended and
 *  stay on the agent/coaching path. */
// fnm installs node into its own versions dir (NOT on PATH) and exposes it only
// via a shell `eval` an `incus exec sh -c` never runs — so a bare `fnm install`
// leaves the running server still seeing the old node. Reference fnm by absolute
// path and symlink the installed node into ~/.local/bin, which the booted server
// has FIRST on PATH (see probe.ts), so the next probe resolves the new node.
const NODE_INSTALL =
  "curl -fsSL https://fnm.vercel.app/install | bash && " +
  'FNM="$HOME/.local/share/fnm/fnm" && "$FNM" install --lts && ' +
  'mkdir -p "$HOME/.local/bin" && ' +
  'ln -sf "$("$FNM" exec --using=lts-latest node -e \'console.log(process.execPath)\')" ' +
  '"$HOME/.local/bin/node"';
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

/** Hints that have a verbatim install command (valid for a future cold-start
 *  installer) but where running that command never clears the diagnostics check —
 *  so the in-app Fix surface must treat them as guidance-only, not auto-fix.
 *
 *  tailscale is the canonical case: installing the binary leaves `resolveNodeHost`
 *  null until an interactive tailnet login, so the check stays non-ok. This is the
 *  in-app analogue of the harness `detectionOnly` split in scenarios.ts. */
export const GUIDANCE_ONLY: ReadonlySet<string> = new Set(["diagnostics_hint_tailscale_missing"]);

/** Verbatim commands for every non-ok check whose emitted hintKey has a known fix. */
export function remediationsFor(snapshot: DiagnosticsSnapshot): string[] {
  return snapshot.checks
    .filter((c) => c.state !== "ok" && REMEDIATIONS[c.hintKey])
    .map((c) => REMEDIATIONS[c.hintKey]!);
}

/** The auto-fix gate for product surfaces (in-app Fix endpoint): the command for a
 *  hintKey iff one exists AND it actually clears the check when run unattended.
 *  Guidance-only hints (see GUIDANCE_ONLY) return undefined even though they have a
 *  REMEDIATIONS entry. `remediationsFor` stays raw/guidance-agnostic for the harness. */
export function autoFixCommandFor(hintKey: string): string | undefined {
  if (GUIDANCE_ONLY.has(hintKey)) return undefined;
  return REMEDIATIONS[hintKey];
}
