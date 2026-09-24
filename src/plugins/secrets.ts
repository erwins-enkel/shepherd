// Per-plugin secret store backing `ctx.secrets` (issue #2461). One JSON file
// (`{ [pluginId]: { [key]: value } }`) at mode 0600 under `~/.shepherd/`, read ONCE async at
// load and served from memory after that — no sync fs on the single event loop. Secrets are
// kept out of every core-served payload: `PluginRegistry` runs outbound plugin data through
// `redactSecrets` so even a plugin that publishes its own token never ships it to the UI.

import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";

/** Maps, not plain objects: a plugin id or key like `__proto__`/`constructor` must be an
 *  ordinary entry, never a prototype lookup or a setter that silently drops the write. */
type SecretMap = Map<string, Map<string, string>>;

/** Shorter values are not redacted — substring-matching a 1–3 char "secret" would mangle
 *  unrelated text, and a secret that short protects nothing anyway. */
const MIN_REDACT_LENGTH = 4;
const REDACTED = "[redacted]";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isStringMap(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string")
  );
}

function isSecretRecord(v: unknown): v is Record<string, Record<string, string>> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(isStringMap);
}

/** JSON.parse keeps `__proto__` as an OWN key, so `Object.entries` round-trips it safely. */
function toSecretMap(parsed: Record<string, Record<string, string>>): SecretMap {
  return new Map(Object.entries(parsed).map(([id, keys]) => [id, new Map(Object.entries(keys))]));
}

/** `Object.fromEntries` defines own data properties (no `__proto__` setter), so every entry
 *  survives into the JSON. */
function serialize(data: SecretMap): string {
  const obj = Object.fromEntries([...data].map(([id, keys]) => [id, Object.fromEntries(keys)]));
  return JSON.stringify(obj, null, 2) + "\n";
}

export class PluginSecretStore {
  private data: SecretMap = new Map();
  private loading: Promise<void> | null = null;
  /** Set when the file exists but can't be read/parsed: writes then REFUSE, so a
   *  hand-broken file is never clobbered with a near-empty map (mirrors `setConfig`). */
  private readError: string | null = null;
  /** Tail of the serialized write chain — never rejected, so one failure never poisons later writes. */
  private writeChain: Promise<void> = Promise.resolve();

  /** `path` undefined → store unavailable: `get` is null, `set` rejects. */
  constructor(private readonly path: string | undefined) {}

  /** Load the file once (idempotent; concurrent callers share the one read). */
  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    if (!this.path) return;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      this.readError = `could not read secrets file: ${errMsg(e)}`;
      console.warn(`[plugins] ${this.readError}`);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isSecretRecord(parsed)) throw new Error("not a { pluginId: { key: string } } object");
      this.data = toSecretMap(parsed);
    } catch (e) {
      this.readError = `secrets file is invalid (${errMsg(e)}) — fix or delete it`;
      console.warn(`[plugins] ${this.readError}`);
    }
  }

  get(pluginId: string, key: string): string | null {
    return this.data.get(pluginId)?.get(key) ?? null;
  }

  /** Every secret value this plugin holds — the redaction set for its outbound payloads. */
  values(pluginId: string): string[] {
    return [...(this.data.get(pluginId)?.values() ?? [])];
  }

  set(pluginId: string, key: string, value: string | null): Promise<void> {
    const task = this.writeChain.then(() => this.write(pluginId, key, value));
    this.writeChain = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private async write(pluginId: string, key: string, value: string | null): Promise<void> {
    const tag = `[plugin:${pluginId}] secrets.set`;
    if (!this.path) throw new Error(`${tag}: secret store unavailable`);
    if (typeof key !== "string" || key.length === 0)
      throw new Error(`${tag}: key must be a non-empty string`);
    if (value !== null && typeof value !== "string")
      throw new Error(`${tag}: value must be a string or null`);
    await this.load();
    if (this.readError) throw new Error(`${tag} refused: ${this.readError}`);

    const own = new Map(this.data.get(pluginId));
    if (value === null) own.delete(key);
    else own.set(key, value);
    const next: SecretMap = new Map(this.data);
    if (own.size === 0) next.delete(pluginId);
    else next.set(pluginId, own);

    await writeSecretsFile(this.path, serialize(next));
    this.data = next; // commit to memory only once it is durably on disk
  }
}

/** Atomic 0600 write: temp file (created 0600, then chmod'd in case a stale temp survived
 *  with a looser mode) → rename → chmod the target, so a pre-existing looser file is fixed. */
async function writeSecretsFile(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Deep-copy `value`, replacing every occurrence of any of `secrets` inside any string (keys
 *  included) with `[redacted]`. Returns `value` untouched when there is nothing to redact. */
export function redactSecrets<T>(value: T, secrets: string[]): T {
  const needles = secrets.filter((s) => s.length >= MIN_REDACT_LENGTH);
  if (needles.length === 0) return value;
  const scrub = (s: string): string =>
    needles.reduce((acc, n) => (acc.includes(n) ? acc.split(n).join(REDACTED) : acc), s);
  // `ancestors` guards a cyclic plugin-published blob (publishStatus is verbatim): the cycle
  // is cut to null instead of recursing until the stack blows.
  const ancestors = new Set<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (!v || typeof v !== "object") return v;
    if (ancestors.has(v)) return null;
    ancestors.add(v);
    const out = Array.isArray(v)
      ? v.map(walk)
      : Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), walk(x)]));
    ancestors.delete(v);
    return out;
  };
  return walk(value) as T;
}
