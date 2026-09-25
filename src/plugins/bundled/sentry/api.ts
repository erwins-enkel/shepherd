// Sentry REST client + response parsing + rate-limit backoff (#2464).
// Every parser is defensive: Sentry data (and anything a public DSN lets a client send) is
// untrusted, so an unexpected shape yields null / an empty list, never a throw.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_BACKOFF_MIN = 60;

export interface SentryIssue {
  id: string;
  shortId: string;
  permalink: string;
  substatus: string | null;
  /** Assignee kind: null = unassigned. */
  assignee: "user" | "team" | null;
  projectSlug: string;
  count: number;
  userCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface SentryFrame {
  filename: string | null;
  absPath: string | null;
  function: string | null;
  lineNo: number | null;
  inApp: boolean;
}

export interface SentryException {
  type: string;
  value: string;
  frames: SentryFrame[];
}

export interface SentryBreadcrumb {
  category: string;
  level: string;
  message: string;
}

export interface SentryEvent {
  exceptions: SentryException[];
  breadcrumbs: SentryBreadcrumb[];
  tags: Array<{ key: string; value: string }>;
  release: string | null;
}

// ── parsing ──────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

const SHORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const ID_RE = /^\d{1,20}$/;

export function isSlug(s: unknown): s is string {
  return typeof s === "string" && SLUG_RE.test(s);
}

function assigneeKind(v: unknown): SentryIssue["assignee"] {
  const a = obj(v);
  if (!a) return null;
  return a.type === "team" ? "team" : "user";
}

function parseIssue(v: unknown): SentryIssue | null {
  const o = obj(v);
  const project = obj(o?.project);
  if (!o || !project) return null;
  const id = str(o.id);
  const shortId = str(o.shortId);
  const projectSlug = str(project.slug);
  if (!id || !ID_RE.test(id) || !shortId || !SHORT_ID_RE.test(shortId) || !isSlug(projectSlug)) {
    return null;
  }
  return {
    id,
    shortId,
    permalink: str(o.permalink) ?? "",
    substatus: str(o.substatus),
    assignee: assigneeKind(o.assignedTo),
    projectSlug,
    count: num(o.count),
    userCount: num(o.userCount),
    firstSeen: str(o.firstSeen),
    lastSeen: str(o.lastSeen),
  };
}

export function parseIssues(v: unknown): SentryIssue[] {
  return arr(v)
    .map(parseIssue)
    .filter((i): i is SentryIssue => i !== null);
}

function parseFrame(v: unknown): SentryFrame | null {
  const f = obj(v);
  if (!f) return null;
  const line = num(f.lineNo);
  return {
    filename: str(f.filename),
    absPath: str(f.absPath),
    function: str(f.function),
    lineNo: line > 0 ? line : null,
    inApp: f.inApp === true,
  };
}

function parseException(v: unknown): SentryException | null {
  const e = obj(v);
  if (!e) return null;
  return {
    type: str(e.type) ?? "Error",
    value: str(e.value) ?? "",
    frames: arr(obj(e.stacktrace)?.frames)
      .map(parseFrame)
      .filter((f): f is SentryFrame => f !== null),
  };
}

function parseBreadcrumb(v: unknown): SentryBreadcrumb | null {
  const b = obj(v);
  if (!b) return null;
  return {
    category: str(b.category) ?? "",
    level: str(b.level) ?? "",
    message: str(b.message) ?? "",
  };
}

function entryValues(entries: unknown[], type: string): unknown[] {
  const entry = entries.map(obj).find((e) => e?.type === type);
  return arr(obj(entry?.data)?.values);
}

export function parseEvent(v: unknown): SentryEvent | null {
  const o = obj(v);
  if (!o) return null;
  const entries = arr(o.entries);
  const release = obj(o.release);
  return {
    exceptions: entryValues(entries, "exception")
      .map(parseException)
      .filter((e): e is SentryException => e !== null),
    breadcrumbs: entryValues(entries, "breadcrumbs")
      .map(parseBreadcrumb)
      .filter((b): b is SentryBreadcrumb => b !== null),
    tags: arr(o.tags)
      .map(obj)
      .filter((t): t is Obj => !!t && typeof t.key === "string" && typeof t.value === "string")
      .map((t) => ({ key: t.key as string, value: t.value as string })),
    release: str(release?.version) ?? str(o.release),
  };
}

/** When Sentry last marked the issue regressed: the newest `set_regression` activity's
 *  `dateCreated` (ISO) in an issue-details response, or null when there is none. */
export function parseRegressedAt(v: unknown): string | null {
  let best: number | null = null;
  for (const a of arr(obj(v)?.activity)) {
    const o = obj(a);
    const t = o?.type === "set_regression" ? Date.parse(str(o.dateCreated) ?? "") : NaN;
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

export interface SentryIssueStatus {
  /** `resolved` / `ignored` / `unresolved` / … as Sentry reports it; null when absent. */
  status: string | null;
  assignee: SentryIssue["assignee"];
}

/** Lifecycle facts from an issue-details response; null on an unexpected shape. */
export function parseIssueStatus(v: unknown): SentryIssueStatus | null {
  const o = obj(v);
  if (!o) return null;
  return { status: str(o.status), assignee: assigneeKind(o.assignedTo) };
}

// ── rate-limit backoff ───────────────────────────────────────────────────────────────────

export interface Backoff {
  /** Epoch ms before which no Sentry call is made; 0 = none. */
  until: number;
  /** Consecutive 429s without a server-provided reset (drives the exponential fallback). */
  strikes: number;
}

function headerNum(h: Headers, name: string): number | null {
  const raw = h.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Next backoff after a response. 429 → Retry-After, else X-Sentry-Rate-Limit-Reset, else
 *  exponential 2^strikes minutes (capped). A success with Remaining 0 waits for Reset. */
export function nextBackoff(status: number, headers: Headers, now: number, prev: Backoff): Backoff {
  const reset = headerNum(headers, "x-sentry-rate-limit-reset");
  const resetMs = reset !== null && reset * 1000 > now ? reset * 1000 : null;
  if (status === 429) {
    const retryAfter = headerNum(headers, "retry-after");
    if (retryAfter !== null && retryAfter > 0)
      return { until: now + retryAfter * 1000, strikes: 0 };
    if (resetMs !== null) return { until: resetMs, strikes: 0 };
    const minutes = Math.min(MAX_BACKOFF_MIN, 2 ** prev.strikes);
    return { until: now + minutes * 60_000, strikes: prev.strikes + 1 };
  }
  if (headerNum(headers, "x-sentry-rate-limit-remaining") === 0 && resetMs !== null) {
    return { until: resetMs, strikes: 0 };
  }
  return { until: 0, strikes: 0 };
}

// ── client ───────────────────────────────────────────────────────────────────────────────

export interface SentryClient {
  fetch: Fetch;
  host: string;
  token: string;
}

export type SentryResult =
  | { ok: true; data: unknown; status: number; headers: Headers }
  | { ok: false; status: number; headers: Headers; error: string };

/** `https://sentry.io` + `/api/0/...` with `query` params. */
export function apiUrl(host: string, path: string, query: Record<string, string> = {}): string {
  const u = new URL(`${host.replace(/\/+$/, "")}/api/0/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.href;
}

/** One authenticated request. Never throws: network/timeout/oversize/parse failures come back as
 *  `ok:false` with status 0. The token is never included in `error`. */
async function sentryRequest(
  c: SentryClient,
  url: string,
  init: RequestInit,
): Promise<SentryResult> {
  let res: Response;
  try {
    res = await c.fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${c.token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, status: 0, headers: new Headers(), error: (e as Error).name || "fetch" };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, headers: res.headers, error: `HTTP ${res.status}` };
  }
  if (num(res.headers.get("content-length")) > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: 0, headers: res.headers, error: "response too large" };
  }
  try {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      return { ok: false, status: 0, headers: res.headers, error: "response too large" };
    }
    return {
      ok: true,
      data: text ? JSON.parse(text) : null,
      status: res.status,
      headers: res.headers,
    };
  } catch {
    return { ok: false, status: 0, headers: res.headers, error: "invalid JSON" };
  }
}

/** One authenticated GET (see `sentryRequest`). */
export function sentryGet(
  c: SentryClient,
  path: string,
  query: Record<string, string> = {},
): Promise<SentryResult> {
  return sentryRequest(c, apiUrl(c.host, path, query), { method: "GET" });
}

/** One authenticated JSON POST (see `sentryRequest`). */
export function sentryPost(c: SentryClient, path: string, body: unknown): Promise<SentryResult> {
  return sentryRequest(c, apiUrl(c.host, path), { method: "POST", body: JSON.stringify(body) });
}
