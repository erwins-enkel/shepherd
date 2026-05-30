import type { Session, CreateInput, RepoEntry } from "./types";

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
