/**
 * Actions on a session mirrored from a connected machine (issue #2765). The coordinator has already
 * authenticated the caller, checked the token's scope and its repository boundary — exactly as for
 * a local session — before anything here runs; this module then hands the request to the machine
 * that runs the session, with the machine's stored token, and passes the machine's answer back. The
 * machine stays the authority: it validates, acts and emits the frames the mirror relays.
 *
 * DENY BY DEFAULT. `FORWARDED` is the v1 allowlist; every other route on a mirrored session answers
 * 409 `remote_unsupported` and is never run — not here, where the session does not exist, and not
 * on the machine. A route added to the server tomorrow is therefore refused for remote sessions
 * until someone lists it here deliberately.
 *
 * The request the machine receives is rebuilt from the validated route, never copied: the path from
 * the session ID and the allowlisted leaf, the caller's query string, its body (multipart included)
 * and only its `content-type`/`accept` headers. The caller's cookie, credential and origin stay here.
 * What comes back is served from THIS origin, so it is held to what the route answers locally: a
 * download is always an attachment, everything else must be JSON — a machine never gets to render a
 * page here.
 *
 * Collective actions (`clear-merged`) ask every machine with `?host=local`, so two machines connected
 * to each other never pass a collective request back and forth, and report one outcome per machine:
 * a machine that cannot be reached makes the result partial rather than a claimed success.
 */
import {
  type FetchLike,
  getRemoteJson,
  isRecord,
  type ProbeFailure,
  requestRemote,
  type RemoteTarget,
} from "./client";
import type { MachineRoute } from "./sessions";

/** Per forwarded request, until the machine's response headers arrive. Archiving a session or
 *  computing a large diff can take a while; a download then streams without a limit. */
const FORWARD_TIMEOUT_MS = 60_000;

/** `<METHOD> <leaf>` with leaf = the path after `/api/sessions/:id/` (empty for the session itself). */
const FORWARDED: ReadonlySet<string> = new Set([
  "GET ",
  "POST resume",
  "POST relaunch",
  "POST variant",
  "POST replace",
  "POST terminal",
  "POST recommend-prompt",
  "POST recap/regenerate",
  "GET git",
  "GET git/reviewers",
  "POST git/pr",
  "POST git/merge",
  "POST git/ready",
  "POST git/draft",
  "POST git/close",
  "POST git/request-review",
  "POST review-pr",
  "POST review-hold",
  "POST review-cancel",
  "POST review-plan",
  "POST quota/resume",
  "POST quota/dismiss",
  "GET queue",
  "PUT queue",
  "POST queue/approve",
  "POST git/redeploy",
  "POST ack-manual-steps",
  "POST reply",
  "POST interrupt",
  "DELETE ", // archive
  "GET leftovers", // what archiving would leave running — the archive confirm reads it first
  "POST go",
  "POST answer-plan-questions",
  "POST answer-ask",
  "POST rename",
  "POST amendments",
  "PUT autopilot",
  "PUT automerge",
  "POST ready",
  "GET diff",
  "GET diff/annotations",
  "GET messages",
  "GET activity",
  "GET usage",
  "GET worktree",
  "GET worktree/download",
  "GET scratchpad",
  "GET scratchpad/download",
  "POST scratchpad/upload",
  // The preview (#2767): the machine starts and stops its own dev server and says where its
  // preview opens — a URL on ITS tailnet host and slot, never a port for this server to bind.
  "GET preview",
  "POST preview/start",
  "POST preview/stop",
]);

/** The native session surfaces need these snapshots from the owning machine. This is not a
 * general proxy: both the route and GET method must match before the stored token is used. */
export const MACHINE_READS: ReadonlySet<string> = new Set([
  "/api/git",
  "/api/activity",
  "/api/claude-alive",
  "/api/working-blocked",
  "/api/blocks",
  "/api/reviews",
  "/api/reviews/inflight",
  "/api/recaps",
  "/api/plan-gates",
  "/api/plan-gates/inflight",
  "/api/queues",
  "/api/repos",
  "/api/settings",
]);

const SESSION_ANSWERS = new Set([
  "GET ",
  "POST resume",
  "POST variant",
  "POST replace",
  "POST terminal",
  "PUT autopilot",
  "PUT automerge",
  "POST relaunch",
  "POST rename",
]);

export async function forwardMachineRead(url: URL, route: MachineRoute): Promise<Response> {
  if (!MACHINE_READS.has(url.pathname))
    return Response.json({ error: "not found" }, { status: 404 });
  if (!route.target) return machineFailure(route.host.name, "disconnected");
  const query = new URLSearchParams(url.search);
  query.set("host", "local");
  const result = await requestRemote(route.target, `${url.pathname}?${query}`, { method: "GET" });
  if (!result.ok) return machineFailure(route.host.name, result.failure.reason);
  const answer = passBack("", result.response);
  if (answer) return answer;
  await result.response.body?.cancel().catch(() => {});
  return machineFailure(route.host.name, "bad_response");
}

/** Request headers the machine needs to read the body and shape the answer; nothing else passes. */
const REQUEST_HEADERS = ["content-type", "accept"] as const;

export interface ForwardOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  annotateSession?: (
    session: Record<string, unknown> & { id: string },
  ) => Record<string, unknown> | undefined;
}

/** Why a machine gave no usable answer: the client's failure vocabulary, or a link that was down. */
type MachineFailure = ProbeFailure["reason"] | "disconnected";

/** The allowlisted leaf of `parts` (`["api","sessions",id,...leaf]`), or null when not forwarded. */
export function forwardedLeaf(method: string, parts: readonly string[]): string | null {
  const leaf = parts.slice(3).join("/");
  if (FORWARDED.has(`${method} ${leaf}`)) return leaf;
  // Retracting one amendment: exactly one id segment below `amendments`.
  if (method === "DELETE" && parts[3] === "amendments" && parts[4] && parts.length === 5)
    return leaf;
  return null;
}

function failureCode(reason: MachineFailure): string {
  if (reason === "timeout") return "machine_timeout";
  if (reason === "token_rejected" || reason === "token_scope" || reason === "token_restricted")
    return "machine_unauthorized";
  return "machine_unreachable";
}

const FAILURE_TEXT: Record<string, (machine: string) => string> = {
  machine_timeout: (machine) =>
    `${machine} did not answer in time; the action may still complete there`,
  machine_unauthorized: (machine) => `${machine} no longer accepts this Shepherd's token`,
  machine_unreachable: (machine) => `${machine} is not reachable`,
};

/** 502 for every machine that gave no usable answer — never its 401, which a caller here would
 *  read as its own login having expired. */
function machineFailure(machine: string, reason: MachineFailure): Response {
  const code = failureCode(reason);
  return Response.json(
    { error: FAILURE_TEXT[code]!(machine), code, machine, reason },
    { status: 502 },
  );
}

/**
 * Forward a request about a mirrored session to its machine and pass the answer back: status and
 * body as the machine sent them (a download streams), with only `content-type` and
 * `content-disposition`. `parts` is the dispatcher's split path; `route` the session's machine.
 */
export async function forwardSessionRequest(
  req: Request,
  url: URL,
  parts: readonly string[],
  route: MachineRoute,
  opts: ForwardOptions = {},
): Promise<Response> {
  const machine = route.host.name;
  const leaf = forwardedLeaf(req.method, parts);
  if (leaf === null) {
    return Response.json(
      {
        error: `not supported for a session on another machine (${machine})`,
        code: "remote_unsupported",
        machine,
      },
      { status: 409 },
    );
  }
  if (!route.target) return machineFailure(machine, "disconnected");
  const headers: Record<string, string> = {};
  for (const name of REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers[name] = value;
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const path = `/api/sessions/${parts[2]}${leaf ? `/${leaf}` : ""}${url.search}`;
  const res = await requestRemote(
    route.target,
    path,
    { method: req.method, headers, body: body?.byteLength ? body : undefined },
    { fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? FORWARD_TIMEOUT_MS },
  );
  if (!res.ok) return machineFailure(machine, res.failure.reason);
  if (res.response.ok && SESSION_ANSWERS.has(`${req.method} ${leaf}`)) {
    return annotatedSessionAnswer(
      res.response,
      route,
      opts,
      leaf === "relaunch" || leaf === "rename",
    );
  }
  const answer = passBack(leaf, res.response);
  if (answer) return answer;
  await res.response.body?.cancel().catch(() => {});
  return machineFailure(machine, "bad_response");
}

async function annotatedSessionAnswer(
  response: Response,
  route: MachineRoute,
  opts: ForwardOptions,
  nested: boolean,
): Promise<Response> {
  const machine = route.host.name;
  if (!/^application\/json(;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel().catch(() => {});
    return machineFailure(machine, "bad_response");
  }
  const body: unknown = await response.json().catch(() => null);
  const session = isRecord(body) && nested ? body.session : body;
  if (!isRecord(body) || !isRecord(session) || typeof session.id !== "string")
    return machineFailure(machine, "bad_response");
  const annotated = opts.annotateSession
    ? opts.annotateSession({ ...session, id: session.id })
    : {
        ...session,
        host: route.host,
        connection: route.connection ?? { state: "connected", since: Date.now() },
      };
  if (!annotated) return machineFailure(machine, "disconnected");
  return Response.json(nested ? { ...body, session: annotated } : annotated, {
    status: response.status,
    headers: { "x-content-type-options": "nosniff" },
  });
}

/**
 * The machine's answer as this server serves it, or null when it is not one a forwarded route
 * gives. Only the content type and a download's disposition pass, with `nosniff`: a successful
 * download is always an attachment (the machine's filename kept), and every other answer must be
 * JSON — so nothing a machine sends is ever rendered as a page on this origin.
 */
function passBack(leaf: string, res: Response): Response | null {
  const headers = new Headers({ "x-content-type-options": "nosniff" });
  const type = res.headers.get("content-type") ?? "";
  if (leaf.endsWith("/download") && res.ok) {
    const disposition = res.headers.get("content-disposition") ?? "";
    headers.set("content-type", type || "application/octet-stream");
    headers.set(
      "content-disposition",
      /^attachment(;|$)/i.test(disposition) ? disposition : "attachment",
    );
  } else if (/^application\/json(;|$)/i.test(type)) {
    headers.set("content-type", type);
  } else {
    return null;
  }
  return new Response(res.body, { status: res.status, headers });
}

// ── clear-merged across machines ────────────────────────────────────────────────────────────────

const CLEAR_MERGED_LOCAL = "/api/sessions/clear-merged?host=local";

/** One machine's part of a collective action. */
export interface MachineOutcome {
  instanceId: string;
  name: string;
  ok: boolean;
  reason?: MachineFailure;
}

export interface ClearMergedSummary {
  ids: string[];
  leftovers: number;
  leftoversById: Record<string, number>;
  probesUnavailable: boolean;
}

export interface ClearMergedResult {
  cleared: string[];
  leftovers: number;
}

function outcome(route: MachineRoute, reason?: MachineOutcome["reason"]): MachineOutcome {
  const { instanceId, name } = route.host;
  return reason ? { instanceId, name, ok: false, reason } : { instanceId, name, ok: true };
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

function parseSummary(body: unknown): ClearMergedSummary | null {
  if (!isRecord(body) || !isStringArray(body.ids) || !isRecord(body.leftoversById)) return null;
  const leftoversById: Record<string, number> = {};
  for (const id of body.ids) {
    const n = body.leftoversById[id];
    leftoversById[id] = typeof n === "number" && Number.isFinite(n) ? n : 0;
  }
  return {
    ids: body.ids,
    leftovers: Object.values(leftoversById).reduce((a, b) => a + b, 0),
    leftoversById,
    probesUnavailable: body.probesUnavailable === true,
  };
}

/** The merged sessions of this instance and of every machine, with one outcome per machine. */
export async function clearMergedSummaryAcross(
  local: ClearMergedSummary,
  machines: readonly MachineRoute[],
  opts: ForwardOptions = {},
): Promise<ClearMergedSummary & { machines: (MachineOutcome & { ids: string[] })[] }> {
  const answers = await Promise.all(
    machines.map(async (route): Promise<ClearMergedSummary | MachineFailure> => {
      if (!route.target) return "disconnected";
      const res = await getRemoteJson(route.target, CLEAR_MERGED_LOCAL, { fetch: opts.fetch });
      if (!res.ok) return res.failure.reason;
      return parseSummary(res.body) ?? "bad_response";
    }),
  );
  const merged: ClearMergedSummary = {
    ids: [...local.ids],
    leftovers: local.leftovers,
    leftoversById: { ...local.leftoversById },
    probesUnavailable: local.probesUnavailable,
  };
  const outcomes = machines.map((route, i) => {
    const answer = answers[i]!;
    if (typeof answer === "string") return { ...outcome(route, answer), ids: [] };
    merged.ids.push(...answer.ids);
    merged.leftovers += answer.leftovers;
    Object.assign(merged.leftoversById, answer.leftoversById);
    merged.probesUnavailable ||= answer.probesUnavailable;
    return { ...outcome(route), ids: answer.ids };
  });
  return { ...merged, machines: outcomes };
}

function parseResult(body: unknown): ClearMergedResult | null {
  if (!isRecord(body) || !isStringArray(body.cleared)) return null;
  const leftovers = typeof body.leftovers === "number" ? body.leftovers : 0;
  return { cleared: body.cleared, leftovers };
}

async function clearOnMachine(
  target: RemoteTarget,
  ids: string[] | null,
  opts: ForwardOptions,
): Promise<ClearMergedResult | MachineFailure> {
  const res = await requestRemote(
    target,
    CLEAR_MERGED_LOCAL,
    ids === null
      ? { method: "POST" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids }),
        },
    { fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? FORWARD_TIMEOUT_MS },
  );
  if (!res.ok) return res.failure.reason;
  if (!res.response.ok) {
    await res.response.body?.cancel().catch(() => {});
    return "bad_response";
  }
  return parseResult(await res.response.json().catch(() => null)) ?? "bad_response";
}

/**
 * Clear merged sessions on every machine in `groups` (`ids: null` = the machine's whole merged
 * set) on top of this instance's own `local` result. Each machine re-validates its ids itself.
 * `partial` is true when any machine gave no usable answer — its `requested` ids are not cleared
 * as far as this server knows.
 */
export async function clearMergedAcross(
  local: ClearMergedResult,
  groups: readonly { route: MachineRoute; ids: string[] | null }[],
  opts: ForwardOptions = {},
): Promise<
  ClearMergedResult & {
    partial: boolean;
    machines: (MachineOutcome & { requested: string[]; cleared: string[] })[];
  }
> {
  const results = await Promise.all(
    groups.map(({ route, ids }) =>
      route.target ? clearOnMachine(route.target, ids, opts) : ("disconnected" as const),
    ),
  );
  let leftovers = local.leftovers;
  const machines = groups.map(({ route, ids }, i) => {
    const result = results[i]!;
    const requested = ids ?? [];
    if (typeof result === "string") return { ...outcome(route, result), requested, cleared: [] };
    leftovers += result.leftovers;
    return { ...outcome(route), requested, cleared: result.cleared };
  });
  return {
    cleared: [...local.cleared, ...machines.flatMap((m) => m.cleared)],
    leftovers,
    partial: machines.some((m) => !m.ok),
    machines,
  };
}
