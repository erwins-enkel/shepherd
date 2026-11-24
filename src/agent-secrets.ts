// Per-repo agent secrets (issue #4122): operator-stored named values handed to one repo's TASK
// agents as env vars. One JSON file (`{ [repoDir]: { [NAME]: { value, updatedAt } } }`) at mode
// 0600 under `~/.shepherd/`, read ONCE async and served from memory — no sync fs on the single
// event loop. Delivery never puts a value in argv: each spawn gets a 0700 dir of 0600 files and a
// fixed `/bin/sh` launcher that exports them and `exec`s the agent; only the dir path is in argv.

import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeSecretsFile } from "./plugins/secrets";
import { setKnownSecretValues } from "./redact";

export type AgentSecretErrorCode =
  "invalid-name" | "reserved-name" | "invalid-value" | "too-many" | "unavailable" | "store-error";

export class AgentSecretError extends Error {
  constructor(
    readonly code: AgentSecretErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentSecretError";
  }
}

export const MAX_SECRETS_PER_REPO = 32;
export const MAX_SECRET_VALUE_BYTES = 16384;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_NAMES = new Set([
  "HOME",
  "PATH",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "TMPDIR",
  "IFS",
  "ENV",
  "BASH_ENV",
  "NODE_OPTIONS",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "NO_COLOR",
]);
const RESERVED_PREFIXES = [
  "LD_",
  "DYLD_",
  "CLAUDE_",
  "SHEPHERD_",
  "ANTHROPIC_",
  "CODEX_",
  "GIT_",
  "MISE_",
  "BWRAP_",
];

/** null when `name` is a usable env var name, else the rejection code. */
export function validateSecretName(name: unknown): "invalid-name" | "reserved-name" | null {
  if (typeof name !== "string" || !NAME_RE.test(name)) return "invalid-name";
  const upper = name.toUpperCase();
  if (RESERVED_NAMES.has(upper) || RESERVED_PREFIXES.some((p) => upper.startsWith(p)))
    return "reserved-name";
  return null;
}

/** Strip trailing line breaks (a pasted token usually carries one). null when the result is
 *  empty, contains NUL, or exceeds {@link MAX_SECRET_VALUE_BYTES} UTF-8 bytes. */
export function normalizeSecretValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.replace(/(?:\r?\n)+$/, "");
  if (v.length === 0 || v.includes("\0")) return null;
  if (Buffer.byteLength(v, "utf8") > MAX_SECRET_VALUE_BYTES) return null;
  return v;
}

interface SecretEntry {
  value: string;
  updatedAt: number;
}
/** Maps, not plain objects: a repo path or name like `__proto__` stays an ordinary entry. */
type SecretMap = Map<string, Map<string, SecretEntry>>;

export interface AgentSecretSummary {
  name: string;
  updatedAt: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isEntry(v: unknown): v is SecretEntry {
  return isPlainObject(v) && typeof v.value === "string" && typeof v.updatedAt === "number";
}

function toSecretMap(parsed: unknown): SecretMap {
  if (!isPlainObject(parsed)) throw new Error("not a { repo: { NAME: entry } } object");
  const out: SecretMap = new Map();
  for (const [repo, names] of Object.entries(parsed)) {
    if (!isPlainObject(names) || !Object.values(names).every(isEntry))
      throw new Error(`repo ${JSON.stringify(repo)} is not a { NAME: { value, updatedAt } } map`);
    out.set(repo, new Map(Object.entries(names as Record<string, SecretEntry>)));
  }
  return out;
}

function serialize(data: SecretMap): string {
  const obj = Object.fromEntries(
    [...data].map(([repo, names]) => [repo, Object.fromEntries(names)]),
  );
  return JSON.stringify(obj, null, 2) + "\n";
}

export class AgentSecretStore {
  private data: SecretMap = new Map();
  private loading: Promise<void> | null = null;
  /** Set when the file exists but can't be read/parsed: writes then REFUSE, so a hand-broken
   *  file is never clobbered with a near-empty map. */
  private readError: string | null = null;
  /** Tail of the serialized write chain — never rejected, so one failure never poisons later writes. */
  private writeChain: Promise<void> = Promise.resolve();

  /** `path` undefined → store unavailable: reads are empty, writes reject `unavailable`. */
  constructor(
    private readonly path: string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Load the file once (idempotent; concurrent callers share the one read). */
  load(): Promise<void> {
    this.loading ??= this.read().then(() => setKnownSecretValues(this.allValues()));
    return this.loading;
  }

  private async read(): Promise<void> {
    if (!this.path) return;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      this.readError = `could not read agent secrets file: ${errMsg(e)}`;
      console.warn(`[agent-secrets] ${this.readError}`);
      return;
    }
    try {
      this.data = toSecretMap(JSON.parse(raw));
    } catch (e) {
      this.readError = `agent secrets file is invalid (${errMsg(e)}) — fix or delete it`;
      console.warn(`[agent-secrets] ${this.readError}`);
    }
  }

  /** Names + timestamps for `repo`, sorted by name. Never values. */
  list(repo: string): AgentSecretSummary[] {
    return [...(this.data.get(repo) ?? [])]
      .map(([name, e]) => ({ name, updatedAt: e.updatedAt }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** NAME → value for `repo` (delivery only; never serve this to a client). */
  entries(repo: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, e] of this.data.get(repo) ?? []) {
      Object.defineProperty(out, name, { value: e.value, enumerable: true, writable: true });
    }
    return out;
  }

  /** Every stored value across repos — the exact-match redaction set. */
  allValues(): string[] {
    return [...this.data.values()].flatMap((names) => [...names.values()].map((e) => e.value));
  }

  set(repo: string, name: string, value: string): Promise<AgentSecretSummary> {
    return this.enqueue(() => this.write(repo, name, value));
  }

  delete(repo: string, name: string): Promise<boolean> {
    return this.enqueue(() => this.remove(repo, name));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.writeChain.then(fn);
    this.writeChain = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private async ready(): Promise<string> {
    if (!this.path) throw new AgentSecretError("unavailable", "agent secret store unavailable");
    await this.load();
    if (this.readError) throw new AgentSecretError("store-error", `refused: ${this.readError}`);
    return this.path;
  }

  private async write(repo: string, name: string, value: string): Promise<AgentSecretSummary> {
    const nameErr = validateSecretName(name);
    if (nameErr) throw new AgentSecretError(nameErr, `secret name not allowed: ${nameErr}`);
    const normalized = normalizeSecretValue(value);
    if (normalized === null)
      throw new AgentSecretError(
        "invalid-value",
        `secret value must be non-empty, NUL-free and at most ${MAX_SECRET_VALUE_BYTES} bytes`,
      );
    const path = await this.ready();
    const own = new Map(this.data.get(repo));
    if (!own.has(name) && own.size >= MAX_SECRETS_PER_REPO)
      throw new AgentSecretError(
        "too-many",
        `at most ${MAX_SECRETS_PER_REPO} secrets per repository`,
      );
    const updatedAt = this.now();
    own.set(name, { value: normalized, updatedAt });
    await this.commit(path, new Map(this.data).set(repo, own));
    return { name, updatedAt };
  }

  private async remove(repo: string, name: string): Promise<boolean> {
    const path = await this.ready();
    const current = this.data.get(repo);
    if (!current?.has(name)) return false;
    const own = new Map(current);
    own.delete(name);
    const next: SecretMap = new Map(this.data);
    if (own.size === 0) next.delete(repo);
    else next.set(repo, own);
    await this.commit(path, next);
    return true;
  }

  private async commit(path: string, next: SecretMap): Promise<void> {
    try {
      await writeSecretsFile(path, serialize(next));
    } catch (e) {
      throw new AgentSecretError("store-error", `could not write agent secrets: ${errMsg(e)}`);
    }
    this.data = next; // commit to memory only once it is durably on disk
    setKnownSecretValues(this.allValues());
  }
}

// ── Session delivery ────────────────────────────────────────────────────────────────────────

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const SECRET_DIR_SUFFIX = ".secrets";

/** `<baseDir>/<sessionId>.secrets`; throws on a session id that could escape `baseDir`. */
export function sessionSecretDir(baseDir: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  return join(baseDir, `${sessionId}${SECRET_DIR_SUFFIX}`);
}

/** Create (or re-own) `dir` as a real 0700 directory owned by this uid — never a symlink. */
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink())
    throw new Error(`secret dir is not a real directory: ${dir}`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`secret dir not owned by us: ${dir}`);
  await chmod(dir, 0o700);
}

/** Write one 0600 file per secret into the session's dir (stale files removed) and return the
 *  dir; with no entries the dir is removed and null returned. Temp files are dot-prefixed so the
 *  launcher's `*` glob never picks one up. */
export async function writeSessionSecretDir(
  baseDir: string,
  sessionId: string,
  entries: Record<string, string>,
): Promise<string | null> {
  const dir = sessionSecretDir(baseDir, sessionId);
  const names = Object.keys(entries);
  if (names.length === 0) {
    await removeSessionSecretDir(baseDir, sessionId);
    return null;
  }
  for (const name of names)
    if (validateSecretName(name) !== null) throw new Error(`invalid secret name: ${name}`);
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  await ensurePrivateDir(dir);
  const keep = new Set(names);
  for (const f of await readdir(dir)) {
    if (!keep.has(f)) await rm(join(dir, f), { recursive: true, force: true });
  }
  for (const name of names) {
    const tmp = join(dir, `.${name}.tmp`);
    await rm(tmp, { force: true });
    await writeFile(tmp, entries[name] ?? "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, join(dir, name));
  }
  return dir;
}

/** Best-effort removal of a session's secret dir. */
export async function removeSessionSecretDir(baseDir: string, sessionId: string): Promise<void> {
  await rm(sessionSecretDir(baseDir, sessionId), { recursive: true, force: true }).catch(() => {}); // best-effort: a leftover dir is swept at next boot
}

/** Remove every `<id>.secrets` dir under `baseDir` whose session `keep` rejects. Returns the
 *  count removed; a missing `baseDir` is fine. */
export async function sweepOrphanSecretDirs(
  baseDir: string,
  keep: (sessionId: string) => boolean,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(baseDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(SECRET_DIR_SUFFIX)) continue;
    const id = name.slice(0, -SECRET_DIR_SUFFIX.length);
    if (!SESSION_ID_RE.test(id) || keep(id)) continue;
    await rm(join(baseDir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

// ── Launcher ────────────────────────────────────────────────────────────────────────────────

export const SECRET_LAUNCHER_ARGV0 = "shepherd-secret-env";

/** POSIX sh (dash-safe): export each regular file in `$1` as an env var named after it, then
 *  exec the rest of argv. The `case` guard skips any file whose name isn't a valid env name.
 *  `$(cat …)` drops trailing newlines only — stored values never carry one. */
const SECRET_LAUNCHER_SCRIPT =
  'd=$1; shift; for f in "$d"/*; do [ -f "$f" ] || continue; n=${f##*/}; ' +
  'case $n in ""|[!A-Za-z_]*|*[!A-Za-z0-9_]*) continue;; esac; ' +
  'v=$(cat "$f") || exit 126; export "$n=$v"; done; exec "$@"';

/** Wrap `argv` so it runs with the secrets in `dir` as env. Only `dir` enters argv. */
export function secretEnvLauncher(dir: string, argv: string[]): string[] {
  return ["/bin/sh", "-c", SECRET_LAUNCHER_SCRIPT, SECRET_LAUNCHER_ARGV0, dir, ...argv];
}

/** Tokens to skip (5) when `argv[start…]` is exactly the launcher prefix, else 0. */
export function secretLauncherSkip(argv: readonly string[], start: number): number {
  return argv[start] === "/bin/sh" &&
    argv[start + 1] === "-c" &&
    argv[start + 2] === SECRET_LAUNCHER_SCRIPT &&
    argv[start + 3] === SECRET_LAUNCHER_ARGV0 &&
    argv.length > start + 4
    ? 5
    : 0;
}
