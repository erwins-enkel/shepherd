/**
 * Opt-in gh permission grants for sandboxed task sessions in GitHub App mode (issue #4119).
 *
 * The default App token (`AGENT_GH_APP_PERMISSIONS`) has no `workflows`, so a push that touches
 * `.github/workflows/*` is refused. Instead of improvising, the agent raises a **gh permission
 * request** (`gh_request_permission` MCP tool → {@link GhPermissionRequestService}); the operator
 * answers Grant or Deny. A grant ({@link GhGrantService}) is persisted on the session
 * (`sessions.ghGrantsJson`), audited (`gh_grant_log`), and widens only that session's minted token —
 * the live membrane file is re-minted at once (`GhHostsRefresher.refreshNow`) and on every refresh
 * after. Revoke and archive write a default token back and then revoke the session's widened
 * tokens at GitHub (`releaseSession`), so a copied token stops working at once (or, if GitHub
 * can't be reached, when it expires within 1 h).
 *
 * Requests live in memory on purpose, like Login Requests (src/login-request.ts): one open request
 * per session, gone on restart (which fails the agent's in-flight tool call, so it re-asks). The
 * agent's wait is a bounded long-poll — Claude Code's HTTP MCP transport aborts a call at 60s.
 */
import { randomUUID } from "node:crypto";
import {
  GithubAppConfigError,
  type AgentGhAppTokenSource,
  type GhOptInPermission,
} from "./agent-gh-app";
import type { GhGrant } from "./agent-gh-env";
import type { EventHub } from "./events";
import type { GhHostsRefresher } from "./membrane-state";
import type { SessionStore } from "./store";

export interface GhPermissionRequest {
  id: string;
  permission: GhOptInPermission;
  reason: string;
  /** The files the agent says need the permission (e.g. `.github/workflows/ci.yml`); may be []. */
  files: string[];
  createdAt: number;
}

export type GhPermissionOutcome = "granted" | "denied";
export type GhPermissionWaitResult = GhPermissionOutcome | "pending";

/** Event carrying a session's current request (`null` once resolved or dropped). */
export const GH_PERMISSION_REQUEST_EVENT = "session:gh-permission-request";
/** Event carrying a session's active grants after every grant / revoke / archive. */
export const GH_GRANTS_EVENT = "session:gh-grants";

interface Entry {
  request: GhPermissionRequest;
  waiters: Set<(outcome: GhPermissionOutcome) => void>;
}

export type GhPermissionRequestState =
  { status: "open"; request: GhPermissionRequest } | { status: GhPermissionOutcome };

export class GhPermissionRequestService {
  readonly #entries = new Map<string, Entry>();
  /** An outcome no waiting call received (answered between two long-polls), held for the agent's
   *  next call on the same permission. */
  readonly #undelivered = new Map<
    string,
    { permission: GhOptInPermission; outcome: GhPermissionOutcome }
  >();
  readonly #events: Pick<EventHub, "emit">;
  readonly #now: () => number;

  constructor(deps: { events: Pick<EventHub, "emit" | "subscribe">; now?: () => number }) {
    this.#events = deps.events;
    this.#now = deps.now ?? Date.now;
    deps.events.subscribe((event, data) => {
      if (event !== "session:archived") return;
      const id = (data as { id: string }).id;
      this.resolve(id, "denied");
      this.#undelivered.delete(id);
    });
  }

  get(sessionId: string): GhPermissionRequest | null {
    return this.#entries.get(sessionId)?.request ?? null;
  }

  /** Every open request, keyed by session id (bootstrap GET). */
  snapshot(): Record<string, GhPermissionRequest> {
    return Object.fromEntries([...this.#entries].map(([id, e]) => [id, e.request]));
  }

  /**
   * Open (or re-attach to) the session's request for `permission`. While one is open for the same
   * permission it is returned unchanged (its reason/files kept); another permission replaces it.
   * A request for this permission answered while no call waited returns that outcome, once.
   */
  request(
    sessionId: string,
    permission: GhOptInPermission,
    reason: string,
    files: string[],
  ): GhPermissionRequestState {
    const undelivered = this.#undelivered.get(sessionId);
    this.#undelivered.delete(sessionId);
    const existing = this.#entries.get(sessionId);
    if (existing?.request.permission === permission)
      return { status: "open", request: existing.request };
    if (!existing && undelivered?.permission === permission) return { status: undelivered.outcome };
    if (existing) this.#settle(sessionId, existing, "denied", false);
    const request: GhPermissionRequest = {
      id: randomUUID(),
      permission,
      reason,
      files,
      createdAt: this.#now(),
    };
    this.#entries.set(sessionId, { request, waiters: new Set() });
    this.#events.emit(GH_PERMISSION_REQUEST_EVENT, { id: sessionId, request });
    return { status: "open", request };
  }

  /** Wait up to `ms` for request `requestId` to resolve; `pending` when the window runs out. A
   *  request no longer open reads `denied`. `signal` ends only the wait, never the request. */
  wait(
    sessionId: string,
    requestId: string,
    ms: number,
    signal?: AbortSignal,
  ): Promise<GhPermissionWaitResult> {
    const entry = this.#entries.get(sessionId);
    if (!entry || entry.request.id !== requestId) return Promise.resolve("denied");
    return new Promise((resolve) => {
      const finish = (result: GhPermissionWaitResult) => {
        clearTimeout(timer);
        entry.waiters.delete(onOutcome);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onOutcome = (outcome: GhPermissionOutcome) => finish(outcome);
      const onAbort = () => finish("pending");
      const timer = setTimeout(() => finish("pending"), ms);
      entry.waiters.add(onOutcome);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Resolve the session's open request. False when it has none. */
  resolve(sessionId: string, outcome: GhPermissionOutcome): boolean {
    const entry = this.#entries.get(sessionId);
    if (!entry) return false;
    this.#settle(sessionId, entry, outcome, true);
    return true;
  }

  #settle(sessionId: string, entry: Entry, outcome: GhPermissionOutcome, announce: boolean): void {
    this.#entries.delete(sessionId);
    if (announce && entry.waiters.size === 0)
      this.#undelivered.set(sessionId, { permission: entry.request.permission, outcome });
    for (const w of [...entry.waiters]) w(outcome);
    if (announce) this.#events.emit(GH_PERMISSION_REQUEST_EVENT, { id: sessionId, request: null });
  }
}

/** Why a grant or revoke was refused — `code` is stable for clients, `error` is for the operator. */
export type GhGrantResult =
  | { ok: true }
  | {
      ok: false;
      status: 404 | 409 | 502;
      code:
        | "not-found"
        | "not-sandboxed"
        | "app-mode-off"
        | "no-membrane-token"
        | "installation-lacks-permission"
        | "mint-failed"
        | "not-granted";
      error: string;
    };

export interface GhGrantServiceDeps {
  store: Pick<SessionStore, "get" | "setGhGrants" | "logGhGrant">;
  events?: Pick<EventHub, "emit">;
  requests: Pick<GhPermissionRequestService, "get" | "resolve">;
  /** The App token source the spawn path and the refresher share (its minter + caches). */
  source: AgentGhAppTokenSource;
  refresher: Pick<GhHostsRefresher, "isRunning" | "refreshNow">;
  /** Is GitHub App mode configured? */
  appModeConfigured: () => boolean;
  now?: () => number;
}

const refuse = (
  status: 404 | 409 | 502,
  code: Extract<GhGrantResult, { ok: false }>["code"],
  error: string,
): GhGrantResult => ({ ok: false, status, code, error });

export class GhGrantService {
  /** Per-session tail of grant/revoke/archive work, so two never interleave. */
  readonly #chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: GhGrantServiceDeps) {}

  /** Grant `permission` to `sessionId` (the operator answered its request with Grant). */
  grant(sessionId: string, permission: GhOptInPermission, actor: string): Promise<GhGrantResult> {
    return this.#serial(sessionId, () => this.#grant(sessionId, permission, actor));
  }

  /** Revoke `permission` from `sessionId`; its widened token is revoked at GitHub too. */
  revoke(sessionId: string, permission: GhOptInPermission, actor: string): Promise<GhGrantResult> {
    return this.#serial(sessionId, () => this.#revoke(sessionId, permission, actor));
  }

  /** Archive ends every grant. Call after the session's refresher loop has stopped. Never throws. */
  endForArchive(sessionId: string): Promise<void> {
    return this.#serial(sessionId, () => this.#endForArchive(sessionId));
  }

  #serial<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn);
    // The chain only orders operations (it never rejects); each caller gets `next`'s own outcome.
    const tail: Promise<void> = next
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        if (this.#chains.get(sessionId) === tail) this.#chains.delete(sessionId);
      });
    this.#chains.set(sessionId, tail);
    return next;
  }

  #now(): number {
    return (this.deps.now ?? Date.now)();
  }

  #emit(sessionId: string, ghGrants: GhGrant[]): void {
    this.deps.events?.emit(GH_GRANTS_EVENT, { id: sessionId, ghGrants });
  }

  /** The preconditions a grant needs, or the refusal. */
  #precheck(sessionId: string): GhGrantResult | null {
    const session = this.deps.store.get(sessionId);
    if (!session || session.archivedAt) return refuse(404, "not-found", "session not found");
    if (session.sandboxApplied !== "standard" && session.sandboxApplied !== "autonomous")
      return refuse(409, "not-sandboxed", "only sandboxed sessions use the App token");
    if (!this.deps.appModeConfigured())
      return refuse(409, "app-mode-off", "GitHub App mode is not configured");
    if (!this.deps.refresher.isRunning(sessionId))
      return refuse(409, "no-membrane-token", "the session's membrane has no App token to widen");
    return null;
  }

  async #grant(
    sessionId: string,
    permission: GhOptInPermission,
    actor: string,
  ): Promise<GhGrantResult> {
    const session = this.deps.store.get(sessionId);
    if (session?.ghGrants?.some((g) => g.permission === permission)) {
      this.deps.requests.resolve(sessionId, "granted");
      return { ok: true };
    }
    const refused = this.#precheck(sessionId);
    if (refused || !session) return refused ?? refuse(404, "not-found", "session not found");
    const extra = [...(session.ghGrants ?? []).map((g) => g.permission), permission];
    const preflight = await this.#preflight(session.repoPath, sessionId, permission, extra);
    if (preflight) return preflight;
    const reason = this.deps.requests.get(sessionId)?.reason ?? null;
    const grants: GhGrant[] = [
      ...(session.ghGrants ?? []),
      { permission, grantedAt: this.#now(), grantedBy: actor },
    ];
    this.deps.store.setGhGrants(sessionId, grants);
    this.#log(sessionId, permission, "grant", actor, reason);
    this.#emit(sessionId, grants);
    await this.deps.refresher.refreshNow(sessionId);
    this.deps.requests.resolve(sessionId, "granted");
    return { ok: true };
  }

  /** Mint the widened token once before persisting anything: a 422 means the App installation
   *  itself lacks the permission, which only the operator can fix on GitHub. */
  async #preflight(
    repoPath: string,
    sessionId: string,
    permission: GhOptInPermission,
    extra: GhOptInPermission[],
  ): Promise<GhGrantResult | null> {
    try {
      const minted = await this.deps.source(repoPath, { extra, sessionId });
      if (!minted) return refuse(409, "app-mode-off", "GitHub App mode is not configured");
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof GithubAppConfigError && err.status === 422) {
        return refuse(
          409,
          "installation-lacks-permission",
          `The GitHub App installation lacks \`${permission}: write\`. Grant it on the App installation first. (${message})`,
        );
      }
      return refuse(502, "mint-failed", message);
    }
  }

  async #revoke(
    sessionId: string,
    permission: GhOptInPermission,
    actor: string,
  ): Promise<GhGrantResult> {
    const session = this.deps.store.get(sessionId);
    if (!session) return refuse(404, "not-found", "session not found");
    const current = session.ghGrants ?? [];
    if (!current.some((g) => g.permission === permission))
      return refuse(404, "not-granted", `\`${permission}\` is not granted to this session`);
    const remaining = current.filter((g) => g.permission !== permission);
    this.deps.store.setGhGrants(sessionId, remaining);
    this.#log(sessionId, permission, "revoke", actor, null);
    this.#emit(sessionId, remaining);
    if (remaining.length === 0) {
      // The file gets a default token first; only then are the widened ones revoked at GitHub.
      await this.deps.refresher.refreshNow(sessionId);
      await this.#release(sessionId, permission);
    } else {
      // Releasing revokes EVERY widened token of the session — the remaining set's fresh one too,
      // so release first and mint the remaining set afterwards.
      await this.#release(sessionId, permission);
      await this.deps.refresher.refreshNow(sessionId);
    }
    return { ok: true };
  }

  async #endForArchive(sessionId: string): Promise<void> {
    const grants = this.deps.store.get(sessionId)?.ghGrants ?? [];
    if (grants.length > 0) {
      this.deps.store.setGhGrants(sessionId, []);
      for (const g of grants) this.#log(sessionId, g.permission, "archive", "shepherd", null);
      this.#emit(sessionId, []);
    }
    // Nothing granted and nothing revoked (the common archive) leaves no audit row.
    const permissions = grants.map((g) => g.permission).join(",") || "-";
    await this.#release(sessionId, permissions, grants.length === 0);
  }

  /** Revoke the session's widened tokens at GitHub and audit the outcome (`quietIfNone`: skip
   *  the row when there was nothing to revoke). Never throws. */
  async #release(sessionId: string, permission: string, quietIfNone = false): Promise<void> {
    const r = await this.deps.source.releaseSession(sessionId);
    if (r.ok && r.revoked === 0 && quietIfNone) return;
    if (r.ok) {
      this.#log(sessionId, permission, "github-revoke", "shepherd", `${r.revoked} token(s)`);
      return;
    }
    console.warn(
      `[sandbox] ${sessionId}: widened gh token not revoked at GitHub (expires within 1 h): ${r.failure}`,
    );
    this.#log(sessionId, permission, "github-revoke-failed", "shepherd", r.failure);
  }

  #log(
    sessionId: string,
    permission: string,
    action: string,
    actor: string,
    detail: string | null,
  ): void {
    this.deps.store.logGhGrant({ sessionId, permission, action, actor, detail, at: this.#now() });
  }
}
