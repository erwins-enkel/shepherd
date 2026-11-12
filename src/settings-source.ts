/**
 * A settings source (#3967): one connected machine whose steers and repo emojis this Shepherd uses
 * instead of its own. While one is set, `GET`/`PUT /api/steers` and `/api/project-icons` read and
 * write the machine live through its stored token, and this Shepherd's own `steers` and
 * `projectIcons` settings stay exactly as they were — clearing the source brings them back.
 *
 * The machine's answers are untrusted input: a steers list must pass `validateSteers` and an emoji
 * map `validateIconMap` before it is returned, cached or emitted. The last good answer is kept in
 * the `settingsSourceCache` setting, so a machine out of reach (or a restart) still shows its
 * steers and emojis — read-only, since a write that cannot reach the machine is refused.
 *
 * Emojis are keyed by checkout path, which differs between machines; they are carried over by
 * forge slug (`translateIcons`, `sourceIconKeys`). Every request to the source carries
 * `SETTINGS_RELAY_HEADER`, which makes the machine answer from its OWN settings even if it has a
 * source of its own — one hop, so two Shepherds naming each other can never loop.
 */
import type { SessionStore } from "./store";
import type { Steer } from "./types";
import type { GitForge } from "./forge/types";
import { listRepos } from "./repos";
import { validateIconPatch, validateSteers } from "./validate";
import {
  type FetchLike,
  type RemoteRepo,
  type RemoteTarget,
  UUID_RE,
  getRemoteJson,
  isRecord,
  parseRemoteRepos,
  requestRemote,
} from "./remote-instances/client";
import { isSingleKeyBody } from "./remote-instances/identity";
import type { RemoteInstanceService } from "./remote-instances/service";

/** Sent on every request to a settings source: answer from your own settings, not your source's. */
export const SETTINGS_RELAY_HEADER = "x-shepherd-settings-relay";

const SOURCE_KEY = "settingsSource";
const CACHE_KEY = "settingsSourceCache";
/** The same bound `setIcon` keeps a local map to. */
const ICON_MAP_MAX = 500;
const PROJECT_PREFIX = "project:";

/** One of this Shepherd's checkouts, as the emoji translation matches it. */
export interface LocalRepo {
  path: string;
  realPath: string;
  slug: string | null;
}

/** What `GET /api/settings-source` reports. `repos` is the source's checkout list, live while it
 *  answers and cached otherwise — the UI matches the source's repo-bound steers against it. */
export interface SettingsSourceView {
  instanceId: string;
  name: string;
  reachable: boolean;
  repos: RemoteRepo[];
}

export type SettingsSourceErrorCode =
  "settings_source_unreachable" | "settings_source_failed" | "settings_source_no_repo";

/** The English sentence beside each code; the UI shows its own localized text for the code. */
export const SETTINGS_SOURCE_ERRORS: Record<SettingsSourceErrorCode, string> = {
  settings_source_unreachable:
    "The settings source machine is out of reach; its steers and repo emojis are read-only until it answers again.",
  settings_source_failed: "The settings source machine refused or garbled the change.",
  settings_source_no_repo: "The settings source machine has no checkout of this repo.",
};

type SourceFailure = { ok: false; status: 409 | 502 | 503; code: SettingsSourceErrorCode };
export type SettingsSourceWrite<T> = { ok: true; value: T } | SourceFailure;

const UNREACHABLE: SourceFailure = {
  ok: false,
  status: 503,
  code: "settings_source_unreachable",
};
const FAILED: SourceFailure = { ok: false, status: 502, code: "settings_source_failed" };
const NO_REPO: SourceFailure = { ok: false, status: 409, code: "settings_source_no_repo" };

/** The last good answers from the source, raw: icons keyed by the SOURCE's paths. */
interface SourceCache {
  instanceId: string;
  steers: Steer[] | null;
  icons: Record<string, string> | null;
  repos: RemoteRepo[] | null;
}

/**
 * Validate a whole repo-emoji map from another machine: an object of at most 500 entries, every
 * key and value passing `validateIconPatch` (a non-empty emoji — a map never stores a cleared one).
 * All or nothing: one bad entry rejects the map, so a garbled answer never half-replaces the cache.
 */
export function validateIconMap(body: unknown): Record<string, string> | null {
  if (!isRecord(body)) return null;
  const entries = Object.entries(body);
  if (entries.length > ICON_MAP_MAX) return null;
  const out: [string, string][] = [];
  for (const [path, emoji] of entries) {
    const patch = validateIconPatch({ path, emoji });
    if (!patch || patch.emoji === "") return null;
    out.push([patch.path, patch.emoji]);
  }
  return Object.fromEntries(out);
}

function sameSlug(a: string | null | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

function repoAt<T extends { path: string; realPath: string }>(
  repos: readonly T[],
  path: string,
): T | undefined {
  return repos.find((repo) => repo.path === path || repo.realPath === path);
}

/** Every key a source emoji also answers to here: the checkout's other path form, and — when it
 *  has a slug — `project:<slug>` and each local checkout of that project. */
function iconAliases(repo: RemoteRepo, localRepos: readonly LocalRepo[]): string[] {
  const aliases = [repo.path, repo.realPath];
  const slug = repo.remoteSlug;
  if (!slug) return aliases;
  // The UI keys a project chip `project:<slug>` in lower case (`projectFilterKey`).
  aliases.push(`${PROJECT_PREFIX}${slug.toLowerCase()}`);
  for (const local of localRepos) {
    if (sameSlug(local.slug, slug)) aliases.push(local.path, local.realPath);
  }
  return aliases;
}

/**
 * The source's emoji map as this Shepherd keys it. Every source key is kept as it is (a mirrored
 * session of the source names its checkout by the source's path); then each emoji is added under
 * the aliases of its checkout, first one wins, never over an exact source key. This Shepherd's own
 * map is not merged in: a repo the source has no emoji for shows none.
 */
export function translateIcons(
  source: Record<string, string>,
  sourceRepos: readonly RemoteRepo[],
  localRepos: readonly LocalRepo[],
): Record<string, string> {
  const out = new Map(Object.entries(source));
  for (const [key, emoji] of Object.entries(source)) {
    const repo = repoAt(sourceRepos, key);
    if (!repo) continue;
    for (const alias of iconAliases(repo, localRepos)) {
      if (!out.has(alias)) out.set(alias, emoji);
    }
  }
  return Object.fromEntries(out);
}

/** The source checkouts an emoji change made here is about: one of the source's own checkouts as
 *  given, or — for `project:<slug>` or a local checkout — every source checkout of that project. */
function targetRepos(
  path: string,
  sourceRepos: readonly RemoteRepo[],
  localRepos: readonly LocalRepo[],
): RemoteRepo[] {
  const direct = repoAt(sourceRepos, path);
  if (direct) return [direct];
  const slug = path.startsWith(PROJECT_PREFIX)
    ? path.slice(PROJECT_PREFIX.length)
    : repoAt(localRepos, path)?.slug;
  return slug ? sourceRepos.filter((repo) => sameSlug(repo.remoteSlug, slug)) : [];
}

/**
 * The keys of the source's emoji map an emoji change made here writes, so what this Shepherd shows
 * changes the way it was asked. A pick replaces the emoji that is shown — the first key of those
 * checkouts in the source's map, as `translateIcons` picks it — or, with none yet, lands on the
 * first checkout. A clear removes every key of those checkouts, so no other one's emoji surfaces in
 * its place. Null when the source has no checkout of that project (or the path is no project).
 */
export function sourceIconKeys(
  path: string,
  emoji: string,
  sourceMap: Record<string, string>,
  sourceRepos: readonly RemoteRepo[],
  localRepos: readonly LocalRepo[],
): string[] | null {
  const repos = targetRepos(path, sourceRepos, localRepos);
  if (repos.length === 0) return null;
  const shown = Object.keys(sourceMap).filter((key) => repoAt(repos, key));
  if (emoji === "") return shown.length > 0 ? shown : [repos[0]!.path];
  return [shown[0] ?? repos[0]!.path];
}

/** This Shepherd's checkouts with their project, the way `GET /api/repos` derives `remoteSlug`
 *  (a fork's clone origin, not its upstream). */
export function localRepoIndex(
  root: string,
  resolveForge: ((repoDir: string) => GitForge | null) | undefined,
): LocalRepo[] {
  return listRepos(root).map((repo) => {
    const forge = resolveForge?.(repo.path) ?? null;
    return {
      path: repo.path,
      realPath: repo.realPath,
      slug: forge?.originSlug ?? forge?.slug ?? null,
    };
  });
}

/** A `PUT /api/settings-source` body: exactly `{ instanceId }`, an instance ID or null (none).
 *  Undefined when the body is anything else. */
export function parseSettingsSourceBody(body: unknown): string | null | undefined {
  if (!isSingleKeyBody(body, "instanceId")) return undefined;
  const { instanceId } = body;
  if (instanceId === null) return null;
  return typeof instanceId === "string" && UUID_RE.test(instanceId) ? instanceId : undefined;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseRepoList(value: unknown): RemoteRepo[] | null {
  return Array.isArray(value) ? parseRemoteRepos(value) : null;
}

/** The persisted cache for `instanceId`, revalidated as if it had just arrived — a corrupt or
 *  foreign one reads as empty. */
function parseCache(raw: string | null, instanceId: string): SourceCache {
  const parsed = parseJson(raw);
  if (!isRecord(parsed) || parsed.instanceId !== instanceId) {
    return { instanceId, steers: null, icons: null, repos: null };
  }
  return {
    instanceId,
    steers: parsed.steers == null ? null : validateSteers(parsed.steers),
    icons: parsed.icons == null ? null : validateIconMap(parsed.icons),
    repos: parseRepoList(parsed.repos),
  };
}

function parseSourceSetting(raw: string | null): string | null {
  const parsed = parseJson(raw);
  return isRecord(parsed) && typeof parsed.instanceId === "string" ? parsed.instanceId : null;
}

type Store = Pick<
  SessionStore,
  "getSetting" | "setSetting" | "deleteSetting" | "getRemoteInstance"
>;
type Instances = Pick<RemoteInstanceService, "get" | "repoIndex" | "onChange">;

export interface SettingsSourceDeps {
  store: Store;
  instances: Instances;
  /** This Shepherd's event hub: every change of the effective steers, emojis or source. */
  emit: (event: string, data: unknown) => void;
  localRepos: () => readonly LocalRepo[];
  /** This Shepherd's own steers and emojis — what is effective while no source is set. */
  localSteers: () => Steer[];
  localIcons: () => Record<string, string>;
  fetch?: FetchLike;
}

export class SettingsSourceService {
  private readonly store: Store;
  private readonly instances: Instances;
  private readonly emit: SettingsSourceDeps["emit"];
  private readonly localRepos: SettingsSourceDeps["localRepos"];
  private readonly localSteers: SettingsSourceDeps["localSteers"];
  private readonly localIcons: SettingsSourceDeps["localIcons"];
  private readonly fetch: FetchLike | undefined;
  private instanceId: string | null;
  private cache: SourceCache | null;
  /** Whether the source answered at its last probe: a new answer refreshes the cache. */
  private wasReachable = false;
  /** The last view sent as `settings-source:update`, so a probe round that changed nothing
   *  wakes no client. */
  private viewSignature: string;

  constructor(deps: SettingsSourceDeps) {
    this.store = deps.store;
    this.instances = deps.instances;
    this.emit = deps.emit;
    this.localRepos = deps.localRepos;
    this.localSteers = deps.localSteers;
    this.localIcons = deps.localIcons;
    this.fetch = deps.fetch;
    const id = parseSourceSetting(this.store.getSetting(SOURCE_KEY));
    // A machine removed while this Shepherd was down took its source role with it.
    this.instanceId = id && this.store.getRemoteInstance(id) ? id : null;
    if (id && !this.instanceId) this.forget();
    this.cache = this.instanceId
      ? parseCache(this.store.getSetting(CACHE_KEY), this.instanceId)
      : null;
    this.viewSignature = JSON.stringify(this.view());
    this.instances.onChange((changed) => this.onInstanceChange(changed));
  }

  /** True while a source is set — the steers and emoji routes then go through this service. */
  active(): boolean {
    return this.instanceId !== null;
  }

  view(): SettingsSourceView | null {
    const id = this.instanceId;
    const machine = id ? this.instances.get(id) : null;
    if (!id || !machine) return null;
    return {
      instanceId: id,
      name: machine.name,
      reachable: machine.status === "connected",
      repos: this.sourceRepos(),
    };
  }

  /**
   * Make `instanceId` the source (null = none). A change starts from an empty cache — another
   * machine's answers never show under this one — and announces the now effective steers and
   * emojis at once; a reachable source is then read in the background.
   */
  set(instanceId: string | null): { ok: true; view: SettingsSourceView | null } | { ok: false } {
    if (instanceId !== null && !this.store.getRemoteInstance(instanceId)) return { ok: false };
    if (instanceId === this.instanceId) return { ok: true, view: this.view() };
    if (instanceId === null) {
      this.instanceId = null;
      this.cache = null;
      this.forget();
    } else {
      this.instanceId = instanceId;
      const live = this.instances.repoIndex(instanceId);
      this.cache = { instanceId, steers: null, icons: null, repos: live.length ? [...live] : null };
      this.store.setSetting(SOURCE_KEY, JSON.stringify({ instanceId }));
      this.persist();
    }
    this.announce();
    this.wasReachable = this.reachable();
    if (this.wasReachable) void this.refresh();
    return { ok: true, view: this.view() };
  }

  /** The source's steers: fresh while it answers, the last good list otherwise (`[]` before the
   *  first one — never this Shepherd's own, which would read as the source's). */
  async steers(): Promise<Steer[]> {
    const id = this.instanceId;
    if (!id) return this.localSteers();
    const list = validateSteers(await this.read(id, "/api/steers"));
    if (list && this.instanceId === id) this.storeSteers(list);
    return this.cache?.steers ?? [];
  }

  /** The source's emojis keyed for this Shepherd; same freshness rule as `steers`. */
  async icons(): Promise<Record<string, string>> {
    const id = this.instanceId;
    if (!id) return this.localIcons();
    const map = validateIconMap(await this.read(id, "/api/project-icons"));
    if (map && this.instanceId === id) this.storeIcons(map);
    return this.translated();
  }

  /** Replace the source's steers. Refused without a request while it is out of reach. */
  async putSteers(list: Steer[]): Promise<SettingsSourceWrite<Steer[]>> {
    const id = this.instanceId;
    const res = await this.write(id, "/api/steers", list);
    if (!res.ok) return res;
    const saved = validateSteers(res.body);
    if (!saved) return FAILED;
    if (this.instanceId === id) this.storeSteers(saved);
    return { ok: true, value: saved };
  }

  /** Set (or clear, `emoji` "") one repo's emoji on the source, under the source's own keys for
   *  that repo (`sourceIconKeys`, chosen against its current map). Answers with the whole map
   *  keyed for this Shepherd. */
  async putIcon(path: string, emoji: string): Promise<SettingsSourceWrite<Record<string, string>>> {
    const id = this.instanceId;
    if (!this.reachable()) return UNREACHABLE;
    if (!targetRepos(path, this.sourceRepos(), this.localRepos()).length) return NO_REPO;
    await this.icons(); // the keys depend on which emoji the source shows right now
    const keys = sourceIconKeys(
      path,
      emoji,
      this.cache?.icons ?? {},
      this.sourceRepos(),
      this.localRepos(),
    );
    if (!keys) return NO_REPO;
    for (const key of keys) {
      const res = await this.write(id, "/api/project-icons", { path: key, emoji });
      if (!res.ok) return res;
      const map = validateIconMap(res.body);
      if (!map) return FAILED;
      if (this.instanceId === id) this.storeIcons(map);
    }
    return { ok: true, value: this.translated() };
  }

  /** A settings frame from a machine's live socket: the source's own edits arrive here. The frame
   *  is only a signal — the source is re-read through the relay header instead. A source that has
   *  a source of its own announces THAT one's values, which must never be cached as its own. */
  onMachineEvent(instanceId: string, event: string): void {
    if (instanceId !== this.instanceId) return;
    if (event === "steers:update") void this.refreshing(this.steers());
    else if (event === "project-icons:update") void this.refreshing(this.icons());
  }

  /** Follow the source machine's probe: gone ⇒ no source; a new repo list re-keys the emojis; a
   *  first answer after an outage (or a restart) refreshes the cache. */
  private onInstanceChange(instanceId: string): void {
    if (instanceId !== this.instanceId) return;
    if (!this.instances.get(instanceId)) {
      this.set(null);
      return;
    }
    this.syncRepos(instanceId);
    const reachable = this.reachable();
    if (reachable && !this.wasReachable) void this.refresh();
    this.wasReachable = reachable;
    this.announceView();
  }

  private syncRepos(instanceId: string): void {
    const live = this.instances.repoIndex(instanceId);
    if (!this.cache || live.length === 0) return;
    if (JSON.stringify(live) === JSON.stringify(this.cache.repos)) return;
    this.cache.repos = [...live];
    this.persist();
    if (this.cache.icons) this.emit("project-icons:update", this.translated());
  }

  private reachable(): boolean {
    const id = this.instanceId;
    return !!id && this.instances.get(id)?.status === "connected";
  }

  private sourceRepos(): RemoteRepo[] {
    const id = this.instanceId;
    const live = id ? this.instances.repoIndex(id) : [];
    return live.length > 0 ? [...live] : (this.cache?.repos ?? []);
  }

  private translated(): Record<string, string> {
    return translateIcons(this.cache?.icons ?? {}, this.sourceRepos(), this.localRepos());
  }

  /** The source's answer to a GET, or undefined while it is out of reach or the request fails. */
  private async read(instanceId: string, path: string): Promise<unknown> {
    const row = this.reachable() ? this.store.getRemoteInstance(instanceId) : null;
    if (!row) return undefined;
    const res = await getRemoteJson(row, path, {
      fetch: this.fetch,
      headers: { [SETTINGS_RELAY_HEADER]: "1" },
    });
    return res.ok ? res.body : undefined;
  }

  private async write(
    instanceId: string | null,
    path: string,
    body: unknown,
  ): Promise<{ ok: true; body: unknown } | SourceFailure> {
    const row: RemoteTarget | null =
      instanceId && this.reachable() ? this.store.getRemoteInstance(instanceId) : null;
    if (!row) return UNREACHABLE;
    const res = await requestRemote(
      row,
      path,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          [SETTINGS_RELAY_HEADER]: "1",
        },
        body: JSON.stringify(body),
      },
      { fetch: this.fetch },
    );
    if (!res.ok) return UNREACHABLE;
    if (!res.response.ok) {
      await res.response.body?.cancel().catch(() => {});
      return FAILED;
    }
    return { ok: true, body: await res.response.json().catch(() => undefined) };
  }

  private storeSteers(list: Steer[]): void {
    if (!this.cache || JSON.stringify(list) === JSON.stringify(this.cache.steers)) return;
    this.cache.steers = list;
    this.persist();
    this.emit("steers:update", list);
  }

  private storeIcons(map: Record<string, string>): void {
    if (!this.cache || JSON.stringify(map) === JSON.stringify(this.cache.icons)) return;
    this.cache.icons = map;
    this.persist();
    this.emit("project-icons:update", this.translated());
  }

  private refresh(): Promise<void> {
    return this.refreshing(Promise.all([this.steers(), this.icons()]));
  }

  /** A background read of the source: it never throws, but a store error must log, not float. */
  private async refreshing(read: Promise<unknown>): Promise<void> {
    try {
      await read;
    } catch (err) {
      console.warn(
        "[settings-source] refresh failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** The effective source, steers and emojis after the source changed. */
  private announce(): void {
    const view = this.view();
    this.viewSignature = JSON.stringify(view);
    this.emit("settings-source:update", view);
    this.emit("steers:update", this.cache ? (this.cache.steers ?? []) : this.localSteers());
    this.emit("project-icons:update", this.cache ? this.translated() : this.localIcons());
  }

  private announceView(): void {
    const view = this.view();
    const signature = JSON.stringify(view);
    if (signature === this.viewSignature) return;
    this.viewSignature = signature;
    this.emit("settings-source:update", view);
  }

  private persist(): void {
    if (this.cache) this.store.setSetting(CACHE_KEY, JSON.stringify(this.cache));
  }

  private forget(): void {
    this.store.deleteSetting(SOURCE_KEY);
    this.store.deleteSetting(CACHE_KEY);
  }
}
