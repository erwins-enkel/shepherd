/**
 * Login Request (CONTEXT.md, issue #2882): an agent's ask that the operator perform a Handoff
 * Login at a URL in the repo's Shared Browser. Raised by the `browser_request_login` MCP tool,
 * shown as a needs-you item, resolved only by the operator (`done` / `cancelled`).
 *
 * In memory on purpose: one open request per session, gone on restart. A restart also fails the
 * agent's in-flight tool call, so the agent re-asks and the two sides stay consistent.
 *
 * Waiting is a long-poll (`wait`): Claude Code's HTTP MCP transport aborts a call at 60s, so one
 * tool call waits a bounded window and reports `pending`; the agent calls again and re-attaches.
 */
import { randomUUID } from "node:crypto";
import type { EventHub } from "./events";

export interface LoginRequest {
  id: string;
  url: string;
  reason: string;
  createdAt: number;
}

export type LoginOutcome = "done" | "cancelled";
export type LoginWaitResult = LoginOutcome | "pending";

/** Event carrying a session's current request (`null` once resolved or dropped). */
export const LOGIN_REQUEST_EVENT = "session:login-request";

interface Entry {
  request: LoginRequest;
  waiters: Set<(outcome: LoginOutcome) => void>;
}

/** `request`'s answer: the open request, or the outcome of one resolved while no call waited. */
export type LoginRequestState =
  { status: "open"; request: LoginRequest; created: boolean } | { status: LoginOutcome };

export class LoginRequestService {
  readonly #entries = new Map<string, Entry>();
  /** An outcome no waiting call received (the operator resolved between two long-polls), held
   *  for the agent's next call on the same url. */
  readonly #undelivered = new Map<string, { url: string; outcome: LoginOutcome }>();
  readonly #events: Pick<EventHub, "emit">;
  readonly #now: () => number;

  constructor(deps: { events: Pick<EventHub, "emit" | "subscribe">; now?: () => number }) {
    this.#events = deps.events;
    this.#now = deps.now ?? Date.now;
    deps.events.subscribe((event, data) => {
      if (event !== "session:archived") return;
      const id = (data as { id: string }).id;
      this.resolve(id, "cancelled");
      this.#undelivered.delete(id);
    });
  }

  /** The session's open request, if any. */
  get(sessionId: string): LoginRequest | null {
    return this.#entries.get(sessionId)?.request ?? null;
  }

  /** Every open request, keyed by session id (bootstrap GET). */
  snapshot(): Record<string, LoginRequest> {
    return Object.fromEntries([...this.#entries].map(([id, e]) => [id, e.request]));
  }

  /** True when `request(sessionId, url, …)` would open a NEW request — the caller's cue to open
   *  the login tab first, so a browser that can't be reached never raises a request. */
  wouldCreate(sessionId: string, url: string): boolean {
    const existing = this.#entries.get(sessionId);
    if (existing) return existing.request.url !== url;
    return this.#undelivered.get(sessionId)?.url !== url;
  }

  /**
   * Open (or re-attach to) the session's request. The same url while one is open returns it
   * unchanged (`created: false`); a different url cancels the old one and opens a new one. A
   * request on this url resolved while no call was waiting returns that outcome, once.
   */
  request(sessionId: string, url: string, reason: string): LoginRequestState {
    const undelivered = this.#undelivered.get(sessionId);
    this.#undelivered.delete(sessionId);
    const existing = this.#entries.get(sessionId);
    if (existing?.request.url === url)
      return { status: "open", request: existing.request, created: false };
    if (!existing && undelivered?.url === url) return { status: undelivered.outcome };
    if (existing) this.#settle(sessionId, existing, "cancelled", false);
    const request: LoginRequest = { id: randomUUID(), url, reason, createdAt: this.#now() };
    this.#entries.set(sessionId, { request, waiters: new Set() });
    this.#events.emit(LOGIN_REQUEST_EVENT, { id: sessionId, request });
    return { status: "open", request, created: true };
  }

  /**
   * Wait up to `ms` for request `requestId` (just returned by `request`) to resolve; `pending`
   * when the window runs out. A request no longer open reads `cancelled`. `signal` (the agent's
   * aborted HTTP call) ends only the wait, never the request.
   */
  wait(
    sessionId: string,
    requestId: string,
    ms: number,
    signal?: AbortSignal,
  ): Promise<LoginWaitResult> {
    const entry = this.#entries.get(sessionId);
    if (!entry || entry.request.id !== requestId) return Promise.resolve("cancelled");
    return new Promise((resolve) => {
      const finish = (result: LoginWaitResult) => {
        clearTimeout(timer);
        entry.waiters.delete(onOutcome);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onOutcome = (outcome: LoginOutcome) => finish(outcome);
      const onAbort = () => finish("pending");
      const timer = setTimeout(() => finish("pending"), ms);
      entry.waiters.add(onOutcome);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Operator resolution (or session teardown). False when the session has no open request. */
  resolve(sessionId: string, outcome: LoginOutcome): boolean {
    const entry = this.#entries.get(sessionId);
    if (!entry) return false;
    this.#settle(sessionId, entry, outcome, true);
    return true;
  }

  #settle(sessionId: string, entry: Entry, outcome: LoginOutcome, announce: boolean): void {
    this.#entries.delete(sessionId);
    if (announce && entry.waiters.size === 0)
      this.#undelivered.set(sessionId, { url: entry.request.url, outcome });
    for (const w of [...entry.waiters]) w(outcome);
    if (announce) this.#events.emit(LOGIN_REQUEST_EVENT, { id: sessionId, request: null });
  }
}
