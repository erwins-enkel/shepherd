/**
 * GitHub App mode for task-agent gh credentials. Shepherd holds the App's ID and private key
 * host-side (the key is never bound into a membrane) and, per task spawn, mints a short-lived
 * installation access token scoped to the session's own GitHub repo — instead of handing agents
 * the operator's token, which usually spans every repo of the operator's account and orgs.
 *
 * Flow: App JWT (RS256) → `GET /repos/{owner}/{repo}/installation` (cached per owner/repo) →
 * `POST /app/installations/{id}/access_tokens` limited to that one repo (cached per installation +
 * repo, reused until {@link TOKEN_REFRESH_MARGIN_MS} before expiry). Every failure throws; the
 * callers (`prepareMembraneGhHosts`, `GhHostsRefresher`) then give the membrane NO token, never a
 * fallback.
 */

import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { remoteUrl } from "./forge";
import { parseRemote } from "./forge/remote";
import {
  AGENT_GH_APP_ID_ENV,
  AGENT_GH_APP_KEY_FILE_ENV,
  agentGhAppConfigured,
} from "./agent-gh-env";

export { AGENT_GH_APP_ID_ENV, AGENT_GH_APP_KEY_FILE_ENV };

const GITHUB_API = "https://api.github.com";
/** One deadline for all API calls of a single mint, so a GitHub outage delays a spawn ≤ this. */
const API_TIMEOUT_MS = 10_000;
/** Reuse a minted token until it is this close to expiry (GitHub issues them for 1 h): a spawn
 *  always starts with ≥ 20 min, and `GhHostsRefresher`'s 5-min ticks re-mint before a live
 *  membrane's token gets within 15 min of expiry. */
const TOKEN_REFRESH_MARGIN_MS = 20 * 60_000;

/** What a task agent's token may do: push + PRs + issues, read CI. Nothing org- or admin-level. */
export const AGENT_GH_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
  checks: "read",
  statuses: "read",
  actions: "read",
} as const;

export interface GithubRepo {
  owner: string;
  name: string;
}

/** A minted installation token and when GitHub expires it (epoch ms). */
export interface AgentGhAppToken {
  token: string;
  expiresAt: number;
}

/**
 * App mode cannot work until the operator changes something: App vars unset/half-set, a
 * non-numeric App ID, an unusable key file, a non-GitHub repo, or GitHub refusing the App itself —
 * 404 (not installed / installation gone), 401 (JWT rejected: wrong App ID or revoked key), 422
 * (permissions or the repo not granted to the installation). Every other failure — network,
 * timeout, 5xx, 403/429 rate limits, a malformed response — is transient: a live membrane's
 * refresh keeps its still-valid token through it, but drops the token at once on this error.
 */
export class GithubAppConfigError extends Error {
  override name = "GithubAppConfigError";
}

/** HTTP statuses that mean the App/installation itself is refused (see GithubAppConfigError). */
const CONFIG_STATUSES = new Set([401, 404, 422]);

/** `owner/name` → its parts when both are valid GitHub names (they land in API paths); else null. */
export function parseGithubSlug(slug: string): GithubRepo | null {
  const [owner, name, ...rest] = slug.split("/");
  if (rest.length > 0 || !owner || !name) return null;
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name)) {
    return null;
  }
  return { owner, name };
}

/**
 * The GitHub repo of `repoPath`'s `origin` remote, or null when origin is absent or not on
 * github.com. `origin` is the clone's push target — in fork mode the fork, not the upstream the
 * forge reads issues/PRs from — because pushing is what the agent's token must always allow.
 */
export function githubOriginRepo(repoPath: string): GithubRepo | null {
  const url = remoteUrl(repoPath, "origin");
  const parsed = url ? parseRemote(url) : null;
  if (parsed?.host.toLowerCase() !== "github.com") return null;
  return parseGithubSlug(parsed.slug);
}

/**
 * The App's private key from `path`. Throws {@link GithubAppConfigError} when it is missing,
 * unreadable, not a regular file, accessible by group/other, or not an RSA private key. Messages
 * name the path, never the key.
 */
export async function loadGithubAppKey(path: string): Promise<KeyObject> {
  const bad = (why: string, cause?: unknown) =>
    new GithubAppConfigError(`${AGENT_GH_APP_KEY_FILE_ENV}: ${path} ${why}`, { cause });
  let pem: string;
  try {
    const st = await stat(path);
    if (!st.isFile()) throw bad("is not a regular file");
    if (st.mode & 0o077) throw bad("is readable by group/other (chmod 600)");
    pem = await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof GithubAppConfigError) throw err;
    throw bad(`cannot be read (${(err as NodeJS.ErrnoException).code ?? String(err)})`, err);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (err) {
    throw bad("is not a PEM private key", err);
  }
  if (key.asymmetricKeyType !== "rsa") throw bad("is not an RSA key");
  return key;
}

/** An RS256 App JWT: issued 60 s in the past (clock drift), valid 9 min — GitHub caps it at 10. */
export function githubAppJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iat: now - 60,
    exp: now + 540,
    iss: Number(appId),
  })}`;
  return `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
}

export interface GithubAppMinterDeps {
  /** Numeric App ID (the JWT `iss`). */
  appId: string;
  /** The App's private key; called on every {@link GithubAppTokenMinter.token}, so a key that
   *  turns missing/insecure fails closed even while a minted token is cached. Any failure counts
   *  as a {@link GithubAppConfigError}. */
  loadKey: () => Promise<KeyObject>;
  /** default global `fetch`. */
  fetch?: typeof fetch;
  /** default `Date.now`. */
  now?: () => number;
  /** Deadline for one mint's API calls; default {@link API_TIMEOUT_MS}. */
  timeoutMs?: number;
}

interface ApiResult {
  status: number;
  json: unknown;
}

/** GitHub's own error `message`, printable-ASCII and bounded, for a log line; "" when absent. */
function apiMessage(json: unknown): string {
  const m = (json as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? ` (${m.replace(/[^ -~]/g, "?").slice(0, 200)})` : "";
}

/** An API refusal as an error: {@link GithubAppConfigError} when the status says the App itself
 *  is refused, a plain (transient) Error otherwise. */
function httpError(what: string, r: ApiResult): Error {
  const Err = CONFIG_STATUSES.has(r.status) ? GithubAppConfigError : Error;
  return new Err(`${what}: HTTP ${r.status}${apiMessage(r.json)}`);
}

/** A `201` access-token body as a token + expiry, or null when malformed. */
function parseMinted(json: unknown): AgentGhAppToken | null {
  const body = json as { token?: unknown; expires_at?: unknown } | null;
  const expiresAt = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
  if (typeof body?.token !== "string" || !body.token || !Number.isFinite(expiresAt)) return null;
  return { token: body.token, expiresAt };
}

/**
 * Mints repo-scoped installation tokens for one App, caching installation IDs per owner/repo and
 * tokens per installation + repo. Every failure throws with a reason that holds no secret — a
 * {@link GithubAppConfigError} when the App config itself is unusable.
 */
export class GithubAppTokenMinter {
  private readonly installations = new Map<string, number>();
  private readonly tokens = new Map<string, AgentGhAppToken>();
  private readonly inflight = new Map<string, Promise<AgentGhAppToken>>();

  constructor(private readonly deps: GithubAppMinterDeps) {}

  async token(repo: GithubRepo): Promise<AgentGhAppToken> {
    let key: KeyObject;
    try {
      key = await this.deps.loadKey();
    } catch (err) {
      if (err instanceof GithubAppConfigError) throw err;
      throw new GithubAppConfigError(err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }
    const now = (this.deps.now ?? Date.now)();
    const repoKey = `${repo.owner}/${repo.name}`.toLowerCase(); // GitHub names are case-insensitive
    const installation = this.installations.get(repoKey);
    const hit =
      installation === undefined
        ? undefined
        : this.tokens.get(`${installation}/${repo.name.toLowerCase()}`);
    if (hit && hit.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) return hit;
    // Concurrent callers for one repo (a drain burst, the boot-time refresh) share one mint.
    const pending = this.inflight.get(repoKey);
    if (pending) return pending;
    const minting = this.mint(repo, repoKey, key, now).finally(() => this.inflight.delete(repoKey));
    this.inflight.set(repoKey, minting);
    return minting;
  }

  private async mint(
    repo: GithubRepo,
    repoKey: string,
    key: KeyObject,
    now: number,
  ): Promise<AgentGhAppToken> {
    const jwt = githubAppJwt(this.deps.appId, key, now);
    const signal = AbortSignal.timeout(this.deps.timeoutMs ?? API_TIMEOUT_MS);
    const installation =
      this.installations.get(repoKey) ??
      (await this.lookupInstallation(repo, repoKey, jwt, signal));
    const r = await this.api(
      `/app/installations/${installation}/access_tokens`,
      jwt,
      signal,
      "token mint",
      { repositories: [repo.name], permissions: AGENT_GH_APP_PERMISSIONS },
    );
    const slug = `${repo.owner}/${repo.name}`;
    if (r.status !== 201) {
      // The installation is gone (App uninstalled/reinstalled): look it up afresh next time.
      if (r.status === 404) this.installations.delete(repoKey);
      throw httpError(`GitHub App token mint for ${slug}`, r);
    }
    const minted = parseMinted(r.json);
    if (!minted) throw new Error(`GitHub App token mint for ${slug}: malformed response`);
    this.tokens.set(`${installation}/${repo.name.toLowerCase()}`, minted);
    return minted;
  }

  /** `GET /repos/{owner}/{repo}/installation` → the installation ID, cached per owner/repo. */
  private async lookupInstallation(
    repo: GithubRepo,
    repoKey: string,
    jwt: string,
    signal: AbortSignal,
  ): Promise<number> {
    const slug = `${repo.owner}/${repo.name}`;
    const r = await this.api(`/repos/${slug}/installation`, jwt, signal, "installation lookup");
    if (r.status === 404) {
      throw new GithubAppConfigError(`GitHub App is not installed on ${slug} (HTTP 404)`);
    }
    if (r.status !== 200) throw httpError(`GitHub App installation lookup for ${slug}`, r);
    const id = (r.json as { id?: unknown } | null)?.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`GitHub App installation lookup for ${slug}: malformed response`);
    }
    this.installations.set(repoKey, id);
    return id;
  }

  private async api(
    path: string,
    jwt: string,
    signal: AbortSignal,
    what: string,
    body?: object,
  ): Promise<ApiResult> {
    try {
      const res = await (this.deps.fetch ?? fetch)(`${GITHUB_API}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Shepherd",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // best-effort: a non-JSON (error) body — the status alone decides.
      }
      return { status: res.status, json };
    } catch (err) {
      // fetch rejects with the signal's reason: a DOMException named TimeoutError.
      const timedOut = (err as { name?: unknown } | null)?.name === "TimeoutError";
      const reason = timedOut ? "timed out" : err instanceof Error ? err.message : String(err);
      throw new Error(`GitHub App ${what} failed: ${reason}`, { cause: err });
    }
  }
}

export interface AgentGhAppDeps {
  /** default `process.env`, read on every call. */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  /** default {@link loadGithubAppKey}. */
  loadKey?: (path: string) => Promise<KeyObject>;
  /** default {@link githubOriginRepo}. */
  githubRepo?: (repoPath: string) => GithubRepo | null;
}

/**
 * The App-mode agent token source. Its result is null when App mode is not configured (neither
 * env var set); otherwise an installation token scoped to `repoPath`'s GitHub repo — or it throws
 * (fail closed): {@link GithubAppConfigError} for one var missing, a non-numeric App ID, a
 * non-GitHub repo or an unusable App, a plain Error for a transient minter failure. The closure
 * owns its minter, so its caches live as long as the closure does.
 */
export function makeAgentGhAppToken(
  deps: AgentGhAppDeps = {},
): (repoPath: string) => Promise<AgentGhAppToken | null> {
  let current: { appId: string; keyFile: string; minter: GithubAppTokenMinter } | null = null;
  return async (repoPath) => {
    const env = deps.env ?? process.env;
    if (!agentGhAppConfigured(env)) return null;
    const appId = env[AGENT_GH_APP_ID_ENV]?.trim() ?? "";
    const keyFile = env[AGENT_GH_APP_KEY_FILE_ENV]?.trim() ?? "";
    if (!appId || !keyFile) {
      throw new GithubAppConfigError(
        `GitHub App mode needs both ${AGENT_GH_APP_ID_ENV} and ${AGENT_GH_APP_KEY_FILE_ENV}`,
      );
    }
    if (!/^\d+$/.test(appId)) {
      throw new GithubAppConfigError(`${AGENT_GH_APP_ID_ENV} is not a numeric App ID`);
    }
    const repo = (deps.githubRepo ?? githubOriginRepo)(repoPath);
    if (!repo) {
      throw new GithubAppConfigError(
        `${repoPath} has no github.com origin remote (GitHub App mode)`,
      );
    }
    if (current?.appId !== appId || current.keyFile !== keyFile) {
      const loadKey = deps.loadKey ?? loadGithubAppKey;
      current = {
        appId,
        keyFile,
        minter: new GithubAppTokenMinter({
          appId,
          loadKey: () => loadKey(keyFile),
          fetch: deps.fetch,
          now: deps.now,
        }),
      };
    }
    return current.minter.token(repo);
  };
}

/** The process-wide App-mode token source (env-configured; caches live for the process). */
export const agentGhAppTokenFromEnv = makeAgentGhAppToken();
