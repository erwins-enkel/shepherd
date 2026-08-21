import type { PwaRowState } from "$lib/pwa";

/** hintKey → external "how to fix" doc URL, for guidance-only DIAGNOSE rows that
 *  get no auto-Fix button (the fix needs a human secret). Pure presentational
 *  chrome — kept UI-side, NOT in the /api/diagnostics payload. */
export const DOC_LINKS: Record<string, string> = {
  diagnostics_hint_herdr_offline: "https://herdr.dev",
  diagnostics_hint_gh_missing: "https://github.com/cli/cli#installation",
  diagnostics_hint_gh_not_authenticated: "https://cli.github.com/manual/gh_auth_login",
  diagnostics_hint_tailscale_missing: "https://tailscale.com/kb/1347/installation",
  diagnostics_hint_tailscale_not_serving: "https://tailscale.com/kb/1242/tailscale-serve",
  // The --operator flag (the fix for a denied serve config) is documented on the
  // `tailscale set` CLI page, not the serve page.
  diagnostics_hint_tailscale_serve_denied: "https://tailscale.com/kb/1080/cli#set",
  // Shepherd's own operating guide (resource-guardrails section) carries a
  // copy-paste `set-property` remedy — far more actionable than the raw systemd
  // man page. Both host_capacity non-ok states point here. Anchor slug is coupled
  // to the operating.md heading by test/host-capacity-doc-anchor.test.ts.
  diagnostics_hint_host_capacity_unbounded:
    "https://docs.shepherd.run/operating/#host-tuning--resource-guardrails",
  // Shepherd is bounded but herdr (which runs agent sessions) isn't — same remedy section. Present so
  // the sub-MIN_TUNABLE herdr-gap row (no one-click Fix) still links an actionable how-to (#1839).
  diagnostics_hint_host_capacity_herdr_unbounded:
    "https://docs.shepherd.run/operating/#host-tuning--resource-guardrails",
  diagnostics_hint_host_capacity_pressure:
    "https://docs.shepherd.run/operating/#host-tuning--resource-guardrails",
  // claude_install (#2052) is guidance-only on purpose — Shepherd never repoints or deletes a
  // claude install — so every non-ok state links the operating guide's mise section instead of
  // offering a Fix button. Anchor coupled to the heading by test/host-capacity-doc-anchor.test.ts.
  diagnostics_hint_claude_install_diverged:
    "https://docs.shepherd.run/operating/#the-claude-code-install-row",
  diagnostics_hint_claude_install_native_on_path:
    "https://docs.shepherd.run/operating/#the-claude-code-install-row",
  diagnostics_hint_claude_install_native_residue:
    "https://docs.shepherd.run/operating/#the-claude-code-install-row",
};

/** Per-state PWA-install help URL; undefined for `optional`/`installed`
 *  (nothing is wrong → no link). */
export function pwaDocLink(state: PwaRowState): string | undefined {
  if (state === "ios")
    return "https://support.apple.com/guide/iphone/bookmark-favorite-webpages-iph42ab2f3a7/ios";
  if (state === "android") return "https://support.google.com/chrome/answer/9658361";
  return undefined;
}
