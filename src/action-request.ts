/**
 * Action Request (audit F08): an Operator Assistant action in a group set to `ask`
 * (Settings → Assistant), parked until the operator approves or denies it in the HUD. The server —
 * not Claude's own permission prompt, which a direct caller never sees — decides whether it runs.
 *
 * Bound to the exact call: the tool plus its arguments (canonical JSON). An approval is single-use:
 * it releases the one call waiting on it, or — when the operator answered between two long-polls —
 * the next identical call, once. A different call cancels the open request.
 *
 * In memory on purpose, like Login Requests (src/login-request.ts): one open request per assistant
 * session, gone on restart (which also fails the in-flight tool call, so the model re-calls and the
 * two sides stay consistent). Waiting is a bounded long-poll — Claude Code's HTTP MCP transport
 * aborts a call at 60s.
 */
import { randomUUID } from "node:crypto";
import type { EventHub } from "./events";

export interface ActionRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** The resolved target as the action names it (a desig, a repo, `herd`). */
  target: string;
  createdAt: number;
}

export type ActionOutcome = "approved" | "denied";
export type ActionWaitResult = ActionOutcome | "pending";

/** Event carrying a session's current request (`null` once resolved or dropped). */
export const ACTION_REQUEST_EVENT = "session:action-request";

/** Order-independent JSON: the identity of a call's arguments. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const callKey = (tool: string, args: Record<string, unknown>) => `${tool}\n${canonical(args)}`;

interface Entry {
  request: ActionRequest;
  key: string;
  waiters: Set<(outcome: ActionOutcome) => void>;
}

/** `request`'s answer: the open request, or the outcome of one resolved while no call waited. */
export type ActionRequestState =
  { status: "open"; request: ActionRequest } | { status: ActionOutcome };

export class ActionRequestService {
  readonly #entries = new Map<string, Entry>();
  /** An outcome no waiting call received, held for the session's next identical call. */
  readonly #undelivered = new Map<string, { key: string; outcome: ActionOutcome }>();
  readonly #events: Pick<EventHub, "emit">;
  readonly #now: () => number;

  constructor(deps: { events: Pick<EventHub, "emit" | "subscribe">; now?: () => number }) {
    this.#events = deps.events;
    this.#now = deps.now ?? Date.now;
    deps.events.subscribe((event, data) => {
      if (event !== "session:archived") return;
      const id = (data as { id: string }).id;
      const entry = this.#entries.get(id);
      if (entry) this.#settle(id, entry, "denied", false);
      this.#undelivered.delete(id);
    });
  }

  /** Every open request, keyed by session id (bootstrap GET). */
  snapshot(): Record<string, ActionRequest> {
    return Object.fromEntries([...this.#entries].map(([id, e]) => [id, e.request]));
  }

  /** Open (or re-attach to) the session's request for this exact call. */
  request(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    target: string,
  ): ActionRequestState {
    const key = callKey(tool, args);
    const undelivered = this.#undelivered.get(sessionId);
    this.#undelivered.delete(sessionId);
    const existing = this.#entries.get(sessionId);
    if (existing?.key === key) return { status: "open", request: existing.request };
    if (!existing && undelivered?.key === key) return { status: undelivered.outcome };
    if (existing) this.#settle(sessionId, existing, "denied", false);
    const request: ActionRequest = { id: randomUUID(), tool, args, target, createdAt: this.#now() };
    this.#entries.set(sessionId, { request, key, waiters: new Set() });
    this.#events.emit(ACTION_REQUEST_EVENT, { id: sessionId, request });
    return { status: "open", request };
  }

  /** Wait up to `ms` for request `requestId` to resolve; `pending` when the window runs out (or
   *  `signal` aborts — that ends only the wait, never the request). A request no longer open
   *  reads `denied`. */
  wait(
    sessionId: string,
    requestId: string,
    ms: number,
    signal?: AbortSignal,
  ): Promise<ActionWaitResult> {
    const entry = this.#entries.get(sessionId);
    if (!entry || entry.request.id !== requestId) return Promise.resolve("denied");
    return new Promise((resolve) => {
      const finish = (result: ActionWaitResult) => {
        clearTimeout(timer);
        entry.waiters.delete(onOutcome);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onOutcome = (outcome: ActionOutcome) => finish(outcome);
      const onAbort = () => finish("pending");
      const timer = setTimeout(() => finish("pending"), ms);
      entry.waiters.add(onOutcome);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The operator's answer. False when `requestId` is not the session's open request. */
  resolve(sessionId: string, requestId: string, outcome: ActionOutcome): boolean {
    const entry = this.#entries.get(sessionId);
    if (!entry || entry.request.id !== requestId) return false;
    this.#settle(sessionId, entry, outcome, true);
    return true;
  }

  /** Close `entry`. An operator answer no call is waiting for is kept for the next identical call;
   *  only the FIRST waiter gets an approval, so one approval runs one action. */
  #settle(sessionId: string, entry: Entry, outcome: ActionOutcome, byOperator: boolean): void {
    this.#entries.delete(sessionId);
    const [first, ...rest] = [...entry.waiters];
    if (byOperator && !first) this.#undelivered.set(sessionId, { key: entry.key, outcome });
    first?.(outcome);
    for (const w of rest) w(outcome === "approved" ? "denied" : outcome);
    this.#events.emit(ACTION_REQUEST_EVENT, { id: sessionId, request: null });
  }
}
