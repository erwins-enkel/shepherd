import type { VariantChoice } from "./api";

// Retain a request across transport failures, including a reopened picker with the same choice.
const requests = new Map<string, { choice: string; id: string }>();
export function replaceRequestId(sessionId: string, choice: VariantChoice): string {
  if (choice.requestId) return choice.requestId;
  const key = JSON.stringify([
    choice.agentProvider,
    choice.model,
    choice.effort ?? null,
    choice.handoffMode ?? "resume",
  ]);
  const old = requests.get(sessionId);
  if (old?.choice === key) return old.id;
  const id = crypto.randomUUID();
  requests.set(sessionId, { choice: key, id });
  return id;
}
export function settleReplaceRequest(sessionId: string, requestId: string): void {
  if (requests.get(sessionId)?.id === requestId) requests.delete(sessionId);
}
