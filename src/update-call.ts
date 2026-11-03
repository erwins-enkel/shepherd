/**
 * Who started a self-update (#3623). Every `POST /api/update`, its relay to a connected machine and
 * every `deploy/update.sh` run leaves one `update_call` signal and one `[update]` log line, so "who
 * updated me?" has an answer after the restart that update causes.
 *
 * Records hold structured fields only. The one thing taken from the request body is the strict
 * `discard` boolean, and `reason` is a fixed code rather than an error text, so no token, cookie,
 * signature or prompt can end up here.
 *
 * Session attribution (`peer-uid.ts`, the journal's `sessionId`) reads the marker every agent
 * process inherits. It names the origin in the ordinary case and is no security control: a process
 * can drop the marker.
 */
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { config } from "./config";
import { verifySessionCookie } from "./operator-auth";
import { HOST_SIGNAL_REPO } from "./signals";
import type { SessionStore } from "./store";
import { isAuthorized } from "./validate";

export type UpdateClient = "cli" | "relay" | "other";

export type UpdateCaller =
  | { kind: "surface"; ua: string | null }
  | { kind: "token"; name: string; client: UpdateClient; ua: string | null }
  | { kind: "env_token"; client: UpdateClient; ua: string | null }
  | { kind: "script"; tty: boolean }
  | { kind: "app" }
  | { kind: "unknown" };

/** `applied` = `update.sh` got past its pull step, so `to` is the commit it is now on. */
export type UpdateCallOutcome = "started" | "nothing_to_do" | "rejected" | "applied";

export type UpdateCallReason =
  | "no_update"
  | "already_running"
  | "stale"
  | "launch_failed"
  | "unavailable"
  | "bad_request"
  | "not_found"
  | `remote_${string}`;

export interface UpdateCallSession {
  id: string;
  /** null when the id names no session this Shepherd knows. */
  desig: string | null;
}

export interface UpdateCallRecord {
  v: 1;
  requestId: string | null;
  at: number;
  outcome: UpdateCallOutcome;
  reason: UpdateCallReason | null;
  from: string | null;
  to: string | null;
  discard: boolean;
  caller: UpdateCaller;
  session: UpdateCallSession | null;
  /** Set when this call updates another machine: never this Shepherd's own update. */
  machine: { id: string; name: string | null } | null;
}

const UA_MAX = 200;
/** The largest time a Date can hold; past it `toISOString` throws. */
const MAX_DATE_MS = 8.64e15;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{4,40}$/;
/** Newest entries looked at: rejected calls share the kind and must not hide the last real update. */
const RECENT_LIMIT = 200;
/** A journal never holds more than a few lines; anything past this is not ours to read. */
const JOURNAL_MAX_BYTES = 64 * 1024;
/** Matches `DEPLOY_STALE_MS` in update.ts: an older handoff cannot still be the one the app runs. */
const APP_PAIRING_WINDOW_MS = 15 * 60_000;

export const RELAY_USER_AGENT_PREFIX = "shepherd-relay/";
const CLI_USER_AGENT_PREFIX = "shepherd-cli/";

// Built from char codes so no control literal sits in source.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);

/** A User-Agent as a record may hold it: caller-chosen text, so bounded and free of control chars. */
function sanitizeUserAgent(raw: string | null): string | null {
  const clean = raw?.replace(CONTROL_CHARS, "").trim().slice(0, UA_MAX);
  return clean ? clean : null;
}

function clientFrom(ua: string | null): UpdateClient {
  if (ua?.startsWith(CLI_USER_AGENT_PREFIX)) return "cli";
  if (ua?.startsWith(RELAY_USER_AGENT_PREFIX)) return "relay";
  return "other";
}

/** The credential that passed the gate, in `checkAuth`'s order. `token` is what that gate verified;
 *  an ungated app (un-bootstrapped tests) has no caller to name. */
export function resolveUpdateCaller(
  req: Request,
  token: { id: string } | null | undefined,
  tokenName: (id: string) => string | null,
): UpdateCaller {
  const ua = sanitizeUserAgent(req.headers.get("user-agent"));
  if (config.cookieSecret && verifySessionCookie(config.cookieSecret, req.headers.get("cookie")).ok)
    return { kind: "surface", ua };
  if (config.token !== null && isAuthorized(req.headers.get("authorization"), config.token))
    return { kind: "env_token", client: clientFrom(ua), ua };
  if (token)
    return { kind: "token", name: tokenName(token.id) ?? token.id, client: clientFrom(ua), ua };
  return { kind: "unknown" };
}

/** A session marker as a record names it; anything but a session id is not one. */
export function resolveUpdateSession(
  store: Pick<SessionStore, "get">,
  id: string | null | undefined,
): UpdateCallSession | null {
  if (!id || !UUID_RE.test(id)) return null;
  return { id, desig: store.get(id)?.desig ?? null };
}

const uaField = (ua: string | null) => (ua ? ` ua=${JSON.stringify(ua)}` : "");

function callerLogFields(caller: UpdateCaller): string {
  switch (caller.kind) {
    case "surface":
      return `caller=surface${uaField(caller.ua)}`;
    case "token":
      return `caller=token token=${JSON.stringify(caller.name)} client=${caller.client}${uaField(caller.ua)}`;
    case "env_token":
      return `caller=env_token client=${caller.client}${uaField(caller.ua)}`;
    case "script":
      return `caller=script tty=${caller.tty}`;
    default:
      return `caller=${caller.kind}`;
  }
}

/** One log line. Names and clients are JSON-quoted: caller-chosen text that may hold a newline. */
function logLine(r: UpdateCallRecord): string {
  const parts = [
    `[update] at=${new Date(r.at).toISOString()} outcome=${r.outcome}`,
    callerLogFields(r.caller),
    r.reason && `reason=${r.reason}`,
    r.session && `session=${JSON.stringify(r.session.desig ?? r.session.id)}`,
    r.machine && `machine=${JSON.stringify(r.machine.name ?? r.machine.id)}`,
    r.from && `from=${r.from}`,
    r.to && `to=${r.to}`,
    r.discard && "discard=true",
    r.requestId && `request=${r.requestId}`,
  ];
  return parts.filter(Boolean).join(" ");
}

export function recordUpdateCall(
  store: Pick<SessionStore, "addSignal">,
  record: UpdateCallRecord,
): void {
  store.addSignal({
    repoPath: HOST_SIGNAL_REPO,
    sessionId: record.session?.id ?? null,
    kind: "update_call",
    payload: JSON.stringify(record),
  });
  console.log(logLine(record));
}

function parseRecord(payload: string): UpdateCallRecord | null {
  try {
    const value = JSON.parse(payload) as Partial<UpdateCallRecord> | null;
    return value?.v === 1 && typeof value.outcome === "string" && typeof value.at === "number"
      ? (value as UpdateCallRecord)
      : null;
  } catch {
    return null;
  }
}

function recentRecords(store: Pick<SessionStore, "listSignalsByKind">): UpdateCallRecord[] {
  return store
    .listSignalsByKind("update_call", 0, RECENT_LIMIT)
    .flatMap((s) => parseRecord(s.payload) ?? []);
}

/** This Shepherd's own last update. A relay record describes another machine, so it never counts. */
export function lastUpdateCall(
  store: Pick<SessionStore, "listSignalsByKind">,
): UpdateCallRecord | null {
  return (
    recentRecords(store).find(
      (r) => r.machine === null && (r.outcome === "started" || r.outcome === "applied"),
    ) ?? null
  );
}

interface JournalLine {
  at: number;
  from: string;
  to: string;
  tty: boolean;
  app: boolean;
  requestId: string | null;
  sessionId: string | null;
}

const optionalUuid = (value: unknown): string | null | undefined => {
  if (value === undefined) return null;
  return typeof value === "string" && UUID_RE.test(value) ? value : undefined;
};

/** Any same-user process can append to the journal, so every field is checked before it counts. */
function parseJournalLine(line: string): JournalLine | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const { at, from, to, tty, app } = v;
  const requestId = optionalUuid(v.requestId);
  const sessionId = optionalUuid(v.sessionId);
  if (requestId === undefined || sessionId === undefined) return null;
  if (typeof at !== "number" || !(at > 0 && at <= MAX_DATE_MS)) return null;
  if (typeof from !== "string" || !SHA_RE.test(from)) return null;
  if (typeof to !== "string" || !SHA_RE.test(to)) return null;
  if (typeof tty !== "boolean" || typeof app !== "boolean") return null;
  return { at, from, to, tty, app, requestId, sessionId };
}

/** The server-recorded call a journal line finishes, if any. The app's handoff carries no request
 *  id, so an app run pairs with the newest local `started` that nothing has finished yet. */
function matchingStarted(
  recent: UpdateCallRecord[],
  line: JournalLine,
): UpdateCallRecord | undefined {
  const local = recent.filter((r) => r.machine === null);
  if (line.requestId)
    return local.find((r) => r.outcome === "started" && r.requestId === line.requestId);
  if (!line.app) return undefined;
  const finished = new Set(local.flatMap((r) => (r.outcome === "applied" ? [r.requestId] : [])));
  return local.find(
    (r) =>
      r.outcome === "started" &&
      !finished.has(r.requestId) &&
      // The script stamps whole seconds, so a line can read just before the start it follows.
      line.at + 1000 >= r.at &&
      line.at - r.at <= APP_PAIRING_WINDOW_MS,
  );
}

function applyJournalLine(
  store: Pick<SessionStore, "addSignal" | "get" | "listSignalsByKind">,
  line: JournalLine,
): void {
  const started = matchingStarted(recentRecords(store), line);
  const caller: UpdateCaller = line.app ? { kind: "app" } : { kind: "script", tty: line.tty };
  recordUpdateCall(store, {
    v: 1,
    requestId: started?.requestId ?? line.requestId,
    at: line.at,
    outcome: "applied",
    reason: null,
    from: line.from,
    to: line.to,
    discard: started?.discard ?? false,
    caller: started?.caller ?? caller,
    session: started ? started.session : resolveUpdateSession(store, line.sessionId),
    machine: null,
  });
}

/** Reads the claimed file (bounded, never through a symlink) and removes it BEFORE any line is
 *  applied: a crash in between loses a line rather than duplicating it on the next round. */
async function consumeClaimed(claimed: string): Promise<string[]> {
  let handle;
  try {
    handle = await open(claimed, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, JOURNAL_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    // A cut read starts mid-line.
    return size > JOURNAL_MAX_BYTES ? lines.slice(1) : lines;
  } finally {
    await handle.close();
    await unlink(claimed).catch(() => {});
  }
}

/** Take over what `deploy/update.sh` appended and record it. Claiming by rename leaves a concurrent
 *  run free to start a new file. Never throws on a missing or unreadable journal. Not reentrant:
 *  one caller, one tick at a time. */
export async function ingestUpdateJournal(
  store: Pick<SessionStore, "addSignal" | "get" | "listSignalsByKind">,
  path: string,
): Promise<void> {
  const claimed = `${path}.ingesting`;
  const lines = await consumeClaimed(claimed); // left behind by a crash
  const claimedNow = await rename(path, claimed).then(
    () => true,
    () => false,
  );
  if (claimedNow) lines.push(...(await consumeClaimed(claimed)));
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = parseJournalLine(raw);
    if (!line) {
      console.warn("[update] dropped an invalid update-journal line");
      continue;
    }
    // The file is gone by now, so one line that fails must not take the rest with it.
    try {
      applyJournalLine(store, line);
    } catch (err) {
      console.warn("[update] could not record an update-journal line:", err);
    }
  }
}
