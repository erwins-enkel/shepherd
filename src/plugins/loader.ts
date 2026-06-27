// Server-side plugin loader + registry (issue #1124). Scans the plugins dir at boot,
// validates each manifest, imports the entry, and calls `register(ctx)` ONCE — each
// plugin wrapped in its own try/catch so one bad plugin never blocks boot or the
// others. Holds the `ctx` seam, the ordered spawn-hook list, per-plugin routes, and
// core-derived (unspoofable) health. The only isolation that matters for trusted,
// single-author code: load-time try/catch + timeout-bounded hook invocation. Knowingly
// NOT protected against a plugin's own synchronous infinite loop (a you-bug you'd fix;
// worker isolation would sever the synchronous spawn-mutation seam claude-swap needs).

import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_API_VERSION,
  PluginSpawnAborted,
  type PluginContext,
  type PluginInfo,
  type PluginLogger,
  type PluginManifest,
  type PluginRegister,
  type PluginRouteHandler,
  type PluginState,
  type SpawnDescriptor,
  type SpawnHook,
  type SpawnPatch,
} from "./types";

const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

/** Minimal store surface the registry needs — the `plugin_state` accessors only. */
export interface PluginStateStore {
  getPluginState(pluginId: string, key: string): string | null;
  setPluginState(pluginId: string, key: string, value: string): void;
  deletePluginState(pluginId: string, key: string): void;
  listPluginStateKeys(pluginId: string): string[];
}

/** Minimal event-bus surface: read-only `subscribe` for plugins + `emit` for status. */
export interface PluginEventBus {
  subscribe(fn: (event: string, data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

export interface PluginRegistryDeps {
  pluginsDir: string;
  store: PluginStateStore;
  events: PluginEventBus;
  /** Per-hook timeout (ms); default 5000. Tests inject a small value. */
  hookTimeoutMs?: number;
}

/** Internal per-plugin record. `health`/`lastError`/`status` back the status panel. */
interface LoadedPlugin {
  manifest: PluginManifest;
  health: PluginInfo["health"];
  lastError: string | null;
  status: unknown;
  hooks: SpawnHook[];
  routes: Map<string, PluginRouteHandler>;
  unsubs: Array<() => void>;
  teardown?: () => void;
  config: Record<string, unknown>;
}

/** Thrown internally when a hook exceeds its timeout; distinguishes `timed-out` health. */
class HookTimeoutError extends Error {
  constructor(pluginId: string, ms: number) {
    super(`onSpawn hook for ${pluginId} exceeded ${ms}ms`);
    this.name = "HookTimeoutError";
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Required-field guard for a parsed manifest. */
function validManifest(m: unknown): m is PluginManifest {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.name === "string" &&
    typeof o.version === "string" &&
    typeof o.apiVersion === "number"
  );
}

export class PluginRegistry {
  /** Insertion-ordered (alphabetical by folder) map of loaded plugins. */
  private readonly plugins = new Map<string, LoadedPlugin>();
  /** Flat, registration-ordered spawn-hook list (load order, then within-plugin order). */
  private readonly allSpawnHooks: Array<{ pluginId: string; fn: SpawnHook }> = [];

  constructor(private readonly deps: PluginRegistryDeps) {}

  /** Scan the plugins dir and load every plugin. No-op (clean) when the dir is
   *  missing/empty — the zero-plugin invariant a fresh public clone relies on. */
  async loadAll(): Promise<void> {
    let names: string[];
    try {
      // `readdir(..., { withFileTypes: true })` does NOT follow symlinks: a
      // symlink-to-directory Dirent reports isDirectory()===false. Resolve such
      // entries with stat() (which follows the link) so a symlinked install — the
      // natural "run a plugin from its checkout" workflow — loads like a copy (#1176).
      const entries = await readdir(this.deps.pluginsDir, { withFileTypes: true });
      names = [];
      for (const e of entries) {
        if (e.isDirectory()) {
          names.push(e.name);
        } else if (e.isSymbolicLink()) {
          try {
            if ((await stat(join(this.deps.pluginsDir, e.name))).isDirectory()) names.push(e.name);
          } catch {
            /* dangling symlink — skip */
          }
        }
      }
      names.sort();
    } catch {
      return; // missing dir → nothing to load
    }
    for (const name of names) {
      await this.loadOne(join(this.deps.pluginsDir, name));
    }
  }

  private async loadOne(dir: string): Promise<void> {
    const manifestPath = join(dir, "plugin.json");
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      return; // not a plugin folder (no manifest) — skip quietly
    }
    let manifest: PluginManifest;
    try {
      const parsed = JSON.parse(raw);
      if (!validManifest(parsed))
        throw new Error("missing required fields (id/name/version/apiVersion)");
      manifest = parsed;
    } catch (e) {
      console.warn(`[plugins] skipped ${basename(dir)}: invalid plugin.json: ${errMsg(e)}`);
      return;
    }
    if (this.plugins.has(manifest.id)) {
      console.warn(`[plugins] skipped ${basename(dir)}: duplicate plugin id "${manifest.id}"`);
      return;
    }
    if (manifest.enabled === false) {
      console.log(`[plugins] ${manifest.id} disabled via manifest (enabled:false) — skipped`);
      return;
    }
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      // Record it so the panel surfaces the mismatch; register no hooks.
      this.plugins.set(manifest.id, {
        manifest,
        health: "errored",
        lastError: `apiVersion ${manifest.apiVersion} != supported ${PLUGIN_API_VERSION}`,
        status: null,
        hooks: [],
        routes: new Map(),
        unsubs: [],
        config: {},
      });
      console.warn(
        `[plugins] ${manifest.id} skipped: apiVersion ${manifest.apiVersion} != ${PLUGIN_API_VERSION}`,
      );
      return;
    }

    const config = await this.readConfig(dir);
    const rec: LoadedPlugin = {
      manifest,
      health: "ok",
      lastError: null,
      status: null,
      hooks: [],
      routes: new Map(),
      unsubs: [],
      config,
    };
    this.plugins.set(manifest.id, rec);

    try {
      const entry = await this.resolveEntry(dir);
      if (!entry) throw new Error("no entry module (index.ts/js or package.json main)");
      const mod = (await import(pathToFileURL(entry).href)) as {
        register?: unknown;
        default?: unknown;
      };
      const register =
        typeof mod.register === "function"
          ? mod.register
          : typeof mod.default === "function"
            ? mod.default
            : undefined;
      if (typeof register !== "function") throw new Error("entry exports no register() function");
      const teardown = await (register as PluginRegister)(this.makeContext(rec));
      if (typeof teardown === "function") rec.teardown = teardown;
      console.log(`[plugins] loaded ${manifest.id} v${manifest.version}`);
    } catch (e) {
      rec.health = "errored";
      rec.lastError = errMsg(e);
      console.warn(`[plugins] ${manifest.id} failed to register: ${errMsg(e)}`);
    }
  }

  /** Resolve the plugin's entry file: package.json `main`, else index.{ts,js,mjs,tsx}. */
  private async resolveEntry(dir: string): Promise<string | null> {
    try {
      const pkgRaw = await readFile(join(dir, "package.json"), "utf8");
      const main = (JSON.parse(pkgRaw) as { main?: unknown }).main;
      if (typeof main === "string" && main.length > 0) {
        const p = join(dir, main);
        if (await exists(p)) return p;
      }
    } catch {
      // no package.json — fall through to index.* resolution
    }
    for (const cand of ["index.ts", "index.js", "index.mjs", "index.tsx"]) {
      const p = join(dir, cand);
      if (await exists(p)) return p;
    }
    return null;
  }

  private async readConfig(dir: string): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(join(dir, "config.json"), "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Build the per-plugin `ctx` — the sole seam. No raw core singletons handed out. */
  private makeContext(rec: LoadedPlugin): PluginContext {
    const id = rec.manifest.id;
    const log: PluginLogger = {
      log: (...a) => console.log(`[plugin:${id}]`, ...a),
      warn: (...a) => console.warn(`[plugin:${id}]`, ...a),
    };
    const state: PluginState = {
      get: <T = unknown>(key: string): T | null => {
        const raw = this.deps.store.getPluginState(id, key);
        if (raw === null) return null;
        try {
          return JSON.parse(raw) as T;
        } catch {
          return null;
        }
      },
      set: (key, value) => this.deps.store.setPluginState(id, key, JSON.stringify(value ?? null)),
      delete: (key) => this.deps.store.deletePluginState(id, key),
      keys: () => this.deps.store.listPluginStateKeys(id),
    };
    return {
      manifest: Object.freeze({ ...rec.manifest }),
      onSpawn: (fn) => {
        rec.hooks.push(fn);
        this.allSpawnHooks.push({ pluginId: id, fn });
      },
      events: {
        subscribe: (fn) => {
          const unsub = this.deps.events.subscribe(fn);
          rec.unsubs.push(unsub);
          return unsub;
        },
      },
      publishStatus: (status) => {
        rec.status = status;
        this.emitStatus(rec);
      },
      state,
      route: (method, path, handler) => {
        rec.routes.set(routeKey(method, path), handler);
      },
      log,
      config: rec.config,
      abortSpawn: (reason) => {
        throw new PluginSpawnAborted(reason, id);
      },
    };
  }

  /** Run every registered `onSpawn` hook in registration order, each timeout-bounded,
   *  merging patches sequentially (env shallow-merge, extraArgs append, credentialDir
   *  last-write-wins; conflicts logged). FAIL-OPEN by default — a throw/timeout drops
   *  that patch and marks the plugin errored/timed-out — EXCEPT `abortSpawn`, whose
   *  `PluginSpawnAborted` propagates so the spawn path can hard-block. */
  async runSpawnHooks(descriptor: SpawnDescriptor): Promise<SpawnPatch> {
    const merger = new SpawnPatchMerger();
    for (const { pluginId, fn } of this.allSpawnHooks) {
      const patch = await this.runOneHook(pluginId, fn, descriptor);
      if (patch) merger.merge(patch, pluginId);
    }
    return merger.result();
  }

  /** Emit a `plugin:status` event carrying this plugin's CURRENT core-derived health +
   *  last-published blob. Fired both on an explicit publishStatus and on a health flip,
   *  so the live panel never shows stale (e.g. `ok`) health after a hook fails. */
  private emitStatus(rec: LoadedPlugin): void {
    this.deps.events.emit("plugin:status", {
      id: rec.manifest.id,
      health: rec.health,
      status: rec.status,
    });
  }

  /** Invoke one hook, timeout-bounded. Returns its patch, or null on a fail-open
   *  error/timeout (the plugin's health is marked). Rethrows PluginSpawnAborted so the
   *  caller (prepareSpawn) can hard-block the spawn. */
  private async runOneHook(
    pluginId: string,
    fn: SpawnHook,
    descriptor: SpawnDescriptor,
  ): Promise<SpawnPatch | null> {
    try {
      return (await this.withTimeout(Promise.resolve(fn(descriptor)), pluginId)) || null;
    } catch (e) {
      if (e instanceof PluginSpawnAborted) throw e;
      const rec = this.plugins.get(pluginId);
      if (rec) {
        rec.health = e instanceof HookTimeoutError ? "timed-out" : "errored";
        rec.lastError = errMsg(e);
        // Push the health flip to any open Settings → Plugins panel so the badge
        // reflects errored/timed-out live, without waiting for the next publishStatus.
        this.emitStatus(rec);
      }
      console.warn(
        `[plugins] ${pluginId} onSpawn failed (fail-open, spawn proceeds): ${errMsg(e)}`,
      );
      return null;
    }
  }

  private withTimeout<T>(p: Promise<T>, pluginId: string): Promise<T> {
    const ms = this.deps.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HookTimeoutError(pluginId, ms)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  /** Dispatch a `/api/plugins/<id>/<subPath>` request to a plugin-registered route.
   *  Returns null when no plugin/route matches (caller falls through to a 404). */
  async handleRoute(
    method: string,
    pluginId: string,
    subPath: string,
    req: Request,
  ): Promise<Response | null> {
    const rec = this.plugins.get(pluginId);
    if (!rec) return null;
    const handler = rec.routes.get(routeKey(method, subPath));
    if (!handler) return null;
    return await handler(req);
  }

  /** Panel/list view. Empty array when no plugins are loaded (UI hides the section). */
  list(): PluginInfo[] {
    return [...this.plugins.values()].map((r) => ({
      id: r.manifest.id,
      name: r.manifest.name,
      version: r.manifest.version,
      health: r.health,
      lastError: r.lastError,
      status: r.status,
    }));
  }

  loadedCount(): number {
    return this.plugins.size;
  }

  /** Invoke each plugin's teardown + drop its event subscriptions (best-effort). */
  teardown(): void {
    for (const rec of this.plugins.values()) {
      for (const unsub of rec.unsubs) {
        try {
          unsub();
        } catch {
          /* ignore */
        }
      }
      if (rec.teardown) {
        try {
          rec.teardown();
        } catch (e) {
          console.warn(`[plugins] ${rec.manifest.id} teardown failed: ${errMsg(e)}`);
        }
      }
    }
  }
}

/** Folds successive SpawnPatches into one: env shallow-merge, extraArgs append,
 *  credentialDir last-write-wins. Conflicting keys are logged (last write applied). */
class SpawnPatchMerger {
  private readonly env: Record<string, string> = {};
  private readonly extraArgs: string[] = [];
  private credentialDir: string | undefined;

  merge(patch: SpawnPatch, pluginId: string): void {
    if (patch.env) {
      for (const [k, v] of Object.entries(patch.env)) {
        if (k in this.env && this.env[k] !== v) {
          console.warn(`[plugins] ${pluginId} overrides env "${k}" (last-write-wins)`);
        }
        this.env[k] = v;
      }
    }
    if (patch.extraArgs?.length) this.extraArgs.push(...patch.extraArgs);
    if (patch.credentialDir !== undefined) {
      if (this.credentialDir !== undefined && this.credentialDir !== patch.credentialDir) {
        console.warn(`[plugins] ${pluginId} overrides credentialDir (last-write-wins)`);
      }
      this.credentialDir = patch.credentialDir;
    }
  }

  result(): SpawnPatch {
    const merged: SpawnPatch = {};
    if (Object.keys(this.env).length) merged.env = this.env;
    if (this.extraArgs.length) merged.extraArgs = this.extraArgs;
    if (this.credentialDir !== undefined) merged.credentialDir = this.credentialDir;
    return merged;
  }
}

/** Stable route-table key: `"GET /status"`. Leading slashes on the path are normalized. */
function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} /${path.replace(/^\/+/, "")}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
