/**
 * Why a GitHub clone was refused, and the one-click fix for the common case.
 *
 * The clone dialog lists repos through `gh` (its OAuth token), but `git clone` authenticates
 * through git's own credential helper — often a narrower token (a fine-grained PAT in
 * `~/.git-credentials`) that doesn't cover every repo `gh` can see. The two never talk to each
 * other, so the list happily offers repos the clone then 403s on. These helpers name both sides
 * for one repo, and can point git at `gh` (`gh auth setup-git`) when the operator chooses to.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeDetail } from "./forge/gh-attempt";

/** Runs one `gh`/`git` invocation and resolves with its stdout. Injectable for tests. */
export type CmdRunner = (args: string[]) => Promise<string>;

export type GithubAccessRunners = { gh?: CmdRunner; git?: CmdRunner };

const execFileAsync = promisify(execFile);

const defaultGh: CmdRunner = async (args) => {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 1024 * 1024, timeout: 30_000 });
  return stdout.toString();
};

// cwd "/" keeps a repo-local config (e.g. of the checkout the server runs from) out of the
// answer — `git clone` into a new directory doesn't read it either.
const defaultGit: CmdRunner = async (args) => {
  const { stdout } = await execFileAsync("git", args, { cwd: "/", timeout: 5_000 });
  return stdout.toString();
};

/** Clone URL → `owner/repo` on github.com, and whether git will talk https or ssh to it.
 *  Anything that isn't exactly a github.com repo root is null. */
export function githubSlugFromUrl(url: string): { slug: string; protocol: "https" | "ssh" } | null {
  const part = "[A-Za-z0-9_.-]+";
  const tail = `(${part})/(${part}?)(?:\\.git)?/?$`;
  const https = new RegExp(`^https?://(?:[^@/]+@)?github\\.com/${tail}`, "i").exec(url);
  const ssh =
    new RegExp(`^(?:[^@/:]+@)?github\\.com:${tail}`, "i").exec(url) ??
    new RegExp(`^ssh://(?:[^@/]+@)?github\\.com(?::\\d+)?/${tail}`, "i").exec(url);
  const m = https ?? ssh;
  if (!m || !m[1] || !m[2]) return null;
  return { slug: `${m[1]}/${m[2]}`, protocol: https ? "https" : "ssh" };
}

/** Which kind of credential helper git uses. Deliberately a closed set: a helper value can be
 *  an inline shell script with a secret in it, so its text never leaves the server. */
export type GitHelperKind =
  "gh" | "store" | "cache" | "osxkeychain" | "manager" | "libsecret" | "wincred" | "other" | "none";

const KNOWN_HELPERS: Record<string, GitHelperKind> = {
  store: "store",
  cache: "cache",
  osxkeychain: "osxkeychain",
  manager: "manager",
  "manager-core": "manager",
  libsecret: "libsecret",
  wincred: "wincred",
};

export function gitHelperKind(helper: string | null): GitHelperKind {
  const h = helper?.trim() ?? "";
  if (!h) return "none";
  if (/\bgh(?:\.exe)?\s+auth\s+git-credential\b/.test(h)) return "gh";
  if (h.startsWith("!")) return "other";
  const first = (h.split(/\s+/)[0] ?? "").split(/[\\/]/).pop() ?? "";
  return KNOWN_HELPERS[first.replace(/^git-credential-/, "")] ?? "other";
}

export type GitHelperInfo = { kind: GitHelperKind; usesGh: boolean };

/** The credential helper git applies to https://github.com (exit 1 = none configured). */
export async function gitCredentialHelper(git: CmdRunner = defaultGit): Promise<GitHelperInfo> {
  let raw: string | null;
  try {
    raw = await git(["config", "--get-urlmatch", "credential.helper", "https://github.com"]);
  } catch {
    raw = null;
  }
  const kind = gitHelperKind(raw);
  return { kind, usesGh: kind === "gh" };
}

export type GhAccess =
  | { state: "ok"; login: string; pull: boolean; push: boolean }
  | { state: "missing" }
  | { state: "logged_out" }
  | { state: "error"; detail: string };

export type GithubAccess = { repo: string; git: GitHelperInfo; gh: GhAccess };

function stderrOf(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown } | null;
  const s = err?.stderr ? String(err.stderr) : "";
  return s.trim() || (typeof err?.message === "string" ? err.message : String(e));
}

/** gh missing / logged out / something else. `gh` exits 4 when it needs `gh auth login`. */
function ghFailure(e: unknown): "missing" | "logged_out" | "error" {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return "missing";
  if (code === 4 || /gh auth login/.test(stderrOf(e))) return "logged_out";
  return "error";
}

/** Whether `gh` is signed in and may read / push `slug`. 404 (invisible) and 403 (e.g. an
 *  org's SSO wall) both mean "no access"; anything else is an error worth showing. */
export async function diagnoseGithubAccess(
  slug: string,
  runners: GithubAccessRunners = {},
): Promise<GithubAccess> {
  const gh = runners.gh ?? defaultGh;
  const git = await gitCredentialHelper(runners.git);
  const result = (access: GhAccess): GithubAccess => ({ repo: slug, git, gh: access });

  let login: string;
  try {
    login = (await gh(["api", "user", "--jq", ".login"])).trim();
  } catch (e) {
    const state = ghFailure(e);
    return result(state === "error" ? { state, detail: sanitizeDetail(stderrOf(e)) } : { state });
  }

  try {
    const perms = JSON.parse(await gh(["api", `repos/${slug}`, "--jq", ".permissions"])) as {
      pull?: unknown;
      push?: unknown;
    } | null;
    return result({ state: "ok", login, pull: perms?.pull === true, push: perms?.push === true });
  } catch (e) {
    if (/\(HTTP 40[34]\)/.test(stderrOf(e))) {
      return result({ state: "ok", login, pull: false, push: false });
    }
    const state = ghFailure(e);
    return result(state === "error" ? { state, detail: sanitizeDetail(stderrOf(e)) } : { state });
  }
}

export type SetupGitResult =
  { ok: true; git: GitHelperInfo } | { ok: false; error: "missing" | "logged_out" | "setup" };

/** Point git at `gh` for github.com (`gh auth setup-git`), then confirm git now reports it. */
export async function setupGitViaGh(runners: GithubAccessRunners = {}): Promise<SetupGitResult> {
  const gh = runners.gh ?? defaultGh;
  try {
    await gh(["auth", "setup-git"]);
  } catch (e) {
    const state = ghFailure(e);
    return { ok: false, error: state === "error" ? "setup" : state };
  }
  const git = await gitCredentialHelper(runners.git);
  return git.usesGh ? { ok: true, git } : { ok: false, error: "setup" };
}
