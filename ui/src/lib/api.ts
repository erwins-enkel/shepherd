import type {
  Session,
  CreateInput,
  RepoEntry,
  Issue,
  ActivityEntry,
  SessionUsage,
  UsageLimits,
  GitState,
  PrStatus,
  MergeMethod,
  Settings,
  DirListing,
  UpdateStatus,
  Steer,
  DiffResult,
  ProjectIcons,
} from "./types";

const JSON_HEADERS = { "content-type": "application/json" };

export async function listSessions(): Promise<Session[]> {
  const r = await fetch("/api/sessions");
  if (!r.ok) throw new Error(`list failed: ${r.status}`);
  return r.json();
}

export async function createSession(input: CreateInput): Promise<Session> {
  const r = await fetch("/api/sessions", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`create failed: ${r.status}`);
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
  if (!r.ok) throw new Error(`upload failed: ${r.status}`);
  return (await r.json()).path as string;
}

export async function archiveSession(id: string): Promise<void> {
  const r = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`archive failed: ${r.status}`);
}

export async function listRepos(): Promise<RepoEntry[]> {
  const r = await fetch("/api/repos");
  if (!r.ok) throw new Error(`repos failed: ${r.status}`);
  return r.json();
}

export async function getSettings(): Promise<Settings> {
  const r = await fetch("/api/settings");
  if (!r.ok) throw new Error(`settings failed: ${r.status}`);
  return r.json();
}

export async function putSettings(repoRoot: string): Promise<Settings> {
  const r = await fetch("/api/settings", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ repoRoot }),
  });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
  return r.json();
}

export async function listDirs(path?: string): Promise<DirListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  const r = await fetch(`/api/fs/dirs${q}`);
  if (!r.ok) throw new Error(`dirs failed: ${r.status}`);
  return r.json();
}

export async function listBranches(
  repoPath: string,
): Promise<{ branches: string[]; current: string | null }> {
  const r = await fetch(`/api/branches?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw new Error(`branches failed: ${r.status}`);
  return r.json();
}

export async function getTodo(repoPath: string): Promise<{ exists: boolean; content: string }> {
  const r = await fetch(`/api/todo?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw new Error(`todo get failed: ${r.status}`);
  return r.json();
}

export async function putTodo(repoPath: string, content: string): Promise<void> {
  const r = await fetch(`/api/todo?repo=${encodeURIComponent(repoPath)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw new Error(`todo put failed: ${r.status}`);
}

export async function getSessionUsage(id: string): Promise<SessionUsage> {
  const r = await fetch(`/api/sessions/${id}/usage`);
  if (!r.ok) throw new Error(`usage failed: ${r.status}`);
  return r.json();
}

export async function getActivity(id: string): Promise<ActivityEntry[]> {
  const r = await fetch(`/api/sessions/${id}/activity`);
  if (!r.ok) throw new Error(`activity failed: ${r.status}`);
  return r.json();
}

export async function getDiff(id: string): Promise<DiffResult> {
  const r = await fetch(`/api/sessions/${id}/diff`);
  if (!r.ok) throw new Error(`diff failed: ${r.status}`);
  return r.json();
}

export async function getUsageLimits(): Promise<UsageLimits> {
  const r = await fetch("/api/usage/limits");
  if (!r.ok) throw new Error(`limits failed: ${r.status}`);
  return r.json();
}

export async function replySession(id: string, text: string): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/reply`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`reply failed: ${r.status}`);
}

export async function dismissStall(id: string): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/dismiss-stall`, { method: "POST" });
  if (!r.ok) throw new Error(`dismiss-stall failed: ${r.status}`);
}

export async function listIssues(
  repoPath: string,
): Promise<{ slug: string | null; issues: Issue[] }> {
  const r = await fetch(`/api/issues?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw new Error(`issues failed: ${r.status}`);
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
  if (!r.ok) throw new Error(`git status failed: ${r.status}`);
  return r.json();
}

/** Snapshot of every active session's PR state, keyed by session id (for the
 *  list overview). Empty object when no forge is configured anywhere. */
export async function gitStates(): Promise<Record<string, GitState>> {
  const r = await fetch("/api/git");
  if (!r.ok) throw new Error(`git states failed: ${r.status}`);
  return r.json();
}

async function gitJson(res: Response): Promise<PrStatus> {
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

/** Current self-update status (how far the running checkout is behind main). */
export async function getUpdate(): Promise<UpdateStatus> {
  const r = await fetch("/api/update");
  if (!r.ok) throw new Error(`update status failed: ${r.status}`);
  return r.json();
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
  if (!r.ok) throw new Error(`steers failed: ${r.status}`);
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
  if (!r.ok) throw new Error(`broadcast failed: ${r.status}`);
  return r.json();
}

export async function getProjectIcons(): Promise<ProjectIcons> {
  const r = await fetch("/api/project-icons");
  if (!r.ok) throw new Error(`project-icons failed: ${r.status}`);
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
