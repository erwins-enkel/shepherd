import type {
  Session,
  CreateInput,
  RepoEntry,
  Issue,
  PullRequest,
  ActivityEntry,
  SessionUsage,
  UsageLimits,
  GitState,
  PrStatus,
  MergeMethod,
  Settings,
  DirListing,
  UpdateStatus,
  DeployState,
  HerdrUpdateStatus,
  Steer,
  DiffResult,
  ProjectIcons,
  ReviewVerdict,
  PlanGate,
  RepoConfig,
  ReadinessReport,
  DrainStatus,
  AutoMergeStatus,
  QueuedItem,
  BacklogPayload,
  SlashCommand,
  Leftover,
  Learning,
  RepoInjectable,
  ForgeKind,
  WorkflowRun,
  WorkflowJob,
  SessionActivity,
  BuildQueue,
  BuildStepStatus,
  PullResult,
} from "./types";

const JSON_HEADERS = { "content-type": "application/json" };

/** Build an Error from a failed response, preferring the server's `{error}` body
 *  (e.g. "no active workspace") over the bare status code so the UI shows the real
 *  cause. Falls back to "<label> failed: <status>" when the body carries no message. */
async function failed(r: Response, label: string): Promise<Error> {
  const detail = await r
    .json()
    .then((b) => (b as { error?: string })?.error)
    .catch(() => null);
  return new Error(detail ?? `${label} failed: ${r.status}`);
}

/** GET a JSON resource, throwing `<label> failed: <status>` on a non-2xx response. */
async function getJson<T>(url: string, label: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${label} failed: ${r.status}`);
  return r.json() as Promise<T>;
}

export async function listSessions(): Promise<Session[]> {
  const r = await fetch("/api/sessions");
  if (!r.ok) throw await failed(r, "list");
  return r.json();
}

export async function createSession(input: CreateInput): Promise<Session> {
  const r = await fetch("/api/sessions", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!r.ok) throw await failed(r, "create");
  return r.json();
}

/** Upload one image; returns its absolute server path. Pass sessionId to store it
 *  inside that session's worktree (live terminal); omit for New Task staging. */
export async function uploadImage(file: File, sessionId?: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
  // no content-type header: the browser sets the multipart boundary
  const r = await fetch(`/api/uploads${q}`, { method: "POST", body: fd });
  if (!r.ok) throw await failed(r, "upload");
  return (await r.json()).path as string;
}

/** Leftover subprocesses/proxies that would survive this session's close; [] when none. */
export async function getLeftovers(id: string): Promise<Leftover[]> {
  const r = await fetch(`/api/sessions/${id}/leftovers`);
  if (!r.ok) throw await failed(r, "leftovers");
  return r.json();
}

/** Archive a session; pass leftover keys to also terminate those subprocesses. */
export async function archiveSession(id: string, reap?: string[]): Promise<void> {
  const init: RequestInit = { method: "DELETE" };
  if (reap?.length) {
    init.headers = JSON_HEADERS;
    init.body = JSON.stringify({ reap });
  }
  const r = await fetch(`/api/sessions/${id}`, init);
  if (!r.ok) throw await failed(r, "archive");
}

/** Merged-branch session ids + aggregate leftover count, for the clear-all confirm modal. */
export async function getMergedClearable(): Promise<{ ids: string[]; leftovers: number }> {
  const r = await fetch("/api/sessions/clear-merged");
  if (!r.ok) throw await failed(r, "merged clearable");
  return r.json();
}

/** Archive every merged-branch session (the given ids), terminating their leftover
 *  subprocesses. The server re-validates each id is merged before archiving. */
export async function clearMerged(
  ids: string[],
): Promise<{ cleared: string[]; leftovers: number }> {
  const r = await fetch("/api/sessions/clear-merged", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids }),
  });
  if (!r.ok) throw await failed(r, "clear merged");
  return r.json();
}

export async function listRepos(): Promise<RepoEntry[]> {
  const r = await fetch("/api/repos");
  if (!r.ok) throw await failed(r, "repos");
  return r.json();
}

export async function cloneRepo(url: string): Promise<RepoEntry> {
  const r = await fetch("/api/repos", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ url }),
  });
  if (!r.ok) throw await failed(r, "clone");
  return r.json();
}

export async function getSettings(): Promise<Settings> {
  const r = await fetch("/api/settings");
  if (!r.ok) throw await failed(r, "settings");
  return r.json();
}

// Standalone settings patch: PUT exactly the given fields to /api/settings, throw the
// server's error message on failure, and return the parsed response. The server routes
// by which field is present — a bare {repoRoot} is the repo-root change; any other single
// field is its own validating patch.
async function patchSettings<T>(patch: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/settings", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
  return r.json();
}

export const putSettings = (repoRoot: string): Promise<Settings> =>
  patchSettings<Settings>({ repoRoot });

// Toggle Claude Code Remote Control auto-start for Shepherd-spawned sessions.
export const putRemoteControl = (enabled: boolean): Promise<{ remoteControlAtStartup: boolean }> =>
  patchSettings({ remoteControlAtStartup: enabled });

// Toggle the daily session-housekeeping sweep (prune of old archived sessions).
export const putSessionHousekeeping = (
  enabled: boolean,
): Promise<{ sessionHousekeepingEnabled: boolean }> =>
  patchSettings({ sessionHousekeepingEnabled: enabled });

// Persist the backlog quick-launch standard command; empty string disables the shortcut.
export const putStandardCommand = (command: string): Promise<{ standardCommand: string }> =>
  patchSettings({ standardCommand: command });

// Persist the global PR review-cycles cap (max PR-critic auto-address rounds). The
// server clamps the value into its valid range and returns the stored value.
export const putPrReviewCyclesCap = (cap: number): Promise<{ prReviewCyclesCap: number }> =>
  patchSettings({ prReviewCyclesCap: cap });

// Persist the global plan review-cycles cap (max plan-gate revise rounds). The
// server clamps the value into its valid range and returns the stored value.
export const putPlanReviewCyclesCap = (cap: number): Promise<{ planReviewCyclesCap: number }> =>
  patchSettings({ planReviewCyclesCap: cap });

export async function listDirs(path?: string): Promise<DirListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  const r = await fetch(`/api/fs/dirs${q}`);
  if (!r.ok) throw await failed(r, "dirs");
  return r.json();
}

export async function listBranches(
  repoPath: string,
): Promise<{ branches: string[]; current: string | null }> {
  const r = await fetch(`/api/branches?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "branches");
  return r.json();
}

export async function getTodo(repoPath: string): Promise<{ exists: boolean; content: string }> {
  const r = await fetch(`/api/todo?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "todo get");
  return r.json();
}

export async function putTodo(repoPath: string, content: string): Promise<void> {
  const r = await fetch(`/api/todo?repo=${encodeURIComponent(repoPath)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw await failed(r, "todo put");
}

export async function getSessionUsage(id: string): Promise<SessionUsage> {
  const r = await fetch(`/api/sessions/${id}/usage`);
  if (!r.ok) throw await failed(r, "usage");
  return r.json();
}

export async function getActivity(id: string): Promise<ActivityEntry[]> {
  const r = await fetch(`/api/sessions/${id}/activity`);
  if (!r.ok) throw await failed(r, "activity");
  return r.json();
}

export async function getDiff(id: string): Promise<DiffResult> {
  const r = await fetch(`/api/sessions/${id}/diff`);
  if (!r.ok) throw await failed(r, "diff");
  return r.json();
}

export async function getUsageLimits(): Promise<UsageLimits> {
  const r = await fetch("/api/usage/limits");
  if (!r.ok) throw await failed(r, "limits");
  return r.json();
}

export async function replySession(id: string, text: string): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/reply`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw await failed(r, "reply");
}

/** Bring a finished session back — re-spawns `claude --resume` in its worktree. */
export async function resumeSession(id: string): Promise<Session> {
  const r = await fetch(`/api/sessions/${id}/resume`, { method: "POST" });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `resume failed: ${r.status}`);
  }
  return r.json();
}

export async function dismissStall(id: string): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/dismiss-stall`, { method: "POST" });
  if (!r.ok) throw await failed(r, "dismiss-stall");
}

/** Toggle the operator "ready to merge" flag. Live state returns via the
 *  session:ready WS event, so callers fire-and-forget like dismissStall. */
export async function setReadyToMerge(id: string, ready: boolean): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/ready`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ready }),
  });
  if (!r.ok) throw await failed(r, "ready");
}

/** Flag a launched merge train's scoped ready PRs as "merging". Fire-and-forget
 *  shape like setReadyToMerge — live state returns via the session:merging WS
 *  event; marking is cosmetic, so a failure must not abort the train launch. */
export async function startMergeTrain(ids: string[], trainId: string): Promise<void> {
  const r = await fetch("/api/merge-train/start", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids, trainId }),
  });
  if (!r.ok) throw await failed(r, "merge-train");
}

export async function listIssues(
  repoPath: string,
): Promise<{ slug: string | null; issues: Issue[] }> {
  const r = await fetch(`/api/issues?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "issues");
  return r.json();
}

export async function listPullRequests(
  repoPath: string,
): Promise<{ slug: string | null; prs: PullRequest[] }> {
  const r = await fetch(`/api/prs?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "prs");
  return r.json();
}

/** Latest Actions run per workflow on a repo's default branch (any forge that
 *  supports Actions — GitHub + Gitea/Forgejo), with per-job breakdown where the
 *  forge exposes one. The caller gates UI on the capability flags:
 *  `supportsActions` (can list runs), `canRerun` / `canCancel` (REST controls). */
export async function listWorkflowRuns(repoPath: string): Promise<{
  slug: string | null;
  kind: ForgeKind | null;
  runs: WorkflowRun[];
  supportsActions: boolean;
  canRerun: boolean;
  canCancel: boolean;
}> {
  const r = await fetch(`/api/actions?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "actions");
  return r.json();
}

/** Prior runs of one workflow on the default branch (summary rows; `jobs` empty).
 *  GitHub only — other forges return no runs. `limit` caps how many are fetched. */
export async function listWorkflowRunHistory(
  repoPath: string,
  workflowId: number,
  limit: number,
): Promise<{ runs: WorkflowRun[] }> {
  const r = await fetch(
    `/api/actions/history?repo=${encodeURIComponent(repoPath)}&workflowId=${workflowId}&limit=${limit}`,
  );
  if (!r.ok) throw await failed(r, "actions history");
  return r.json();
}

/** Per-job breakdown for a single run, lazy-loaded when a history row expands. */
export async function listRunJobs(
  repoPath: string,
  runId: number,
): Promise<{ jobs: WorkflowJob[] }> {
  const r = await fetch(
    `/api/actions/run-jobs?repo=${encodeURIComponent(repoPath)}&runId=${runId}`,
  );
  if (!r.ok) throw await failed(r, "run jobs");
  return r.json();
}

/** Merge a backlog PR by repo + number (no session). Resolves on success. */
export async function mergeBacklogPr(
  repoPath: string,
  number: number,
  body?: { method?: MergeMethod; deleteBranch?: boolean },
): Promise<void> {
  const r = await fetch("/api/prs/merge", JSON_POST({ repo: repoPath, number, ...body }));
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
}

/** Fast-forward a repo's local default-branch checkout after a merge. Returns the
 *  PullResult body regardless of HTTP status (fail-closed states are data, not throws);
 *  only a network/parse failure collapses to { ok:false, reason:"error" }. */
export async function pullRepo(repoPath: string, branch?: string): Promise<PullResult> {
  try {
    const r = await fetch("/api/repos/pull", JSON_POST({ repo: repoPath, branch }));
    return (await r.json()) as PullResult;
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Post the opt-in "@dependabot rebase" command on a stuck Dependabot backlog PR
 *  by repo + number. Resolves on success. */
export async function requestDependabotRebase(repoPath: string, number: number): Promise<void> {
  const r = await fetch("/api/prs/dependabot-rebase", JSON_POST({ repo: repoPath, number }));
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
}

/** Re-run a GitHub Actions run by repo + runId. `failedOnly` retries just the
 *  failed jobs (set when the run failed); else the whole run. Resolves on success. */
export async function rerunWorkflowRun(
  repoPath: string,
  runId: number,
  failedOnly = false,
): Promise<void> {
  const r = await fetch("/api/actions/rerun", JSON_POST({ repo: repoPath, runId, failedOnly }));
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
}

/** Cancel an in-progress GitHub Actions run by repo + runId. Resolves on success. */
export async function cancelWorkflowRun(repoPath: string, runId: number): Promise<void> {
  const r = await fetch("/api/actions/cancel", JSON_POST({ repo: repoPath, runId }));
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
}

/** Installed slash commands (skills + command files) for the New Task picker. */
export async function getCommands(repoPath: string): Promise<{ commands: SlashCommand[] }> {
  const r = await fetch(`/api/commands?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "commands");
  return r.json();
}

const JSON_POST = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: JSON_HEADERS,
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Read PR/CI/deploy state for a session's branch, or null when no forge is configured. */
export async function gitState(id: string): Promise<GitState | null> {
  const r = await fetch(`/api/sessions/${id}/git`);
  if (r.status === 404) return null;
  if (!r.ok) throw await failed(r, "git status");
  return r.json();
}

/** Snapshot of every active session's PR state, keyed by session id (for the
 *  list overview). Empty object when no forge is configured anywhere. */
export async function gitStates(): Promise<Record<string, GitState>> {
  const r = await fetch("/api/git");
  if (!r.ok) throw await failed(r, "git states");
  return r.json();
}

/** Snapshot of the last-emitted activity signal per running session, keyed by
 *  session id (for client bootstrap). Empty object when nothing is running. */
export async function activityStates(): Promise<Record<string, SessionActivity>> {
  const r = await fetch("/api/activity");
  if (!r.ok) throw await failed(r, "activity states");
  return r.json();
}

/** Snapshot of the bound preview-listener port per session, keyed by session id
 *  (for client bootstrap). `previewPort` is null when the server knows of no
 *  live dev-server listener. Empty object when nothing is bound. */
export async function previewStates(): Promise<Record<string, { previewPort: number | null }>> {
  const r = await fetch("/api/preview");
  if (!r.ok) throw await failed(r, "preview states");
  return r.json();
}

async function gitJson<T = PrStatus>(res: Response): Promise<T> {
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ error: `${res.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${res.status}`);
  }
  return res.json();
}

export async function openPr(
  id: string,
  body?: { title?: string; body?: string },
): Promise<PrStatus> {
  return gitJson(await fetch(`/api/sessions/${id}/git/pr`, JSON_POST(body ?? {})));
}

export async function mergePr(
  id: string,
  body?: { method?: MergeMethod; deleteBranch?: boolean },
): Promise<PrStatus> {
  return gitJson(await fetch(`/api/sessions/${id}/git/merge`, JSON_POST(body ?? {})));
}

/** Rename a session. The server slugifies the name, renames the git branch (and a
 *  GitHub PR's remote branch when one is open), and broadcasts `session:renamed`.
 *  `branchRenamed` is false when an open PR on a non-retargetable host (Gitea) forced
 *  a display-only rename. Rejects with `name_taken` when the target branch exists. */
export async function renameSession(
  id: string,
  name: string,
): Promise<{ session: Session; branchRenamed: boolean; prRetargeted: boolean }> {
  return gitJson(await fetch(`/api/sessions/${id}/rename`, JSON_POST({ name })));
}

/** Current self-update status (how far the running checkout is behind main). */
export async function getUpdate(): Promise<UpdateStatus> {
  const r = await fetch("/api/update");
  if (!r.ok) throw await failed(r, "update status");
  return r.json();
}

/** Live state of the detached deploy (running / done / failed + captured log),
 *  so the UI can surface *why* an update failed instead of a bare status code. */
export async function getUpdateLog(): Promise<DeployState> {
  const r = await fetch("/api/update/log");
  if (!r.ok) throw await failed(r, "update log");
  return r.json();
}

/** Current herdr-version update status (whether a newer herdr exists). */
export async function getHerdrUpdate(): Promise<HerdrUpdateStatus> {
  const r = await fetch("/api/herdr-update");
  if (!r.ok) throw await failed(r, "herdr update status");
  return r.json();
}

/** Trigger `herdr update` (restarts herdr → ends live sessions → restarts shepherd). */
export async function applyHerdrUpdate(): Promise<void> {
  const r = await fetch("/api/herdr-update", { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
}

/** Trigger the deploy script (pull → rebuild → restart). Server restarts on success. */
export async function applyUpdate(): Promise<void> {
  const r = await fetch("/api/update", { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
}

export async function redeploy(id: string): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/git/redeploy`, JSON_POST());
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
}

export async function getSteers(): Promise<Steer[]> {
  const r = await fetch("/api/steers");
  if (!r.ok) throw await failed(r, "steers");
  return r.json();
}

export async function putSteers(steers: Steer[]): Promise<Steer[]> {
  const r = await fetch("/api/steers", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(steers),
  });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
  return r.json();
}

export async function broadcast(
  text: string,
  ids: string[],
): Promise<{ sent: number; total: number }> {
  const r = await fetch("/api/broadcast", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text, ids }),
  });
  if (!r.ok) throw await failed(r, "broadcast");
  return r.json();
}

/** Fleet-wide emergency stop: interrupt every live working agent at once. No body —
 *  the server computes the target set. Returns how many panes were halted. */
export async function halt(): Promise<{ halted: number }> {
  const r = await fetch("/api/halt", { method: "POST" });
  if (!r.ok) throw await failed(r, "halt");
  return r.json();
}

export async function getProjectIcons(): Promise<ProjectIcons> {
  const r = await fetch("/api/project-icons");
  if (!r.ok) throw await failed(r, "project-icons");
  return r.json();
}

export async function putProjectIcon(path: string, emoji: string): Promise<ProjectIcons> {
  const r = await fetch("/api/project-icons", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ path, emoji }),
  });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
  return r.json();
}

export async function getReviews(): Promise<Record<string, ReviewVerdict>> {
  return getJson("/api/reviews", "reviews");
}

/** Session ids with a critic run currently in flight (bootstrap for the reviewing indicator). */
export async function getReviewingIds(): Promise<string[]> {
  return getJson("/api/reviews/inflight", "reviewing");
}

/** Snapshot of every session's plan-gate verdict, keyed by session id (bootstrap). */
export async function getPlanGates(): Promise<Record<string, PlanGate>> {
  return getJson("/api/plan-gates", "plan-gates");
}

/** Session ids with a plan review currently in flight (bootstrap for the reviewing indicator). */
export async function getPlanGatesInflight(): Promise<string[]> {
  return getJson("/api/plan-gates/inflight", "plan-gates inflight");
}

/** Release an approved plan gate so the agent executes. Returns false on 409 (not approved). */
export async function releasePlanGate(id: string): Promise<boolean> {
  const r = await fetch(`/api/sessions/${id}/go`, JSON_POST());
  return r.ok;
}

/** Outcome of an on-demand plan review trigger: a reviewer spawned, the request was a silent
 *  no-op (plan unchanged / already approved), or a spawn attempt failed. Mirrors the server's
 *  PlanReviewTrigger so the UI can distinguish a dedupe from a genuine error. */
export type PlanReviewTrigger = "started" | "skipped" | "error";

/** Trigger an on-demand plan review (202). Fire-and-forget; verdict returns via WS.
 *  Returns the trigger outcome so the caller can tell a real review from a silent dedupe
 *  ("skipped") and a genuine spawn failure ("error"). */
export async function reviewPlan(id: string): Promise<PlanReviewTrigger> {
  const r = await fetch(`/api/sessions/${id}/review-plan`, JSON_POST());
  if (!r.ok) throw await failed(r, "review-plan");
  const body = (await r.json().catch(() => ({}))) as { status?: PlanReviewTrigger };
  return body.status ?? "skipped";
}

export async function getBacklog(): Promise<BacklogPayload> {
  const r = await fetch("/api/backlog");
  if (!r.ok) throw await failed(r, "backlog");
  return r.json();
}

export async function getReadiness(repoPath: string): Promise<ReadinessReport> {
  return getJson(`/api/readiness?repo=${encodeURIComponent(repoPath)}`, "readiness");
}

export async function getRepoConfig(repoPath: string): Promise<RepoConfig> {
  return getJson(`/api/repo-config?repo=${encodeURIComponent(repoPath)}`, "repo-config");
}

export async function putRepoConfig(
  repoPath: string,
  patch: Partial<
    Pick<
      RepoConfig,
      | "criticEnabled"
      | "autoAddressEnabled"
      | "learningsEnabled"
      | "autopilotEnabled"
      | "autoDrainEnabled"
      | "autoMergeEnabled"
      | "planGateEnabled"
      | "maxAuto"
      | "autoLabel"
      | "usageCeilingPct"
    >
  >,
): Promise<RepoConfig> {
  const r = await fetch(`/api/repo-config?repo=${encodeURIComponent(repoPath)}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`repo-config put failed: ${r.status}`);
  return r.json();
}

export async function getDrain(): Promise<DrainStatus[]> {
  return getJson("/api/drain", "drain");
}

/** The backlog issues behind a repo's `queued` count — fetched lazily when the
 *  QueueStrip popover opens (the drain:status WS event stays count-only). */
export async function getDrainQueue(repoPath: string): Promise<QueuedItem[]> {
  return getJson(`/api/drain/queue?repo=${encodeURIComponent(repoPath)}`, "drain-queue");
}

export async function setSessionAutopilot(id: string, enabled: boolean | null): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/autopilot`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`autopilot toggle failed: ${r.status}`);
}

/** Bootstrap: per-repo automerge status (mirrors GET /api/drain). */
export async function getAutoMerge(): Promise<AutoMergeStatus[]> {
  return getJson("/api/automerge", "automerge");
}

export async function getPendingLearnings(): Promise<Learning[]> {
  const r = await fetch("/api/learnings/pending");
  if (!r.ok) throw await failed(r, "learnings");
  return r.json();
}

/** Per-repo injected/active house rules with budget meter data, for the drawer's
 *  "Injected house rules" view. One entry per repo with ≥1 active/promoted rule. */
export async function getInjectableLearnings(): Promise<RepoInjectable[]> {
  const r = await fetch("/api/learnings/injectable");
  if (!r.ok) throw await failed(r, "injectable learnings");
  return r.json();
}

export async function approveLearning(id: string, rule?: string): Promise<Learning> {
  const r = await fetch(`/api/learnings/${id}/approve`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(rule !== undefined ? { rule } : {}),
  });
  if (!r.ok) throw await failed(r, "approve");
  return r.json();
}

export async function dismissLearning(id: string): Promise<Learning> {
  const r = await fetch(`/api/learnings/${id}/dismiss`, { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) throw await failed(r, "dismiss");
  return r.json();
}

export async function distillRepo(repoPath: string): Promise<void> {
  const r = await fetch(`/api/learnings/distill?repo=${encodeURIComponent(repoPath)}`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await failed(r, "distill");
}

/** Promote an active rule into the repo's CLAUDE.md via an auto-opened PR.
 *  Returns the PR url; the rule flips to `promoted` server-side. */
export async function promoteLearning(id: string): Promise<{ url: string }> {
  const r = await fetch(`/api/learnings/${id}/promote`, { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) throw await failed(r, "promote");
  return r.json();
}

export async function getBuildQueue(sessionId: string): Promise<BuildQueue> {
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, "build-queue");
}

export async function putBuildQueue(
  sessionId: string,
  steps: { id?: string; title: string; detail?: string; status?: BuildStepStatus }[],
): Promise<BuildQueue> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ steps }),
  });
  if (!r.ok) throw await failed(r, "build-queue put");
  return r.json();
}

export async function approveBuildQueue(sessionId: string): Promise<BuildQueue> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/queue/approve`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await failed(r, "build-queue approve");
  return r.json();
}
