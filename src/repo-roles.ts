import { execFileSync } from "./instrument";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { GitState, PrReviewBlock, PrReviewerState, PrStatus } from "./forge/types";
import { checksCleared, repoHasNoCiCached } from "./checks-gate";

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
 *
 *  When the repo carries explicit config (`reviewer || merger` set):
 *  - A foreign reviewer who hasn't approved yet → waiting on the reviewer.
 *  - Else a foreign merger → waiting on the merger.
 *  - Else the operator ("self", i.e. today's "Your turn"). `inferred: false`.
 *
 *  When the repo is fully unconfigured (no `.shepherd/roles.json` → no roles):
 *  infer a **merger only** from the PR itself, so a green PR awaiting someone
 *  else's merge doesn't falsely read as "your turn" (#539). The merger is the
 *  case-insensitively lowest foreign requested reviewer (gh's array order is not
 *  contractual, so sort for determinism), else a foreign approver, else self. No
 *  "reviewer" handoff is ever synthesized from inference; an inferred merger is
 *  flagged `inferred: true` so the issue-log stays opt-in to configured roles.
 *
 *  Any human approve counts as "reviewed" (Human-in-the-loop); the critic's own
 *  review is already filtered out upstream (`latestHumanReview`). */
export function computeHandoff(
  roles: RepoRoles,
  me: string | null,
  latestReview: PrStatus["latestReview"],
  requestedReviewers: string[] = [],
  reviewBlock?: PrReviewBlock,
): { handoff: HandoffRole; handoffWho: string | null; inferred: boolean } {
  // GitHub logins are case-insensitive, so compare folded — else a free-text
  // entry whose casing differs from the operator's own login would mis-read as
  // "someone else" and show "waiting on yourself".
  const meLc = me?.toLowerCase() ?? null;
  if (roles.reviewer || roles.merger)
    return configuredHandoff(roles, meLc, latestReview, reviewBlock);
  return inferredHandoff(meLc, latestReview, requestedReviewers);
}

function configuredHandoff(
  roles: RepoRoles,
  meLc: string | null,
  latestReview: PrStatus["latestReview"],
  reviewBlock?: PrReviewBlock,
): { handoff: HandoffRole; handoffWho: string | null; inferred: false } {
  const reviewerIsOther = !!roles.reviewer && roles.reviewer.toLowerCase() !== meLc;
  const mergerIsOther = !!roles.merger && roles.merger.toLowerCase() !== meLc;
  if (reviewerIsOther && reviewBlock?.state === "changes_requested")
    return { handoff: "self", handoffWho: null, inferred: false };
  const reviewApproved = latestReview?.state === "approved";
  if (reviewerIsOther && !reviewApproved)
    return { handoff: "reviewer", handoffWho: roles.reviewer, inferred: false };
  if (mergerIsOther) return { handoff: "merger", handoffWho: roles.merger, inferred: false };
  return { handoff: "self", handoffWho: null, inferred: false };
}

function inferredHandoff(
  meLc: string | null,
  latestReview: PrStatus["latestReview"],
  requestedReviewers: string[],
): { handoff: HandoffRole; handoffWho: string | null; inferred: boolean } {
  // Fully unconfigured: infer a merger from the PR. Foreign = login != me (folded).
  const foreign = (login: string): boolean => login.toLowerCase() !== meLc;
  const lowestForeignRequestedReviewer =
    requestedReviewers
      .filter(foreign)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))[0] ?? null;
  const approver = latestReview?.author;
  const foreignApprover =
    latestReview?.state === "approved" && approver && foreign(approver) ? approver : null;
  const merger = lowestForeignRequestedReviewer ?? foreignApprover ?? null;
  if (merger) return { handoff: "merger", handoffWho: merger, inferred: true };
  return { handoff: "self", handoffWho: null, inferred: false };
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

function stateForReviewer(
  reviewerStates: Record<string, PrReviewerState> | undefined,
  reviewer: string | null,
): { login: string; state: PrReviewerState } | null {
  if (!reviewer || !reviewerStates) return null;
  const reviewerLc = reviewer.toLowerCase();
  for (const [login, state] of Object.entries(reviewerStates)) {
    if (login.toLowerCase() === reviewerLc) return { login, state };
  }
  return null;
}

/** Annotate a GitState with `handoff`/`handoffWho` (+ `handoffInferred` when the
 *  handoff was auto-inferred from the PR's reviewers rather than configured roles).
 *  Always returns a clean state (any stale handoff is stripped first), so re-running
 *  it after a role change correctly clears a no-longer-applicable waiting state. Only
 *  an open + green PR carries a handoff (the only point the herd consults it);
 *  everything else is returned without one. */
export function annotateHandoff(
  state: GitState,
  repoPath: string,
  me: string | null,
  prev?: GitState,
): GitState {
  // Stamp noCi on EVERY state (the poller + on-demand /git chokepoint) so all downstream gates can
  // read git.noCi without re-deriving it. A no-CI repo (GitHub + zero workflows) treats a terminal
  // checks:"none" as cleared — see checks-gate.ts.
  const noCi = repoHasNoCiCached(state.kind, repoPath);
  const preservedReviewerStates =
    state.reviewerStates ??
    (state.state === "open" && prev?.state === "open" && prev.number === state.number
      ? prev.reviewerStates
      : undefined);
  const base: GitState = {
    ...state,
    reviewerStates: preservedReviewerStates,
    noCi,
  };
  delete base.handoff; // drop any stale handoff so a role change clears it
  delete base.handoffWho;
  delete base.handoffInferred;
  delete base.reviewBlock;
  const roles = readRepoRoles(repoPath);
  const scoped = stateForReviewer(base.reviewerStates, roles.reviewer);
  const reviewBlock =
    scoped?.state.state === "changes_requested"
      ? ({
          reviewer: scoped.login,
          state: "changes_requested",
          latestAt: scoped.state.latestAt,
        } as const)
      : undefined;
  if (reviewBlock) base.reviewBlock = reviewBlock;
  if (base.state !== "open" || !checksCleared(base.checks, noCi)) return base;
  const { handoff, handoffWho, inferred } = computeHandoff(
    roles,
    me,
    base.latestReview,
    base.requestedReviewers,
    reviewBlock,
  );
  if (handoff === "self") return base;
  const next = handoffWho ? { ...base, handoff, handoffWho } : { ...base, handoff };
  return inferred ? { ...next, handoffInferred: true } : next;
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
  // Refresh the remote-tracking ref so we base off the *current* remote tip — else
  // an advanced default branch yields a spurious non-fast-forward rejection on push.
  // Best-effort: offline just falls back to the local ref below.
  try {
    git(repoPath, ["fetch", "origin", defaultBranch]);
  } catch {
    /* offline / no remote — base off whatever local ref we have */
  }
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
