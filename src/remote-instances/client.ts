/**
 * The one place a Shepherd talks HTTP to another Shepherd (issue #2759). Everything that reaches a
 * connected machine — the connection probe, the session mirror's snapshot (#2762), the hand-off of
 * a new task (#2763) and its attachments (#2766), the forwarded session actions (#2765) — goes
 * through `getRemoteJson` / `postRemoteJson` / `postRemoteFile` / `requestRemote` here, so the
 * timeout, the redirect policy and the failure vocabulary live in exactly one spot. (The mirror's
 * live `/events` socket is the one non-HTTP channel; it lives in `sessions.ts` and carries the
 * token the same way: only in the `Authorization` header.)
 *
 * The bearer token is a credential for ANOTHER machine. It goes into the `Authorization` header
 * and nowhere else: nothing here logs, throws or returns it, and redirects are never followed
 * (`redirect: "manual"`), so the header cannot be replayed to wherever a 3xx points.
 */
import { type HostLoadSnapshot, parseRemoteLoad } from "./load";
import { type CapabilitySnapshot, parseCapabilityReport } from "./capabilities";
import { FEDERATION_API_VERSION, INSTANCE_NAME_MAX, type InstanceIdentity } from "./identity";

/** Per request. A probe makes three, so a dead machine costs at most ~15 s. Also bounds how long
 *  a bridged terminal (#2764) waits for the machine's socket to open. */
export const REMOTE_REQUEST_TIMEOUT_MS = 5_000;

export type ProbeFailure =
  | {
      status: "unreachable";
      reason: "timeout" | "network" | "redirect" | "bad_response" | "not_shepherd";
    }
  | { status: "unauthorized"; reason: "token_rejected" | "token_scope" | "token_restricted" }
  | { status: "incompatible"; reason: "api_missing" | "api_version" };

export type ProbeOutcome =
  | {
      status: "connected";
      info: InstanceIdentity;
      projects: string[];
      /** Which project (slug) each of the machine's checkouts belongs to, by its path and its
       *  realpath — its sessions name their checkout by `repoPath`. */
      repoSlugs: Map<string, string>;
      /** Every checkout the machine lists, slug or not — what a settings source's repo emojis
       *  and repo-bound steers are keyed by (#3967). */
      repos: RemoteRepo[];
      /** The machine's capability report re-based onto this clock; null when it sends none. */
      capabilities: CapabilitySnapshot | null;
      load: HostLoadSnapshot | null;
      loadReadAt: number;
    }
  | ProbeFailure;

/** One checkout a machine lists in `GET /api/repos`, reduced to what names and matches it.
 *  `realPath` is `path` when the machine sends none; `remoteSlug` null = no forge project. */
export interface RemoteRepo {
  name: string;
  path: string;
  realPath: string;
  remoteSlug: string | null;
}

/** Caps on the repo index kept from a machine's answer: it is untrusted input that is held in
 *  memory and persisted with a settings source's cache (#3967). */
const REMOTE_REPOS_MAX = 1_000;
const REMOTE_REPO_STRING_MAX = 1_024;

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

/** An instance ID — and a session ID, which every Shepherd mints the same way (`randomUUID`). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** A non-2xx answer other than 404, classified. 403 is the scope gate (`insufficient_scope`). */
function statusFailure(status: number): ProbeFailure {
  if (status >= 300 && status < 400) return { status: "unreachable", reason: "redirect" };
  if (status === 401) return { status: "unauthorized", reason: "token_rejected" };
  if (status === 403) return { status: "unauthorized", reason: "token_scope" };
  return BAD_RESPONSE;
}

/** A 404, classified by who sent it (#3844). Every Shepherd — one too old to have the route
 *  included — answers an unknown API route with a JSON `{error}`, so only that means the route is
 *  missing there. Anything else (Tailscale Serve's plain-text 404 with no mapping on the port, a
 *  web server's page) means no Shepherd answers at this address. */
async function notFoundFailure(res: Response): Promise<ProbeFailure> {
  const notShepherd: ProbeFailure = { status: "unreachable", reason: "not_shepherd" };
  if (!res.headers.get("content-type")?.includes("application/json")) {
    await res.body?.cancel().catch(() => {});
    return notShepherd;
  }
  const body: unknown = await res.json().catch(() => null);
  return isRecord(body) && typeof body.error === "string"
    ? { status: "incompatible", reason: "api_missing" }
    : notShepherd;
}

/** A redirect, 401 or 403 answering a POST: this server's token lost its reach on the machine.
 *  Never handed on as the machine's answer — to the caller it would read as its own refusal. */
export function lostReach(status: number): ProbeFailure | null {
  return (status >= 300 && status < 400) || status === 401 || status === 403
    ? statusFailure(status)
    : null;
}

/** Authenticated GET of `path` on a machine, parsed as JSON. Never throws. Shared by the probe
 *  below and the session mirror (#2762), which adds its identity headers (#3056). */
export async function getRemoteJson(
  target: RemoteTarget,
  path: string,
  opts: RemoteRequestOptions & { headers?: Record<string, string> } = {},
): Promise<RemoteGetResult> {
  let res: Response;
  try {
    res = await (opts.fetch ?? defaultFetch)(`${target.url}${path}`, {
      headers: {
        ...opts.headers,
        authorization: `Bearer ${target.token}`,
        accept: "application/json",
      },
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
  if (res.status === 404) return { ok: false, failure: await notFoundFailure(res) };
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

type RemoteRequestResult = { ok: true; response: Response } | { ok: false; failure: ProbeFailure };

/**
 * Authenticated request of `path` on a machine with the response left unread, so a forwarded
 * answer (#2765) streams through — a download included. The timeout covers the wait for the
 * response headers only. Never throws.
 *
 * A redirect, 401 and 403 come back as failures, never as a response: this server always holds a
 * full, unrestricted token, so either status means that token lost its reach on the machine —
 * and a 401 handed to a caller here would read as the caller's own login having expired.
 */
export async function requestRemote(
  target: RemoteTarget,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: ArrayBuffer | string },
  opts: RemoteRequestOptions = {},
): Promise<RemoteRequestResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? REMOTE_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (opts.fetch ?? defaultFetch)(`${target.url}${path}`, {
      method: init.method,
      headers: { ...init.headers, authorization: `Bearer ${target.token}` },
      body: init.body,
      redirect: "manual",
      signal: abort.signal,
    });
  } catch {
    return {
      ok: false,
      failure: { status: "unreachable", reason: abort.signal.aborted ? "timeout" : "network" },
    };
  } finally {
    clearTimeout(timer);
  }
  if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, failure: statusFailure(res.status) };
  }
  return { ok: true, response: res };
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

/** A non-empty string within the cap, or null. */
function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= REMOTE_REPO_STRING_MAX
    ? value
    : null;
}

/** One `GET /api/repos` entry as a `RemoteRepo`, or null when it lacks a usable name and path. */
function parseRemoteRepo(entry: unknown): RemoteRepo | null {
  if (!isRecord(entry)) return null;
  const name = boundedString(entry.name);
  const path = boundedString(entry.path);
  if (!name || !path) return null;
  return {
    name,
    path,
    realPath: boundedString(entry.realPath) ?? path,
    remoteSlug: boundedString(entry.remoteSlug),
  };
}

/** The usable entries of a machine's repo list as `RemoteRepo`s, at most `REMOTE_REPOS_MAX`. Also
 *  re-reads a settings source's persisted index (#3967), which is held to the same rules. */
export function parseRemoteRepos(entries: readonly unknown[]): RemoteRepo[] {
  const repos: RemoteRepo[] = [];
  for (const entry of entries) {
    if (repos.length >= REMOTE_REPOS_MAX) break;
    const repo = parseRemoteRepo(entry);
    if (repo) repos.push(repo);
  }
  return repos;
}

/** Project identity is the forge slug; a repo without one is not a project another machine can
 *  be matched on. Hidden repos count — hiding is a picker preference, not absence. */
function projectSlugs(entries: readonly unknown[]): {
  projects: string[];
  repoSlugs: Map<string, string>;
} {
  const slugs: string[] = [];
  const repoSlugs = new Map<string, string>();
  for (const repo of entries) {
    if (!isRecord(repo) || typeof repo.remoteSlug !== "string" || !repo.remoteSlug) continue;
    slugs.push(repo.remoteSlug);
    for (const path of [repo.path, repo.realPath]) {
      if (typeof path === "string" && path) repoSlugs.set(path, repo.remoteSlug);
    }
  }
  return { projects: [...new Set(slugs)].sort(), repoSlugs };
}

/** The machine's projects by slug, plus every listed checkout (slug or not) as its repo index. */
function parseProjects(
  body: unknown,
): { projects: string[]; repoSlugs: Map<string, string>; repos: RemoteRepo[] } | null {
  if (!isRecord(body) || !Array.isArray(body.repos)) return null;
  const entries = body.repos as unknown[];
  return { ...projectSlugs(entries), repos: parseRemoteRepos(entries) };
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

  const loadReadAt = (opts.now ?? Date.now)();
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

  const load = parseRemoteLoad((instance.body as Record<string, unknown>).load, loadReadAt);
  const repos = await getRemoteJson(target, "/api/repos", opts);
  if (!repos.ok) return repos.failure;
  const parsed = parseProjects(repos.body);
  return parsed
    ? { status: "connected", info, ...parsed, capabilities, load, loadReadAt }
    : BAD_RESPONSE;
}
