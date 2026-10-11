/**
 * Idempotent acceptance of `POST /api/sessions` (#2761).
 *
 * A client that names a submission with an `Idempotency-Key` header gets it run AT MOST ONCE. The
 * key is reserved in SQLite (`dispatches`) after validation but BEFORE the hold gate or the spawn,
 * so a retry after a lost answer, a concurrent duplicate, or a retry across a server restart
 * replays the first outcome instead of starting a second agent. `GET /api/dispatches/:id` reports
 * that outcome; `DELETE /api/dispatches/:id` withdraws a key that has not arrived yet, so a late
 * delivery of it never starts.
 *
 * Rules a caller can rely on:
 * - Same key + same body (canonical-JSON hash) → the same result: the session (201, current
 *   state) or the held task (200). A different body under a used key → 409, nothing runs.
 * - An outcome is FINAL for its key — a failed start is replayed, never retried. A new attempt
 *   needs a new key; only 404 ("never arrived") means "send it again".
 * - A key still `pending` with no request in this process running it was interrupted by a restart.
 *   It settles as failed (`dispatch_interrupted`) and is never re-spawned: a spawn that died midway
 *   may have left an agent running, and a second one is exactly what this module exists to prevent.
 */
import { createHash } from "node:crypto";
import type { SessionStore } from "./store";
import type { DispatchOutcome, DispatchRecord, DispatchState } from "./types";

/** The request header naming a submission (lowercase, as `Headers.get` compares). */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** Bounded alphabet and length: the key becomes a primary key and a URL path segment. */
const DISPATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

type DispatchStore = Pick<
  SessionStore,
  | "reserveDispatch"
  | "getDispatch"
  | "settleDispatch"
  | "cancelUnknownDispatch"
  | "get"
  | "countHeldTasks"
>;

/** What `GET /api/dispatches/:id` answers: the record minus its internals, null fields omitted. */
export interface DispatchView {
  id: string;
  state: DispatchState;
  sessionId?: string;
  heldId?: string;
  reason?: string;
  code?: string;
  createdAt: number;
  updatedAt: number;
}

export function isValidDispatchId(id: string): boolean {
  return DISPATCH_ID_RE.test(id);
}

/** The key a create names: undefined without the header, null when it is malformed. The IETF draft
 *  defines the field as an sf-string (`"…"`), so one pair of surrounding quotes is accepted too. */
export function readDispatchKey(raw: string | null): string | null | undefined {
  if (raw === null) return undefined;
  const key = /^"(.*)"$/.exec(raw)?.[1] ?? raw;
  return isValidDispatchId(key) ? key : null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, canonical(obj[k])]),
  );
}

/** sha256 of the body with object keys sorted, so a retry that re-serializes the same fields in a
 *  different order is still "the same payload". */
export function payloadHash(body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(body)))
    .digest("hex");
}

// ── in-flight registry ────────────────────────────────────────────────────────
//
// Process-wide, like the spawn registry in src/spawn-progress.ts: an entry lives exactly as long as
// the request that reserved the key, and is what a concurrent duplicate waits on. Its absence for a
// `pending` row is how an interrupted dispatch is recognized — this process never ran it.

const inflight = new Map<string, Promise<void>>();

const NO_OUTCOME = { sessionId: null, heldId: null, reason: null, code: null, httpStatus: null };

function failure(reason: string, code: string | null, httpStatus: number): DispatchOutcome {
  return { ...NO_OUTCOME, state: "failed", reason, code, httpStatus };
}

/** Read the outcome off the create's own response: 201 + session, 200 + held task, else failed. */
function outcomeOf(status: number, body: unknown): DispatchOutcome {
  const b = (body ?? {}) as { id?: unknown; held?: unknown; error?: unknown; code?: unknown };
  const id = typeof b.id === "string" ? b.id : null;
  if (status === 201 && id) return { ...NO_OUTCOME, state: "started", sessionId: id };
  if (status === 200 && b.held === true && id) return { ...NO_OUTCOME, state: "held", heldId: id };
  const reason = typeof b.error === "string" ? b.error : `create answered ${status}`;
  return failure(reason, typeof b.code === "string" ? b.code : null, status);
}

/** The record, after settling a `pending` row that no request in THIS process is running: the
 *  process that reserved it died before it learned the outcome. */
function current(store: DispatchStore, id: string): DispatchRecord | null {
  const d = store.getDispatch(id);
  if (d?.state !== "pending" || inflight.has(id)) return d;
  store.settleDispatch(
    id,
    failure("Shepherd restarted before this start finished", "dispatch_interrupted", 409),
  );
  return store.getDispatch(id);
}

function toView(d: DispatchRecord): DispatchView {
  const { id, state, sessionId, heldId, reason, code, createdAt, updatedAt } = d;
  const fields = { id, state, sessionId, heldId, reason, code, createdAt, updatedAt };
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null),
  ) as unknown as DispatchView;
}

/** JSON response; a replay is marked with `Idempotent-Replayed: true` so a client can tell it from
 *  a fresh answer. */
function respond(body: unknown, status: number, replayed = true): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (replayed) headers["Idempotent-Replayed"] = "true";
  return new Response(JSON.stringify(body), { status, headers });
}

/** Answer a retry from the stored outcome — the same result the first request got. */
function replay(store: DispatchStore, id: string): Response {
  const d = current(store, id)!;
  if (d.state === "started") {
    const session = d.sessionId ? store.get(d.sessionId) : null;
    if (session) return respond(session, 201);
    return respond(
      {
        error: "the session this dispatch started no longer exists",
        code: "dispatch_session_gone",
        sessionId: d.sessionId,
      },
      409,
    );
  }
  if (d.state === "held")
    return respond({ held: true, id: d.heldId, count: store.countHeldTasks() }, 200);
  return respond({ error: d.reason, ...(d.code && { code: d.code }) }, d.httpStatus ?? 409);
}

async function answerRetry(
  store: DispatchStore,
  claim: { id: string; payloadHash: string },
): Promise<Response> {
  const stored = store.getDispatch(claim.id)?.payloadHash ?? null;
  // A key cancelled before it arrived has no body to compare: whatever arrives under it is refused.
  if (stored !== null && stored !== claim.payloadHash)
    return respond(
      {
        error: "this Idempotency-Key was already used with a different request body",
        code: "dispatch_payload_mismatch",
      },
      409,
      false,
    );
  // A concurrent first attempt is still starting: wait for its outcome rather than racing it.
  await inflight.get(claim.id);
  return replay(store, claim.id);
}

/**
 * Run `create` at most once per key. The first request for a key runs it and gets its response
 * back untouched; every later one (same body) gets that outcome replayed.
 */
export async function runDispatch(
  store: DispatchStore,
  claim: { id: string; payloadHash: string; repoPath: string },
  create: () => Promise<Response>,
): Promise<Response> {
  if (!store.reserveDispatch({ ...claim, now: Date.now() })) return answerRetry(store, claim);
  // Registered in the same tick as the reservation — no await in between — so a duplicate can
  // never see the row without also seeing that it is in flight.
  let done!: () => void;
  inflight.set(claim.id, new Promise<void>((resolve) => (done = resolve)));
  try {
    const res = await create();
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => null);
    store.settleDispatch(claim.id, outcomeOf(res.status, body));
    return res;
  } catch (e) {
    // No-op when already settled; otherwise the create blew up before it could answer.
    store.settleDispatch(claim.id, failure("create failed", null, 500));
    throw e;
  } finally {
    inflight.delete(claim.id);
    done();
  }
}

/** `GET /api/dispatches/:id` — null when the key never arrived. */
export function dispatchView(store: DispatchStore, id: string): DispatchView | null {
  const d = current(store, id);
  return d && toView(d);
}

/**
 * `DELETE /api/dispatches/:id` — make sure the key can never start a session. `canceled` is true
 * when that now holds: an unknown key is reserved as cancelled, and an already-failed one stays
 * failed. False once the key has arrived (pending, started or held) — the caller learns which.
 */
export function cancelDispatch(
  store: DispatchStore,
  id: string,
): { canceled: boolean; dispatch: DispatchView } {
  store.cancelUnknownDispatch(id);
  const d = current(store, id)!;
  return { canceled: d.state === "failed", dispatch: toView(d) };
}
