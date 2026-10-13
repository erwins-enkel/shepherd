import { execFileSync } from "./instrument";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type {
  GitForge,
  GitState,
  PrReviewBlock,
  PrReviewerState,
  PrStatus,
  RepoMergeSettings,
} from "./forge/types";
import { checksCleared, repoHasNoCiCached } from "./checks-gate";
import { evaluateMergeGate, mergeResponsibility, reviewBlockFor } from "./merge-gate";

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
 *  When a normal repo is fully unconfigured (no `.shepherd/roles.json` → no
 *  roles), infer a merger from the PR itself so a green PR awaiting someone
 *  else's merge doesn't falsely read as "your turn" (#539). Recognized forks use
 *  a separate inference: pending requests stay reviewer handoffs, while unnamed
 *  review/merge waits identify the upstream maintainer role without inventing a
 *  login. Every fork result is inferred so the issue-log stays opt-in.
 *
 *  Any human approve counts as "reviewed" (Human-in-the-loop); the critic's own
 *  review is already filtered out upstream (`latestHumanReview`). */
export function computeHandoff(
  roles: RepoRoles,
  me: string | null,
  latestReview: PrStatus["latestReview"],
  requestedReviewers: string[] = [],
  reviewBlock?: PrReviewBlock,
  context: {
    isFork?: boolean;
    reviewerStates?: Record<string, PrReviewerState>;
  } = {},
): { handoff: HandoffRole; handoffWho: string | null; inferred: boolean } {
  // GitHub logins are case-insensitive, so compare folded — else a free-text
  // entry whose casing differs from the operator's own login would mis-read as
  // "someone else" and show "waiting on yourself".
  const meLc = me?.toLowerCase() ?? null;
  if (roles.reviewer || roles.merger)
    return configuredHandoff(roles, meLc, latestReview, reviewBlock);
  if (context.isFork)
    return inferredForkHandoff(
      meLc,
      latestReview,
      requestedReviewers,
      reviewBlock,
      context.reviewerStates,
    );
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

/** Fork PRs target an upstream whose maintainers Shepherd cannot name reliably.
 *  Preserve a pending request when GitHub supplies one, otherwise describe the
 *  maintainer role without inventing a login. */
function inferredForkHandoff(
  meLc: string | null,
  latestReview: PrStatus["latestReview"],
  requestedReviewers: string[],
  reviewBlock: PrReviewBlock | undefined,
  reviewerStates: Record<string, PrReviewerState> | undefined,
): { handoff: HandoffRole; handoffWho: string | null; inferred: true } {
  if (reviewBlock) return { handoff: "self", handoffWho: null, inferred: true };

  const requested =
    requestedReviewers
      .filter((login) => login.toLowerCase() !== meLc)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))[0] ?? null;
  if (requested) return { handoff: "reviewer", handoffWho: requested, inferred: true };

  const approved =
    reviewerStates === undefined
      ? latestReview?.state === "approved"
      : Object.values(reviewerStates).some((review) => review.state === "approved");
  return approved
    ? { handoff: "merger", handoffWho: null, inferred: true }
    : { handoff: "reviewer", handoffWho: null, inferred: true };
}

/** Sync git for the LOCAL read path only (`git show` of a ref, a symref lookup) — fast and
 *  network-free. Anything that talks to the remote goes through {@link gitAsync}. */
const git = (repoPath: string, args: string[]): string =>
  execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const execFileAsync = promisify(execFile);

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

function inferredForkReviewBlock(
  reviewerStates: Record<string, PrReviewerState> | undefined,
): PrReviewBlock | undefined {
  const blocks = Object.entries(reviewerStates ?? {})
    .filter(([, review]) => review.state === "changes_requested")
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const [reviewer, state] = blocks[0] ?? [];
  return reviewer && state
    ? { reviewer, state: "changes_requested", latestAt: state.latestAt }
    : undefined;
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
  // Same reason, and load-bearing: this function re-annotates ALREADY-annotated states (the role
  // dialog's re-push, the poller's prev), so a responsibility the operator has since cleared or
  // reassigned would otherwise survive and keep the takeover wording on a merge that is now
  // their own.
  delete base.mergeGate;
  const roles = readRepoRoles(repoPath);
  const unconfiguredFork = !roles.reviewer && !roles.merger && !!base.isFork;
  const handoffEligible =
    base.state === "open" &&
    !(unconfiguredFork && base.isDraft) &&
    checksCleared(base.checks, noCi);
  const reviewBlock =
    unconfiguredFork && handoffEligible
      ? inferredForkReviewBlock(base.reviewerStates)
      : reviewBlockFor(roles, base.reviewerStates);
  if (reviewBlock) base.reviewBlock = reviewBlock;
  // Stamped BEFORE the eligibility gate and from the roles file alone (#2299): the merge
  // confirmation must name whose merge it is taking over even on a PR the herd is not yet
  // surfacing — a red or pending PR is still manually mergeable, and on a non-GitHub host
  // `checksCleared` never clears at all, so a CI-gated readout would never name anyone there.
  const gate = mergeResponsibility(
    evaluateMergeGate({
      roles,
      me,
      latestReview: base.latestReview,
      reviewerStates: base.reviewerStates,
    }),
  );
  if (gate) base.mergeGate = gate;
  if (!handoffEligible) return base;
  const { handoff, handoffWho, inferred } = computeHandoff(
    roles,
    me,
    base.latestReview,
    base.requestedReviewers,
    reviewBlock,
    { isFork: base.isFork, reviewerStates: base.reviewerStates },
  );
  if (inferred) base.handoffInferred = true;
  if (handoff === "self") return base;
  return handoffWho ? { ...base, handoff, handoffWho } : { ...base, handoff };
}

const LOCAL_GIT_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 20_000;
const PUSH_TIMEOUT_MS = 30_000;

/** Async git for the write path. Off the event loop: a push is network I/O, and before this
 *  ran as a blocking `execFileSync` a push in a repo with a heavy `pre-push` hook froze the
 *  whole server until the systemd watchdog killed it. Never prompts for credentials (an
 *  unattended server has no one to answer), and runs in the C locale so a push rejection
 *  reads the same on every machine. */
async function gitAsync(
  repoPath: string,
  args: string[],
  o: { timeout?: number; env?: Record<string, string> } = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout: o.timeout ?? LOCAL_GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...o.env },
  });
  return stdout.trim();
}

/** Build the roles commit on top of the CURRENT remote default tip via plumbing on a temp
 *  index, so the operator's checkout (usually on a feature branch) is never touched. */
async function buildRolesCommit(
  repoPath: string,
  roles: RepoRoles,
  defaultBranch: string,
): Promise<string> {
  // Refresh the remote-tracking ref so we base off the *current* remote tip — else
  // an advanced default branch yields a spurious non-fast-forward rejection on push.
  // Best-effort: offline just falls back to the local ref below.
  try {
    await gitAsync(repoPath, ["fetch", "origin", defaultBranch], { timeout: FETCH_TIMEOUT_MS });
  } catch {
    /* offline / no remote — base off whatever local ref we have */
  }
  let base = "";
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    try {
      base = await gitAsync(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
      break;
    } catch {
      /* try next */
    }
  }
  if (!base) throw new Error(`cannot resolve default branch '${defaultBranch}'`);
  const tmp = mkdtempSync(join(tmpdir(), "shepherd-roles-"));
  const env = { GIT_INDEX_FILE: join(tmp, "index") };
  try {
    const content = join(tmp, "roles.json");
    writeFileSync(content, `${JSON.stringify(roles, null, 2)}\n`);
    const blob = await gitAsync(repoPath, ["hash-object", "-w", "--no-filters", content]);
    await gitAsync(repoPath, ["read-tree", base], { env });
    await gitAsync(
      repoPath,
      ["update-index", "--add", "--cacheinfo", `100644,${blob},${ROLES_PATH}`],
      { env },
    );
    const tree = await gitAsync(repoPath, ["write-tree"], { env });
    return await gitAsync(repoPath, ["commit-tree", tree, "-p", base, "-m", ROLES_COMMIT_MSG]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A host-side refusal of the pushed ref (protected branch, ruleset, pre-receive hook) — the
 *  one push failure a PR can route around. Auth, network, non-fast-forward and timeouts are not.
 *  Matched on git's fixed status token; {@link gitAsync} runs git in the C locale. */
function isRemoteRejection(err: unknown): boolean {
  const { stdout, stderr } = (err ?? {}) as { stdout?: unknown; stderr?: unknown };
  return [stdout, stderr].some((s) => typeof s === "string" && s.includes("[remote rejected]"));
}

/** Push a server-built commit. `--no-verify`: this is a single-file plumbing commit, so the
 *  checkout's own hooks (e.g. a CI-equivalent `pre-push` gate testing whatever the working tree
 *  holds) have nothing to check — the remote's rules still apply. */
async function pushCommit(repoPath: string, commit: string, ref: string, force = false) {
  const args = ["push", "--no-verify", ...(force ? ["--force"] : []), "origin"];
  await gitAsync(repoPath, [...args, `${commit}:${ref}`], { timeout: PUSH_TIMEOUT_MS });
}

/** Write `.shepherd/roles.json` and push it to the repo's default branch WITHOUT
 *  touching the working tree (the checkout usually sits on a feature branch). The
 *  commit is built via plumbing on a temp index and pushed straight to the remote
 *  default ref, so the user's branch/working tree is never disturbed. A host-side
 *  refusal (protected branch) returns the built commit as `rejected` so the caller can
 *  route it through a PR; every other push failure (non-fast-forward / no auth /
 *  offline) throws. On success the cache is set so the new value is read back
 *  immediately. */
export async function writeRepoRoles(
  repoPath: string,
  roles: RepoRoles,
  defaultBranch: string,
): Promise<{ kind: "pushed" } | { kind: "rejected"; commit: string }> {
  const commit = await buildRolesCommit(repoPath, roles, defaultBranch);
  try {
    await pushCommit(repoPath, commit, `refs/heads/${defaultBranch}`);
  } catch (err) {
    if (isRemoteRejection(err)) return { kind: "rejected", commit };
    throw err;
  }
  setRolesCache(repoPath, roles);
  return { kind: "pushed" };
}

// ── PR fallback: a default branch that refuses direct pushes ──────────────────────────────
//
// One fixed branch per repo, force-pushed on every save, so repeated edits while a PR is open
// update that PR instead of piling up new ones. The local remote-tracking ref of that branch is
// the marker "this checkout has a roles PR out": it is set on every fallback push and dropped
// once the PR is merged or closed, so a repo that never needed the fallback costs no host call.

export const ROLES_PR_BRANCH = "shepherd/repo-roles";
const ROLES_PR_MARKER = `refs/remotes/origin/${ROLES_PR_BRANCH}`;
const ROLES_COMMIT_MSG = "chore(shepherd): set repo roles";
const ROLES_PR_BODY = [
  "Sets this repo's reviewer and merger in `.shepherd/roles.json`.",
  "",
  "Opened by Shepherd because the default branch does not accept direct pushes. Shepherd reads",
  "the roles from the default branch, so they take effect once this PR is merged.",
].join("\n");

/** Whether the save armed host auto-merge on the roles PR. `off`: the repo does not allow
 *  auto-merge; `unsupported`: the host has no auto-merge; `failed`: the host refused. */
export type RolesAutoMerge = "enabled" | "off" | "failed" | "unsupported";

/** A roles change waiting in an open PR. `roles` is the value the PR will commit. */
export interface PendingRoles {
  number: number;
  url: string | null;
  roles: RepoRoles;
  /** Set only by the request that armed (or tried to arm) auto-merge. */
  autoMerge?: RolesAutoMerge;
}

/** Fork forges never take the PR fallback: the PR would land on the upstream's maintainers. */
export async function readMergeSettings(forge: GitForge): Promise<RepoMergeSettings | null> {
  if (forge.isFork || !forge.repoMergeSettings) return null;
  try {
    return await forge.repoMergeSettings();
  } catch (err) {
    console.warn("[repo-roles] merge settings unavailable:", err);
    return null;
  }
}

/** The open roles PR this checkout opened, or null. On a merged/closed PR the marker is
 *  dropped; a merge also refreshes the default branch so the committed roles are current. */
export async function readPendingRoles(
  repoPath: string,
  forge: GitForge,
): Promise<PendingRoles | null> {
  if (forge.isFork) return null;
  let marker: string;
  try {
    marker = await gitAsync(repoPath, ["rev-parse", "--verify", "--quiet", ROLES_PR_MARKER]);
  } catch {
    return null; // no roles PR from this checkout
  }
  try {
    const pr = await forge.prStatus(ROLES_PR_BRANCH);
    if (pr.state === "open" && pr.number) {
      const roles = parseRoles(await gitAsync(repoPath, ["show", `${marker}:${ROLES_PATH}`]));
      return { number: pr.number, url: pr.url ?? null, roles };
    }
    if (pr.state === "merged" || pr.state === "closed") {
      await dropRolesPrMarker(repoPath);
      if (pr.state === "merged") await refreshCommittedRoles(repoPath, forge);
    }
  } catch (err) {
    console.warn("[repo-roles] roles PR lookup failed:", err);
  }
  return null;
}

async function dropRolesPrMarker(repoPath: string): Promise<void> {
  try {
    await gitAsync(repoPath, ["update-ref", "-d", ROLES_PR_MARKER]);
  } catch {
    /* already gone */
  }
}

async function refreshCommittedRoles(repoPath: string, forge: GitForge): Promise<void> {
  try {
    const def = await forge.defaultBranch();
    await gitAsync(repoPath, ["fetch", "origin", def], { timeout: FETCH_TIMEOUT_MS });
  } catch {
    /* offline — the next fetch catches up */
  }
  rolesCache.delete(repoPath);
}

async function armAutoMerge(
  forge: GitForge,
  prNumber: number,
  settings: RepoMergeSettings | null,
): Promise<RolesAutoMerge> {
  if (!forge.enableAutoMerge) return "unsupported";
  if (settings?.autoMergeAllowed === false) return "off";
  try {
    await forge.enableAutoMerge(prNumber, forge.mergeMethod);
    return "enabled";
  } catch (err) {
    console.warn(`[repo-roles] could not arm auto-merge on PR #${prNumber}:`, err);
    return "failed";
  }
}

/** Close a roles PR whose change no longer applies (reverted, or landed directly) and take
 *  its branch down. Best-effort: a leftover PR is harmless next to a correct default branch. */
export async function closeRolesPr(
  repoPath: string,
  forge: GitForge,
  prNumber: number,
): Promise<void> {
  try {
    await forge.closePr?.(prNumber);
    await gitAsync(repoPath, ["push", "--no-verify", "origin", `:refs/heads/${ROLES_PR_BRANCH}`], {
      timeout: PUSH_TIMEOUT_MS,
    });
  } catch (err) {
    console.warn(`[repo-roles] could not close roles PR #${prNumber}:`, err);
  }
  await dropRolesPrMarker(repoPath);
}

/** Persist roles: a direct push to the default branch, or — when the host refuses it — the
 *  same commit on {@link ROLES_PR_BRANCH} with a PR (reused while open) and auto-merge armed
 *  where the repo allows it. `pending`/`settings` are the caller's current reads, passed in so
 *  one request asks the host once. Throws when neither path can persist the change. */
export async function saveRepoRoles(
  repoPath: string,
  roles: RepoRoles,
  forge: GitForge,
  o: { pending: PendingRoles | null; settings: RepoMergeSettings | null },
): Promise<{ kind: "pushed" } | { kind: "pr"; pending: PendingRoles }> {
  const def = await forge.defaultBranch();
  const write = await writeRepoRoles(repoPath, roles, def);
  if (write.kind === "pushed") {
    // The default branch took it after all; an older PR would later overwrite it.
    if (o.pending) await closeRolesPr(repoPath, forge, o.pending.number);
    return { kind: "pushed" };
  }
  if (forge.isFork) throw new Error("default branch refused the roles push (fork: no PR)");
  await pushCommit(repoPath, write.commit, `refs/heads/${ROLES_PR_BRANCH}`, true);
  // Set explicitly: a narrow fetch refspec would not update the tracking ref on push.
  await gitAsync(repoPath, ["update-ref", ROLES_PR_MARKER, write.commit]);
  let pr = await forge.prStatus(ROLES_PR_BRANCH);
  if (pr.state !== "open") {
    pr = await forge.openPr({
      head: ROLES_PR_BRANCH,
      base: def,
      title: ROLES_COMMIT_MSG,
      body: ROLES_PR_BODY,
    });
  }
  if (!pr.number) throw new Error("roles PR could not be resolved after opening it");
  const autoMerge = await armAutoMerge(forge, pr.number, o.settings);
  return { kind: "pr", pending: { number: pr.number, url: pr.url ?? null, roles, autoMerge } };
}

/** Turn the repo's auto-merge setting on, then arm it on the open roles PR (if any). */
export async function enableRolesAutoMerge(
  repoPath: string,
  forge: GitForge,
): Promise<{ settings: RepoMergeSettings | null; pending: PendingRoles | null }> {
  if (!forge.enableRepoAutoMerge) throw new Error("host has no auto-merge setting");
  await forge.enableRepoAutoMerge();
  const [settings, pending] = await Promise.all([
    readMergeSettings(forge),
    readPendingRoles(repoPath, forge),
  ]);
  if (!pending) return { settings, pending };
  return {
    settings,
    pending: { ...pending, autoMerge: await armAutoMerge(forge, pending.number, settings) },
  };
}
