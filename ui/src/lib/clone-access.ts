// What the clone dialog shows after a refused GitHub clone, derived from the server's
// access diagnosis (GET /api/github/access). The list comes from gh, the clone from git's
// own credential helper — these name which side failed and what can fix it.
import type { GithubAccess, GitHelperKind } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";

/**
 * - `mismatch`: gh may read the repo, git's credential may not — the fixable case.
 * - `denied`:   gh is signed in and can't see it either — nothing local will help.
 * - `nogh`:     gh is missing or signed out, so whether it could help is unknown.
 * - `gherror`:  the gh check itself failed (network, rate limit, …).
 */
export type AccessCase = "mismatch" | "denied" | "nogh" | "gherror";

export function accessCase(a: GithubAccess): AccessCase {
  if (a.gh.state === "missing" || a.gh.state === "logged_out") return "nogh";
  if (a.gh.state === "error") return "gherror";
  return a.gh.pull ? "mismatch" : "denied";
}

/** Pointing git at gh can only fix an https clone whose git isn't already on gh. */
export function ghFixApplies(a: GithubAccess): boolean {
  return a.protocol === "https" && !a.git.usesGh;
}

/** Human name for the credential git authenticates with. An ssh clone uses the SSH key,
 *  whatever helper is configured for https. */
export function helperLabel(kind: GitHelperKind, protocol: "https" | "ssh" = "https"): string {
  if (protocol === "ssh") return m.cloneaccess_helper_ssh();
  switch (kind) {
    case "store":
      return m.cloneaccess_helper_store();
    case "cache":
      return m.cloneaccess_helper_cache();
    case "osxkeychain":
      return m.cloneaccess_helper_osxkeychain();
    case "manager":
      return m.cloneaccess_helper_manager();
    case "libsecret":
      return m.cloneaccess_helper_libsecret();
    case "wincred":
      return m.cloneaccess_helper_wincred();
    case "gh":
      return m.cloneaccess_helper_gh();
    case "none":
      return m.cloneaccess_helper_none();
    default:
      return m.cloneaccess_helper_other();
  }
}

/** Heuristic gate for "worth asking the server": the server does the real parsing. */
export function looksLikeGithubUrl(url: string): boolean {
  return /(^|[/@])github\.com[:/]/i.test(url);
}

/** Exactly what `gh auth setup-git` writes to the global git config (measured against
 *  gh 2.93), shown verbatim before the operator confirms. Config syntax, not prose. */
export const GH_SETUP_CONFIG = `[credential "https://github.com"]
    helper =
    helper = !gh auth git-credential
[credential "https://gist.github.com"]
    helper =
    helper = !gh auth git-credential`;

/** The undo, verbatim. */
export const GH_SETUP_UNDO = `git config --global --unset-all credential.https://github.com.helper
git config --global --unset-all credential.https://gist.github.com.helper`;

export const TOKEN_SETTINGS_URL = "https://github.com/settings/personal-access-tokens";
