/**
 * The one place a Shepherd talks HTTP to another Shepherd (issue #2759). Everything that reaches a
 * connected machine — the connection probe, the session mirror's snapshot (#2762), the hand-off of
 * a new task (#2763) and its attachments (#2766) — goes through `getRemoteJson` /
 * `postRemoteJson` / `postRemoteFile` here, so the timeout, the redirect policy and the failure
 * vocabulary live in exactly one spot. (The mirror's live `/events` socket is the one non-HTTP
 * channel; it lives in `sessions.ts` and carries the token the same way: only in the
 * `Authorization` header.)
 *
 * The bearer token is a credential for ANOTHER machine. It goes into the `Authorization` header
 * and nowhere else: nothing here logs, throws or returns it, and redirects are never followed
 * (`redirect: "manual"`), so the header cannot be replayed to wherever a 3xx points.
 */
import { type CapabilitySnapshot, parseCapabilityReport } from "./capabilities";
import { FEDERATION_API_VERSION, INSTANCE_NAME_MAX, type InstanceIdentity } from "./identity";

/** Per request. A probe makes three, so a dead machine costs at most ~15 s. Also bounds how long
 *  a bridged terminal (#2764) waits for the machine's socket to open. */
export const REMOTE_REQUEST_TIMEOUT_MS = 5_000;

export type ProbeFailure =
  | { status: "unreachable"; reason: "timeout" | "network" | "redirect" | "bad_response" }
  | { status: "unauthorized"; reason: "token_rejected" | "token_scope" | "token_restricted" }
  | { status: "incompatible"; reason: "api_missing" | "api_version" };

export type ProbeOutcome =
  | {
      status: "connected";
      info: InstanceIdentity;
      projects: string[];
      /** The machine's capability report re-based onto this clock; null when it sends none. */
      capabilities: CapabilitySnapshot | null;
    }
  | ProbeFailure;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Where a machine lives and the credential it accepts. */
export interface RemoteTarget {
  url: string;
  token: string;
}

export interface RemoteRequestOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** This instance's clock, for re-basing the machine's capability report. */
  now?: () => number;
}

type RemoteGetResult = { ok: true; body: unknown } | { ok: false; failure: ProbeFailure };

const BAD_RESPONSE: ProbeFailure = { status: "unreachable", reason: "bad_response" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** A non-2xx answer, classified. 403 is the scope gate (`insufficient_scope`); 404 means the
 *  route does not exist there, i.e. a Shepherd too old for this. */
function statusFailure(status: number): ProbeFailure {
  if (status >= 300 && status < 400) return { status: "unreachable", reason: "redirect" };
  if (status === 401) return { status: "unauthorized", reason: "token_rejected" };
  if (status === 403) return { status: "unauthorized", reason: "token_scope" };
  if (status === 404) return { status: "incompatible", reason: "api_missing" };
  return BAD_RESPONSE;
}

/** Authenticated GET of `path` on a machine, parsed as JSON. Never throws. Shared by the probe
 *  below and the session mirror (#2762). */
export async function getRemoteJson(
  target: RemoteTarget,
  path: string,
  opts: RemoteRequestOptions = {},
): Promise<RemoteGetResult> {
  let res: Response;
  try {
    res = await (opts.fetch ?? defaultFetch)(`${target.url}${path}`, {
      headers: { authorization: `Bearer ${target.token}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? REMOTE_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false,
      failure: { status: "unreachable", reason: timedOut ? "timeout" : "network" },
    };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, failure: statusFailure(res.status) };
  }
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, failure: BAD_RESPONSE };
  }
}

/**
 * A machine needs a token that reaches everything: scope `full` and no repository restriction
 * (#2712). `GET /api/me` answers for every scope and restriction, so it names the problem exactly.
 * No `access` block means the env `SHEPHERD_TOKEN`, which is always unrestricted.
 */
function grantFailure(me: Record<string, unknown>): ProbeFailure | null {
  if (!isRecord(me.access)) return null;
  if (me.access.scope !== undefined && me.access.scope !== "full") {
    return { status: "unauthorized", reason: "token_scope" };
  }
  if (Array.isArray(me.access.repoPaths)) {
    return { status: "unauthorized", reason: "token_restricted" };
  }
  return null;
}

const IDENTITY_STRINGS = ["name", "version", "platform", "arch"] as const;

function parseIdentity(body: unknown): InstanceIdentity | null {
  if (!isRecord(body) || typeof body.instanceId !== "string" || !UUID_RE.test(body.instanceId)) {
    return null;
  }
  if (!Number.isInteger(body.federationApi)) return null;
  if (!IDENTITY_STRINGS.every((key) => typeof body[key] === "string")) return null;
  return {
    instanceId: body.instanceId,
    name: (body.name as string).slice(0, INSTANCE_NAME_MAX),
    version: body.version as string,
    federationApi: body.federationApi as number,
    platform: body.platform as string,
    arch: body.arch as string,
  };
}

/** What a POST to a machine came back with. `answered` = something sent an HTTP response (`body`
 *  is null when it was not JSON); `no_answer` = the request may or may not have arrived. */
export type RemotePostResult =
  | { kind: "answered"; status: number; body: unknown }
  | { kind: "no_answer"; reason: "timeout" | "network" };

/** Authenticated POST of a JSON body (already serialized) to `path` on a machine. Never throws.
 *  Same rules as `getRemoteJson`: the token only in `Authorization`, redirects not followed. */
export function postRemoteJson(
  target: RemoteTarget,
  path: string,
  body: string,
  opts: RemoteRequestOptions & { headers?: Record<string, string> } = {},
): Promise<RemotePostResult> {
  return postRemote(target, path, body, opts, {
    ...opts.headers,
    "content-type": "application/json",
  });
}

/** Authenticated multipart POST of one file (field `file`) to `path` on a machine — how a task's
 *  attachments reach it (#2766). Never throws; same rules as `postRemoteJson`. */
export function postRemoteFile(
  target: RemoteTarget,
  path: string,
  file: Blob,
  filename: string,
  opts: RemoteRequestOptions = {},
): Promise<RemotePostResult> {
  const form = new FormData();
  form.append("file", file, filename);
  // No content-type: fetch sets multipart/form-data with its boundary.
  return postRemote(target, path, form, opts, {});
}

async function postRemote(
  target: RemoteTarget,
  path: string,
  body: BodyInit,
  opts: RemoteRequestOptions,
  headers: Record<string, string>,
): Promise<RemotePostResult> {
  let res: Response;
  try {
    res = await (opts.fetch ?? defaultFetch)(`${target.url}${path}`, {
      method: "POST",
      headers: {
        ...headers,
        authorization: `Bearer ${target.token}`,
        accept: "application/json",
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? REMOTE_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { kind: "no_answer", reason: timedOut ? "timeout" : "network" };
  }
  const parsed: unknown = await res.json().catch(() => null);
  return { kind: "answered", status: res.status, body: parsed };
}

/** The path of the machine's checkout of `slug` in its `GET /api/repos` body — the first match, so
 *  the choice is stable when a machine has one project checked out twice. */
export function parseProjectPath(body: unknown, slug: string): string | null {
  if (!isRecord(body) || !Array.isArray(body.repos)) return null;
  for (const repo of body.repos as unknown[]) {
    if (isRecord(repo) && repo.remoteSlug === slug && typeof repo.path === "string" && repo.path) {
      return repo.path;
    }
  }
  return null;
}

/** Project identity is the forge slug; a repo without one is not a project another machine can
 *  be matched on. Hidden repos count — hiding is a picker preference, not absence. */
function parseProjects(body: unknown): string[] | null {
  if (!isRecord(body) || !Array.isArray(body.repos)) return null;
  const slugs = body.repos.flatMap((repo: unknown) =>
    isRecord(repo) && typeof repo.remoteSlug === "string" && repo.remoteSlug
      ? [repo.remoteSlug]
      : [],
  );
  return [...new Set(slugs)].sort();
}

/**
 * Check a machine end to end: the token's reach (`/api/me`), its identity and federation level
 * (`/api/instance`), and its projects (`/api/repos`). Stops at the first failure.
 */
export async function probeRemote(
  target: RemoteTarget,
  opts: RemoteRequestOptions = {},
): Promise<ProbeOutcome> {
  const me = await getRemoteJson(target, "/api/me", opts);
  if (!me.ok) return me.failure;
  if (!isRecord(me.body)) return BAD_RESPONSE;
  const grant = grantFailure(me.body);
  if (grant) return grant;

  const instance = await getRemoteJson(target, "/api/instance", opts);
  if (!instance.ok) return instance.failure;
  const info = parseIdentity(instance.body);
  if (!info) return BAD_RESPONSE;
  if (info.federationApi !== FEDERATION_API_VERSION) {
    return { status: "incompatible", reason: "api_version" };
  }
  // A missing or malformed report never fails the probe: the machine is reachable, its
  // capabilities are just unknown (#2770).
  const capabilities = parseCapabilityReport(
    (instance.body as Record<string, unknown>).capabilities,
    (opts.now ?? Date.now)(),
  );

  const repos = await getRemoteJson(target, "/api/repos", opts);
  if (!repos.ok) return repos.failure;
  const projects = parseProjects(repos.body);
  return projects ? { status: "connected", info, projects, capabilities } : BAD_RESPONSE;
}
