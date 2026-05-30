import type { Session, CreateInput, RepoEntry, Issue } from "./types";

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

export async function archiveSession(id: string): Promise<void> {
  const r = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`archive failed: ${r.status}`);
}

export async function listRepos(): Promise<RepoEntry[]> {
  const r = await fetch("/api/repos");
  if (!r.ok) throw new Error(`repos failed: ${r.status}`);
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

export async function listIssues(
  repoPath: string,
): Promise<{ slug: string | null; issues: Issue[] }> {
  const r = await fetch(`/api/issues?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw new Error(`issues failed: ${r.status}`);
  return r.json();
}
