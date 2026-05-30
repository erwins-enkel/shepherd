import type { Session, CreateInput } from "./types";

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
