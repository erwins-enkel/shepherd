/**
 * Host-side Claude state a membrane spawn needs prepared BEFORE bwrap starts (audit F04/F06).
 *
 * The membrane never binds the host `.claude.json` RW: it holds user- and project-scope
 * `mcpServers` whose `command` later UNCONFINED sessions (trusted profile, the operator's own
 * `claude`) launch without a prompt. Each spawn instead gets a private COPY, seeded with trust for
 * its cwd, bound RW in place of the original — Claude's onboarding/trust writes land there and are
 * dropped with it. Nothing is merged back.
 *
 * The spawn's own transcript dir (+ its memory/) is created here: buildMembraneFlags binds it
 * from the host only when it exists, so the transcript persists for resume.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { chmod, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { OwnerOnlyFileError, readOwnerOnlyFile } from "./owner-only-file";
import { basename, join } from "node:path";
import { claudeConfigPath, dashify } from "./claude-trust";
import { shepherdRuntimeDir } from "./runtime-dir";
import { scanPath } from "./sandbox";
import { execFileAsync } from "./instrument";
import {
  agentGhAppTokenFromEnv,
  GithubAppConfigError,
  type AgentGhAppToken,
  type AgentGhAppTokenOptions,
  type GhOptInPermission,
} from "./agent-gh-app";
import { AGENT_GH_TOKEN_FILE_ENV, agentGhAppConfigured } from "./agent-gh-env";

export { AGENT_GH_TOKEN_FILE_ENV };

function membraneStateRoot(): string {
  return shepherdRuntimeDir("membrane");
}

export interface MembraneStateInputs {
  home: string;
  /** The config dir bound as the membrane's claudeDir. */
  claudeDir: string;
  /** Host dir bound AS `<claudeDir>/projects` (MembraneInputs.projectsBindSource ?? default). */
  projectsSource: string;
  /** The agent's cwd (MembraneInputs.worktreePath). */
  cwd: string;
  sessionId: string;
  /** Distinguishes concurrent spawns for one session (`session`, `review`, …). */
  key: string;
}

/**
 * Create the own transcript dir and write this spawn's `.claude.json` copy. Returns the copy's
 * path, or null when the host file is missing (nothing to bind — Claude starts fresh, as before).
 */
export async function prepareMembraneClaudeState(i: MembraneStateInputs): Promise<string | null> {
  await mkdir(join(i.projectsSource, dashify(i.cwd), "memory"), { recursive: true });

  let raw: string;
  try {
    raw = await readFile(claudeConfigPath(i.home, i.claudeDir), "utf8");
  } catch {
    return null;
  }
  return writeStateFile(i.sessionId, `${i.key}.claude.json`, withTrust(raw, i.cwd));
}

/** Write one 0600 file into the session's 0700 state dir and return its path. */
async function writeStateFile(sessionId: string, name: string, content: string): Promise<string> {
  const dir = join(membraneStateRoot(), sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = join(dir, name);
  // tmp + rename: a still-running earlier spawn keeps the inode it mounted.
  const tmp = `${file}.tmp.${randomUUID()}`; // unique: concurrent same-kind spawns share `file`
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, file);
  return file;
}

export interface MembraneMiseInputs {
  home: string;
  sessionId: string;
  key: string;
  /** The membrane's real node/bun binaries (null entries ignored). */
  pinnedBins: (string | null | undefined)[];
}

/** `<tool> = <version>` for a bin under `<home>/.local/share/mise/installs/<tool>/<version>/`. */
function misePins(home: string, bins: (string | null | undefined)[]): Record<string, string> {
  const prefix = `${home}/.local/share/mise/installs/`;
  const pins: Record<string, string> = {};
  for (const bin of bins) {
    if (typeof bin !== "string" || !bin.startsWith(prefix)) continue;
    const [tool, version] = bin.slice(prefix.length).split("/");
    if (tool && version) pins[tool] = version;
  }
  return pins;
}

/** The host global config's `[tools]`, string / string-array values only; {} when unreadable. */
async function hostMiseTools(home: string): Promise<Record<string, string | string[]>> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(await readFile(join(home, ".config", "mise", "config.toml"), "utf8"));
  } catch {
    return {};
  }
  const tools = (parsed as { tools?: unknown } | null)?.tools;
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return {};
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(tools)) {
    const isStrings = Array.isArray(v) && v.every((x) => typeof x === "string");
    if (typeof v === "string" || isStrings) out[k] = v as string | string[];
  }
  return out;
}

/**
 * This spawn's derived mise config (see `MEMBRANE_MISE_CONFIG` in sandbox.ts): the host's
 * `[tools]` table ONLY — never `[env]` (operator secrets), `[settings]`, `[hooks]` or `[tasks]` —
 * with the membrane's own node/bun pinned to their install versions so they stay on PATH whatever
 * the global config lists. null when there is nothing to write.
 */
export async function prepareMembraneMiseConfig(i: MembraneMiseInputs): Promise<string | null> {
  const tools = { ...(await hostMiseTools(i.home)), ...misePins(i.home, i.pinnedBins) };
  const entries = Object.entries(tools);
  if (entries.length === 0) return null;
  const lines = entries.map(
    ([k, v]) =>
      `${JSON.stringify(k)} = ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v)}`,
  );
  return writeStateFile(i.sessionId, `${i.key}.mise.toml`, `[tools]\n${lines.join("\n")}\n`);
}

export interface MembraneGhInputs {
  home: string;
  sessionId: string;
  key: string;
  /** The session's repo dir: GitHub App mode scopes the token to its github.com `origin`. */
  repoPath: string;
  /** Opt-in permissions the operator granted this session (#4119): App mode mints it a widened
   *  token. Absent/empty ⇒ the default set. */
  ghPermissions?: readonly GhOptInPermission[];
}

/** An App-mode token source: `repoPath`'s token, widened per `opts` (#4119). */
export type AgentGhAppTokenFn = (
  repoPath: string,
  opts?: AgentGhAppTokenOptions,
) => Promise<AgentGhAppToken | null>;

/** The widened-mint options for `sessionId`'s grants, or undefined for the default set. */
function grantOptions(
  sessionId: string,
  extra: readonly GhOptInPermission[] | undefined,
): AgentGhAppTokenOptions | undefined {
  return extra && extra.length > 0 ? { extra, sessionId } : undefined;
}

export interface MembraneGhDeps {
  /** The host's github.com token; default `gh auth token` (async, 5s cap). */
  ghToken?: () => Promise<string>;
  /** The dedicated agent token, or null when none is configured; default
   *  {@link agentGhTokenFromEnv}. Throws when one is configured but unusable. */
  agentGhToken?: () => Promise<string | null>;
  /** GitHub App mode (`SHEPHERD_AGENT_GH_APP_ID`): an installation token scoped to the repo at
   *  `repoPath`, or null when App mode is not configured; default {@link agentGhAppTokenFromEnv}.
   *  Throws when App mode is configured but no token can be minted for that repo. */
  agentGhAppToken?: AgentGhAppTokenFn;
}

/** gh's token alphabet: classic, OAuth and fine-grained `github_pat_` tokens are `[A-Za-z0-9_]`;
 *  App installation tokens are now `ghs_` + base64url segments joined by `.` (~390 chars, with
 *  `-` and `.`). Token text goes into YAML verbatim, so nothing else is accepted: no whitespace,
 *  `:` or `#`, and an alphanumeric first character so it can never open a YAML indicator. */
const GH_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The agent token from {@link AGENT_GH_TOKEN_FILE_ENV} — a file with the github.com token task
 * agents get instead of the operator's own (`gh auth token`), e.g. a fine-grained PAT scoped to
 * the repos Shepherd works on; the operator token usually carries far broader scopes (`admin:org`,
 * every repo, `workflow`). GitHub App mode (`SHEPHERD_AGENT_GH_APP_ID`) wins over it. null when
 * the var is unset/blank.
 * Throws when it is set but the file is missing, not a regular file, readable by group/other,
 * or not a single token — a configured-but-broken agent token must not silently fall back to
 * the operator's.
 */
export async function agentGhTokenFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const path = env[AGENT_GH_TOKEN_FILE_ENV]?.trim();
  if (!path) return null;
  let raw: string;
  try {
    raw = await readOwnerOnlyFile(path);
  } catch (err) {
    if (!(err instanceof OwnerOnlyFileError)) throw err;
    throw new Error(
      err.problem === "not-regular"
        ? `${AGENT_GH_TOKEN_FILE_ENV}: ${path} is not a regular file`
        : `${AGENT_GH_TOKEN_FILE_ENV}: ${path} is readable by group/other (chmod 600)`,
      { cause: err },
    );
  }
  const token = raw.trim();
  if (!GH_TOKEN_RE.test(token)) {
    throw new Error(`${AGENT_GH_TOKEN_FILE_ENV}: ${path} does not hold a single gh token`);
  }
  return token;
}

/** Env vars gh prefers over stored credentials (`gh help environment`). */
const GH_ENV_TOKENS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/** `env` minus the gh token vars, so `gh auth token` reports only the keyring/config token —
 *  never a server env secret that `--clearenv` keeps out of the membrane. */
export function ghStoredTokenEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of GH_ENV_TOKENS) delete out[k];
  return out;
}

async function defaultGhToken(): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
    timeout: 5000,
    env: ghStoredTokenEnv(process.env),
  });
  return stdout;
}

/** A 4-space-indented scalar of the `github.com:` block matching `valid`, or null. */
function ghHostField(raw: string, field: string, valid: RegExp): string | null {
  const m = raw.match(new RegExp(`^github\\.com:\\n(?:[ ]{4}.*\\n)*?[ ]{4}${field}: *(\\S+)`, "m"));
  const v = m?.[1];
  return v && valid.test(v) ? v : null;
}

/**
 * gh keeps its token in the OS keyring when one is available, and the membrane (no D-Bus,
 * `--clearenv`) cannot reach it — so `gh` and the `gh auth git-credential` helper 401 inside it
 * even though `~/.config/gh` is bound for exactly that purpose. This writes a per-spawn 0600
 * github.com `hosts.yml` carrying the token, bound RO over the host file (task sessions only;
 * same in-membrane readability as a file-stored token, audit R3). null — no override — when the
 * host file is absent, already holds a token, or the token can't be read (best-effort).
 *
 * With an agent token configured the override always carries it instead — also over a host file
 * that stores the operator token itself, and also when the host has no `hosts.yml` (or no
 * `~/.config/gh`) at all: the agent token doesn't come from it, and sandbox.ts then binds this
 * file without the host dir. Precedence: GitHub App mode (`SHEPHERD_AGENT_GH_APP_ID`, a token
 * minted for this session's repo) > {@link AGENT_GH_TOKEN_FILE_ENV} > the operator token. If the
 * winning agent source is configured but yields no usable token, the override carries no token at
 * all (gh 401s in the membrane) rather than falling back to a lower one.
 */
export async function prepareMembraneGhHosts(
  i: MembraneGhInputs,
  deps: MembraneGhDeps = {},
): Promise<string | null> {
  const raw = await readHostGhHosts(i.home);
  const agentToken = await agentTokenFor(
    i.repoPath,
    deps,
    grantOptions(i.sessionId, i.ghPermissions),
  );
  // An agent token doesn't come from the host file: written even without one.
  if (agentToken !== undefined) return writeGhHosts(i, raw ?? "", agentToken);
  if (raw === null) return null;
  const token = await operatorTokenFor(raw, deps);
  return token === null ? null : writeGhHosts(i, raw, token);
}

/** The host's github.com `hosts.yml` text, or null when it can't be read. */
function readHostGhHosts(home: string): Promise<string | null> {
  // best-effort: a missing host file is a normal setup (keyring-less, or gh never logged in)
  return readFile(join(home, ".config", "gh", "hosts.yml"), "utf8").catch(() => null);
}

/**
 * This spawn's agent token: undefined when no agent mode is configured; null when the winning
 * source (App mode, else the token file) is configured but yields no usable token — warned, and
 * never a fallback to a lower source.
 */
async function agentTokenFor(
  repoPath: string,
  deps: MembraneGhDeps,
  opts: AgentGhAppTokenOptions | undefined,
): Promise<string | null | undefined> {
  let token: string | null;
  try {
    // The token file is consulted only when App mode is not configured (null, not a throw).
    const app = await (deps.agentGhAppToken ?? agentGhAppTokenFromEnv)(repoPath, opts);
    token = app ? app.token : await (deps.agentGhToken ?? agentGhTokenFromEnv)();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[sandbox] agent gh token unusable; membrane gets no gh token: ${reason}`);
    return null;
  }
  if (token === null) return undefined;
  const t = token.trim();
  if (GH_TOKEN_RE.test(t)) return t;
  console.warn("[sandbox] agent gh token malformed; membrane gets none");
  return null;
}

/** The operator's own token for a host file without one (keyring-stored); null — no override —
 *  when the host file already holds a token or none can be read. */
async function operatorTokenFor(raw: string, deps: MembraneGhDeps): Promise<string | null> {
  if (/^\s*oauth_token:/m.test(raw)) return null;
  let token: string;
  try {
    token = (await (deps.ghToken ?? defaultGhToken)()).trim();
  } catch (err) {
    console.warn("[sandbox] gh token unavailable for the membrane:", err);
    return null;
  }
  return GH_TOKEN_RE.test(token) ? token : null;
}

/** The per-spawn gh hosts file of `sessionId`'s spawn `key` ({@link prepareMembraneGhHosts}). */
export function membraneGhHostsPath(sessionId: string, key = "session"): string {
  return join(membraneStateRoot(), sessionId, `${key}.gh-hosts.yml`);
}

/** The per-spawn 0600 github.com `hosts.yml`, keeping the host file's user/protocol; `token`
 *  null writes one without any `oauth_token`. */
function writeGhHosts(i: MembraneGhInputs, raw: string, token: string | null): Promise<string> {
  return writeStateFile(i.sessionId, `${i.key}.gh-hosts.yml`, ghHostsContent(raw, token));
}

/** github.com `hosts.yml` text for `token` (null ⇒ no `oauth_token`), keeping the host file's
 *  user/protocol. `token` must already match {@link GH_TOKEN_RE}. */
function ghHostsContent(raw: string, token: string | null): string {
  const user = ghHostField(raw, "user", /^[A-Za-z0-9-]+$/);
  const protocol = ghHostField(raw, "git_protocol", /^[a-z]+$/);
  const lines = ["github.com:"];
  if (user) {
    lines.push("    users:", `        ${user}:${token ? "" : " {}"}`);
    if (token) lines.push(`            oauth_token: ${token}`);
  }
  if (protocol) lines.push(`    git_protocol: ${protocol}`);
  if (user) lines.push(`    user: ${user}`);
  if (token) lines.push(`    oauth_token: ${token}`);
  return `${lines.join("\n")}\n`;
}

/** How often a live membrane's App-minted token is checked. With the minter's 20-min reuse margin
 *  (`TOKEN_REFRESH_MARGIN_MS`) the token in the file keeps ≥ 15 min, and an App config that turns
 *  unusable (key removed or loosened, App uninstalled) empties the file within this interval. */
export const GH_HOSTS_REFRESH_INTERVAL_MS = 5 * 60_000;

/** Through transient refresh failures the file keeps its token while more than this remains.
 *  Equal to the check interval, so a kept token is still valid when the next check drops it. */
const GH_TOKEN_SAFETY_MARGIN_MS = GH_HOSTS_REFRESH_INTERVAL_MS;

export interface GhHostsRefreshTarget {
  home: string;
  sessionId: string;
  /** The session's repo dir — the App token is scoped to its github.com `origin`. */
  repoPath: string;
  /** The live spawn's gh hosts file ({@link membraneGhHostsPath}), rewritten in place. */
  file: string;
}

export interface GhHostsRefresherDeps {
  /** default {@link agentGhAppTokenFromEnv} (shares its minter and caches with the spawn path). */
  agentGhAppToken?: AgentGhAppTokenFn;
  /** The opt-in permissions currently granted to `sessionId` (#4119); default none. */
  grants?: (sessionId: string) => readonly GhOptInPermission[];
  /** default `Date.now`. */
  now?: () => number;
  /** Is GitHub App mode configured? default `agentGhAppConfigured(process.env)`. */
  appModeConfigured?: () => boolean;
  /** Run `fn` every `ms`, returning its canceller; default an unref'd `setInterval`. */
  every?: (fn: () => void, ms: number) => () => void;
  /** default {@link GH_HOSTS_REFRESH_INTERVAL_MS}. */
  intervalMs?: number;
}

interface GhHostsRefreshLoop {
  target: GhHostsRefreshTarget;
  cancel: () => void;
  inflight: Promise<void> | null;
  /** Expiry of the token this loop last wrote into the file; null when it wrote none (or has not
   *  refreshed this file yet — then a transient failure cannot vouch for the file's token). */
  expiresAt: number | null;
  /** The last refresh's outcome when it failed, so a persistent failure warns once, not every tick. */
  failure: string | null;
  /** The widened mint was refused (422) and the default set used instead — warned once. */
  narrowed: boolean;
}

function everyUnref(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref?.(); // a refresh loop never keeps the server alive
  return () => clearInterval(timer);
}

/**
 * Replace `file`'s content IN PLACE: a live membrane's RO bind pins the inode, so the spawn path's
 * tmp + rename would never reach it. One positional write of the whole content, padded with blank
 * lines to at least the current size — the file never shrinks, so a concurrent reader (gh, the git
 * credential helper) sees the old or the new text, never an empty or truncated one. No-op when
 * unchanged. Opened without O_CREAT: a removed file is not resurrected (ENOENT).
 */
export async function rewriteInPlace(file: string, content: string): Promise<void> {
  const fh = await open(file, "r+");
  try {
    const current = await fh.readFile();
    if (current.toString("utf8").trimEnd() === content.trimEnd()) return;
    const body = Buffer.from(content);
    const buf =
      body.length >= current.length
        ? body
        : Buffer.concat([body, Buffer.alloc(current.length - body.length, "\n")]);
    const { bytesWritten } = await fh.write(buf, 0, buf.length, 0);
    if (bytesWritten !== buf.length) throw new Error(`short write (${bytesWritten}/${buf.length})`);
  } finally {
    await fh.close();
  }
}

/** One refresh's answer from the App token source: a grant, or a classified failure. */
type RefreshResult =
  | { ok: true; grant: AgentGhAppToken }
  | { ok: false; failure: string; configUnusable: boolean; status?: number };

/** Ask `source` for `repoPath`'s App token. Never throws: a failure comes back classified —
 *  `configUnusable` for App mode gone or a {@link GithubAppConfigError}, else transient. */
async function fetchRefresh(
  source: AgentGhAppTokenFn,
  repoPath: string,
  opts?: AgentGhAppTokenOptions,
): Promise<RefreshResult> {
  try {
    const g = await source(repoPath, opts);
    if (g === null) {
      return {
        ok: false,
        failure: "GitHub App mode is no longer configured",
        configUnusable: true,
      };
    }
    const token = g.token.trim();
    if (!GH_TOKEN_RE.test(token)) {
      return { ok: false, failure: "minted token is malformed", configUnusable: false };
    }
    return { ok: true, grant: { token, expiresAt: g.expiresAt } };
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    return err instanceof GithubAppConfigError
      ? { ok: false, failure, configUnusable: true, status: err.status }
      : { ok: false, failure, configUnusable: false };
  }
}

/** After a failed refresh, may the file keep its token? Only through a transient failure, and
 *  only while the token this loop vouched for has more than the safety margin left. */
function keepTokenThroughFailure(
  configUnusable: boolean,
  expiresAt: number | null,
  now: number,
): boolean {
  return !configUnusable && expiresAt !== null && expiresAt - now > GH_TOKEN_SAFETY_MARGIN_MS;
}

/**
 * Keeps each live task membrane's gh hosts file carrying a fresh GitHub App token: installation
 * tokens last 1 h, sessions run for many. GitHub App mode only — otherwise {@link start} is a
 * no-op and the spawn-time token (token file / operator) stands. One loop per session; the
 * session's teardown must {@link stop} it.
 *
 * Fail closed, never with a token-file or operator token: an unusable App config
 * ({@link GithubAppConfigError} — vars, key, App not installed / refused) rewrites the file
 * WITHOUT a token at once. A transient failure (network, timeout, 5xx, rate limit, malformed
 * response) keeps the file's still-valid token and retries on the next check, dropping it only
 * once ≤ {@link GH_TOKEN_SAFETY_MARGIN_MS} remain — or at once when this loop cannot vouch for it.
 */
export class GhHostsRefresher {
  private readonly loops = new Map<string, GhHostsRefreshLoop>();

  constructor(private readonly deps: GhHostsRefresherDeps = {}) {}

  /**
   * Start refreshing `target.file` (App mode + an existing file only). A later start for the same
   * session — a resume's spawn — retargets the running loop instead of adding one. Either way it
   * refreshes at once, learning the file's token expiry (after a spawn: the minter's cache hit,
   * no request) — at boot the file may hold a token minted before the restart.
   */
  start(target: GhHostsRefreshTarget): void {
    if (!(this.deps.appModeConfigured ?? agentGhAppConfigured)()) return;
    if (!existsSync(target.file)) return;
    const running = this.loops.get(target.sessionId);
    if (running) {
      Object.assign(running, { target, expiresAt: null, failure: null, narrowed: false });
    } else {
      const loop: GhHostsRefreshLoop = {
        target,
        cancel: () => {},
        inflight: null,
        expiresAt: null,
        failure: null,
        narrowed: false,
      };
      this.loops.set(target.sessionId, loop);
      loop.cancel = (this.deps.every ?? everyUnref)(
        () => void this.refresh(target.sessionId),
        this.deps.intervalMs ?? GH_HOSTS_REFRESH_INTERVAL_MS,
      );
    }
    void this.refresh(target.sessionId);
  }

  /** Stop `sessionId`'s loop (teardown). Idempotent. */
  stop(sessionId: string): void {
    this.loops.get(sessionId)?.cancel();
    this.loops.delete(sessionId);
  }

  /** Stop every loop (shutdown). */
  stopAll(): void {
    for (const id of [...this.loops.keys()]) this.stop(id);
  }

  /** Is a loop running for `sessionId`? */
  isRunning(sessionId: string): boolean {
    return this.loops.has(sessionId);
  }

  /** Refresh `sessionId`'s file now, after any in-flight refresh. Never throws; no-op when no
   *  loop runs for it. */
  refresh(sessionId: string): Promise<void> {
    const loop = this.loops.get(sessionId);
    if (!loop) return Promise.resolve();
    loop.inflight ??= this.refreshOnce(loop).finally(() => {
      loop.inflight = null;
    });
    return loop.inflight;
  }

  /**
   * Refresh `sessionId`'s file with a refresh STARTED NOW: waits out an in-flight one (it may have
   * minted for a grant set that just changed), then runs a fresh one. Grant and revoke use it so
   * the file holds the new set's token when it resolves. Never throws.
   */
  async refreshNow(sessionId: string): Promise<void> {
    const loop = this.loops.get(sessionId);
    if (!loop) return;
    // best-effort: refreshOnce never rejects; this only orders the fresh run after the old one.
    await loop.inflight?.catch(() => {});
    await this.refresh(sessionId);
  }

  private async refreshOnce(loop: GhHostsRefreshLoop): Promise<void> {
    const { sessionId, home } = loop.target;
    const result = await this.fetchFor(loop);
    // Without the host file the refreshed one just omits user/protocol.
    const raw = (await readHostGhHosts(home)) ?? "";
    if (this.loops.get(sessionId) !== loop) return; // stopped meanwhile: leave the file alone
    const token = result.ok ? this.accept(loop, result.grant) : this.afterFailure(loop, result);
    if (token !== undefined) await this.write(loop, ghHostsContent(raw, token));
  }

  /**
   * This loop's App token, widened by the session's grants. A widened mint GitHub refuses with 422
   * (the installation no longer holds the permission) falls back to the DEFAULT set — narrower,
   * never another source — warned once.
   */
  private async fetchFor(loop: GhHostsRefreshLoop): Promise<RefreshResult> {
    const { sessionId, repoPath } = loop.target;
    const source = this.deps.agentGhAppToken ?? agentGhAppTokenFromEnv;
    const opts = grantOptions(sessionId, this.deps.grants?.(sessionId));
    const result = await fetchRefresh(source, repoPath, opts);
    if (!opts || result.ok || result.status !== 422) {
      if (result.ok) loop.narrowed = false;
      return result;
    }
    if (!loop.narrowed) {
      console.warn(
        `[sandbox] ${sessionId}: granted gh permissions refused by the App installation; ` +
          `using the default token: ${result.failure}`,
      );
    }
    loop.narrowed = true;
    return fetchRefresh(source, repoPath);
  }

  /** Track a fresh grant; its token goes into the file. */
  private accept(loop: GhHostsRefreshLoop, grant: AgentGhAppToken): string {
    loop.expiresAt = grant.expiresAt;
    loop.failure = null;
    return grant.token;
  }

  /** A failed refresh: undefined keeps the file's still-valid token (retry on the next check),
   *  null empties it. Warns once per outcome, not every tick. */
  private afterFailure(
    loop: GhHostsRefreshLoop,
    f: { failure: string; configUnusable: boolean },
  ): null | undefined {
    const now = (this.deps.now ?? Date.now)();
    const keep = keepTokenThroughFailure(f.configUnusable, loop.expiresAt, now);
    const outcome = `${keep ? "keep" : "drop"}: ${f.failure}`;
    if (outcome !== loop.failure) {
      const prefix = `[sandbox] ${loop.target.sessionId}: gh token refresh failed;`;
      const left = Math.floor(((loop.expiresAt ?? now) - now) / 60_000);
      console.warn(
        keep
          ? `${prefix} keeping the current token (${left} min left), retrying: ${f.failure}`
          : `${prefix} membrane gets no gh token: ${f.failure}`,
      );
    }
    loop.failure = outcome;
    if (keep) return undefined;
    loop.expiresAt = null;
    return null;
  }

  /** Rewrite the loop's file in place; a vanished file (membrane state removed) stops the loop. */
  private async write(loop: GhHostsRefreshLoop, content: string): Promise<void> {
    const { sessionId, file } = loop.target;
    try {
      await rewriteInPlace(file, content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.stop(sessionId); // the session's membrane state is gone: nothing left to refresh
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[sandbox] ${sessionId}: could not refresh the membrane gh hosts file: ${reason}`,
      );
    }
  }
}

export interface MembraneGhBinDeps {
  /** Every executable `gh` on Shepherd's PATH, in order; default scans `process.env.PATH`. */
  whichAll?: () => string[];
  /** default fs realpath. */
  realpath?: (p: string) => Promise<string>;
  /** Does the file start with `#!`? default reads its first two bytes. */
  isScript?: (p: string) => Promise<boolean>;
  /** `mise which gh` (async, 5s cap); null when mise is absent or gh unmanaged. */
  miseWhich?: () => Promise<string | null>;
}

async function startsWithShebang(p: string): Promise<boolean> {
  const fh = await open(p, "r");
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(2), 0, 2, 0);
    return bytesRead === 2 && buffer.toString("latin1") === "#!";
  } finally {
    await fh.close();
  }
}

async function defaultMiseWhich(): Promise<string | null> {
  const { stdout } = await execFileAsync("mise", ["which", "gh"], { timeout: 5000 });
  return stdout.trim() || null;
}

/** Realpath of `p` when it is a real binary — not a mise link (shim / command-wrapper) and not a
 *  `#!` launcher script; else null. */
async function realGhBinary(p: string, deps: MembraneGhBinDeps): Promise<string | null> {
  try {
    const real = await (deps.realpath ?? realpath)(p);
    if (basename(real) === "mise") return null;
    return (await (deps.isScript ?? startsWithShebang)(real)) ? null : real;
  } catch {
    return null;
  }
}

/**
 * The host's real `gh` binary for the membrane (#3975), or null. A `~/.local/bin/gh` launcher that
 * runs `mise use -g gh` (Omarchy) dies on EROFS inside the read-only membrane, and `~/.local/bin`
 * is first on its PATH — so the membrane binds this binary ahead of it. First real binary on
 * Shepherd's PATH; else `mise which gh` (Shepherd's PATH may hold only the launcher).
 */
export async function resolveMembraneGhBin(deps: MembraneGhBinDeps = {}): Promise<string | null> {
  const candidates = (deps.whichAll ?? (() => scanPath("gh", process.env.PATH)))();
  for (const p of candidates) {
    const real = await realGhBinary(p, deps);
    if (real) return real;
  }
  let viaMise: string | null;
  try {
    viaMise = await (deps.miseWhich ?? defaultMiseWhich)();
  } catch {
    return null;
  }
  return viaMise ? realGhBinary(viaMise, deps) : null;
}

/** `raw` with `projects[cwd].hasTrustDialogAccepted = true`; unparseable input is kept verbatim. */
function withTrust(raw: string, cwd: string): string {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return raw;
  const cfg = j as Record<string, unknown>;
  const projects = (cfg.projects && typeof cfg.projects === "object" ? cfg.projects : {}) as Record<
    string,
    Record<string, unknown>
  >;
  const entry = projects[cwd] && typeof projects[cwd] === "object" ? projects[cwd] : {};
  projects[cwd] = { ...entry, hasTrustDialogAccepted: true };
  cfg.projects = projects;
  return JSON.stringify(cfg);
}

/**
 * A host log file a sandboxed preview can append to (audit F03 follow-up): the membrane re-binds
 * `<git-common-dir>/shepherd` read-only, where the generated script's default log lives, and its
 * `set -e` would abort on that EROFS before the dev server starts. Created (empty if new) so it can
 * be single-file bound; lives with the session's membrane state, removed at archive.
 */
export function previewLogFile(sessionId: string): string {
  const dir = join(membraneStateRoot(), sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "preview-start.log");
  closeSync(openSync(file, "a", 0o600));
  return file;
}

/** Best-effort removal of one session's copies (session teardown). */
export function removeMembraneState(sessionId: string): void {
  try {
    rmSync(join(membraneStateRoot(), sessionId), { recursive: true, force: true });
  } catch {
    // best-effort: teardown; a leftover copy must not fail session teardown
  }
}

/** Boot reconcile: drop copies of sessions no longer live (teardown missed across a crash). */
export function sweepMembraneState(liveSessionIds: Iterable<string>): void {
  const live = new Set(liveSessionIds);
  let entries: string[];
  try {
    entries = readdirSync(membraneStateRoot());
  } catch {
    return;
  }
  for (const id of entries) if (!live.has(id)) removeMembraneState(id);
}
