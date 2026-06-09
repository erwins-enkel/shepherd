import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { GitState, PrStatus } from "./forge/types";

/** Per-repo responsibility config, committed to `.shepherd/roles.json` at the repo
 *  root. Values are GitHub logins (the merger/reviewer for this repo) or null when
 *  the role is unset. Stored in the repo (not the central DB) so it travels with
 *  the repo and is shared across a team. */
export interface RepoRoles {
  reviewer: string | null;
  merger: string | null;
}

/** Who is up at the awaiting-merge point. `self` = the operator (today's "Your turn"). */
export type HandoffRole = "self" | "reviewer" | "merger";

const EMPTY: RepoRoles = { reviewer: null, merger: null };
const ROLES_PATH = ".shepherd/roles.json";
const ROLES_TTL_MS = 60_000;

/** Trim, drop a leading "@", empty → null. */
export function normalizeLogin(v: unknown): string | null {
  const t = (typeof v === "string" ? v : "").trim().replace(/^@/, "");
  return t || null;
}

/** Parse a roles.json payload defensively (unknown/missing fields → null). Pure,
 *  so the read path's robustness is unit-testable without a git repo. */
export function parseRoles(json: string): RepoRoles {
  const j = JSON.parse(json) as { reviewer?: unknown; merger?: unknown };
  return { reviewer: normalizeLogin(j.reviewer), merger: normalizeLogin(j.merger) };
}

/** Decide who is up once a PR is open + green. Pure — the testable core.
 *  - A foreign reviewer who hasn't approved yet → waiting on the reviewer.
 *  - Else a foreign merger → waiting on the merger.
 *  - Else the operator ("self", i.e. today's "Your turn").
 *  Any human approve counts as "reviewed" (Human-in-the-loop); the critic's own
 *  review is already filtered out upstream (`latestHumanReview`). */
export function computeHandoff(
  roles: RepoRoles,
  me: string | null,
  latestReview: PrStatus["latestReview"],
): { handoff: HandoffRole; handoffWho: string | null } {
  const reviewerIsOther = !!roles.reviewer && roles.reviewer !== me;
  const mergerIsOther = !!roles.merger && roles.merger !== me;
  const reviewApproved = latestReview?.state === "approved";
  if (reviewerIsOther && !reviewApproved)
    return { handoff: "reviewer", handoffWho: roles.reviewer };
  if (mergerIsOther) return { handoff: "merger", handoffWho: roles.merger };
  return { handoff: "self", handoffWho: null };
}

const git = (repoPath: string, args: string[], input?: string): string =>
  execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: input === undefined ? ["ignore", "pipe", "ignore"] : ["pipe", "pipe", "ignore"],
    ...(input === undefined ? {} : { input }),
  });

const defBranchCache = new Map<string, string>();
/** The repo's default branch name, resolved from the local `origin/HEAD` symref
 *  (no network); falls back to "main". Cached per repo. */
function defaultBranchLocal(repoPath: string): string {
  const hit = defBranchCache.get(repoPath);
  if (hit) return hit;
  let branch = "main";
  try {
    const out = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
    branch = out.replace(/^origin\//, "") || "main";
  } catch {
    /* unset symref → fall back to main */
  }
  defBranchCache.set(repoPath, branch);
  return branch;
}

const rolesCache = new Map<string, { roles: RepoRoles; ts: number }>();

/** Set the cache directly — used right after a write so a just-set value is
 *  visible immediately, independent of the remote-tracking ref. */
function setRolesCache(repoPath: string, roles: RepoRoles): void {
  rolesCache.set(repoPath, { roles, ts: Date.now() });
}

/** Read the COMMITTED roles file from the same ref the write path pushes to
 *  (`origin/<default>`, falling back to the local default branch) — NOT the
 *  working-tree checkout, which usually sits on an unrelated feature branch and
 *  would never see just-set roles. Missing file / bad JSON → no roles. Cached
 *  with a short TTL so the per-session poll doesn't shell `git` every tick. */
export function readRepoRoles(repoPath: string): RepoRoles {
  const hit = rolesCache.get(repoPath);
  if (hit && Date.now() - hit.ts < ROLES_TTL_MS) return hit.roles;
  const roles = readRolesFromRef(repoPath);
  rolesCache.set(repoPath, { roles, ts: Date.now() });
  return roles;
}

function readRolesFromRef(repoPath: string): RepoRoles {
  const def = defaultBranchLocal(repoPath);
  for (const ref of [`origin/${def}`, def]) {
    try {
      return parseRoles(git(repoPath, ["show", `${ref}:${ROLES_PATH}`]));
    } catch {
      /* ref or file absent / bad JSON → try next, else empty */
    }
  }
  return EMPTY;
}

/** Annotate a GitState with `handoff`/`handoffWho`. Always returns a clean state
 *  (any stale handoff is stripped first), so re-running it after a role change
 *  correctly clears a no-longer-applicable waiting state. Only an open + green PR
 *  carries a handoff (the only point the herd consults it); everything else is
 *  returned without one. */
export function annotateHandoff(state: GitState, repoPath: string, me: string | null): GitState {
  const base: GitState = { ...state };
  delete base.handoff; // drop any stale handoff so a role change clears it
  delete base.handoffWho;
  if (base.state !== "open" || base.checks !== "success") return base;
  const { handoff, handoffWho } = computeHandoff(readRepoRoles(repoPath), me, base.latestReview);
  if (handoff === "self") return base;
  return handoffWho ? { ...base, handoff, handoffWho } : { ...base, handoff };
}

/** Write `.shepherd/roles.json` and push it to the repo's default branch WITHOUT
 *  touching the working tree (the checkout usually sits on a feature branch). The
 *  commit is built via plumbing on a temp index and pushed straight to the remote
 *  default ref, so the user's branch/working tree is never disturbed. Throws on
 *  push rejection (protected branch / non-fast-forward / no auth) — the caller
 *  surfaces that to the dialog. On success the cache is set so the new value is
 *  read back immediately. */
export function writeRepoRoles(repoPath: string, roles: RepoRoles, defaultBranch: string): void {
  const content = `${JSON.stringify(roles, null, 2)}\n`;
  let base = "";
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    try {
      base = git(repoPath, ["rev-parse", ref]).trim();
      break;
    } catch {
      /* try next */
    }
  }
  if (!base) throw new Error(`cannot resolve default branch '${defaultBranch}'`);
  const blob = git(repoPath, ["hash-object", "-w", "--stdin"], content).trim();
  const tmpIndex = join(tmpdir(), `shepherd-roles-${process.pid}-${Date.now()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    execFileSync("git", ["-C", repoPath, "read-tree", base], { env, stdio: "ignore" });
    execFileSync(
      "git",
      ["-C", repoPath, "update-index", "--add", "--cacheinfo", `100644,${blob},${ROLES_PATH}`],
      { env, stdio: "ignore" },
    );
    const tree = execFileSync("git", ["-C", repoPath, "write-tree"], {
      env,
      encoding: "utf8",
    }).trim();
    const commit = git(repoPath, [
      "commit-tree",
      tree,
      "-p",
      base,
      "-m",
      "chore(shepherd): set repo roles",
    ]).trim();
    git(repoPath, ["push", "origin", `${commit}:refs/heads/${defaultBranch}`]);
  } finally {
    try {
      rmSync(tmpIndex, { force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
  setRolesCache(repoPath, roles);
}
