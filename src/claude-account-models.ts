/**
 * Which account-granted Claude models the operator's LOGGED-IN Claude account is entitled to.
 *
 * Claude Mythos is not a model every account can spawn: it is granted per organization, and
 * the account's served model catalog marks it `confidential`. Shepherd must offer it only when
 * the account has it, and refuse it otherwise — so the pickers hide it and every spawn path
 * rejects it with {@link ModelUnavailableError} rather than letting the CLI fail mid-spawn.
 *
 * The signal is Claude Code's OWN on-disk account cache, read the way the CLI's
 * `isMythosAvailable` reads it (probed against Claude Code 2.1.311):
 *   1. `<claudeDir>/cache/model-catalog/<orgUuid>-<hash>-cc.json` — the account's served model
 *      catalog (`{ version: 2, fetchedAt, catalog: { config: { models: [{ id }] } } }`), refreshed
 *      by the CLI. Only files for the logged-in `oauthAccount.organizationUuid` count; the newest
 *      `fetchedAt` wins.
 *   2. Only when no such catalog exists: `.claude.json`'s `additionalModelOptionsCache`, the older
 *      list of extra models the account may pick (`{ value, disabled? }`, value may carry `[1m]`).
 *
 * Both files are CLI-internal, so every uncertainty FAILS CLOSED — missing, unreadable, an
 * unknown catalog version, no logged-in org — reads as "not available". Hiding a model the
 * account has is recoverable; offering one it doesn't is a spawn that dies.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigPath } from "./claude-trust";
import { config } from "./config";
import { isApiKeyMode } from "./spawn-auth";

/** The pinned Mythos id Shepherd offers. */
export const MYTHOS_MODEL = "claude-mythos-5-1";

/** Whether a model value selects the Mythos family (any pinned `claude-mythos-*` id). */
export function isMythosModel(model: string | null | undefined): model is string {
  return typeof model === "string" && model.startsWith("claude-mythos-");
}

/** A spawn or setting asked for a model the logged-in Claude account is not entitled to. */
export class ModelUnavailableError extends Error {
  constructor(readonly model: string) {
    super(`model ${model} is not available on the logged-in Claude account`);
    this.name = "ModelUnavailableError";
  }
}

/** Throw {@link ModelUnavailableError} for a Mythos model the account lacks; otherwise a no-op.
 *  `mythosAvailable` is a thunk so a non-Mythos spawn never touches the account caches. */
export function assertModelAvailable(
  model: string | null | undefined,
  mythosAvailable: () => boolean,
): void {
  if (isMythosModel(model) && !mythosAvailable()) throw new ModelUnavailableError(model);
}

const CATALOG_VERSION = 2;

/** One served-catalog file: its model ids and when the CLI fetched it. Null = unrecognised shape. */
export function parseCatalog(raw: unknown): { fetchedAt: number; ids: Set<string> } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const file = raw as { version?: unknown; fetchedAt?: unknown; catalog?: unknown };
  if (file.version !== CATALOG_VERSION) return null;
  const models = (file.catalog as { config?: { models?: unknown } } | undefined)?.config?.models;
  if (!Array.isArray(models)) return null;
  const ids = new Set<string>();
  for (const row of models) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id === "string") ids.add(id);
  }
  return { fetchedAt: typeof file.fetchedAt === "number" ? file.fetchedAt : 0, ids };
}

/** The logged-in org plus the `additionalModelOptionsCache` ids from a parsed `.claude.json`. */
export function parseAccountConfig(
  raw: unknown,
): { orgUuid: string; additional: Set<string> } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const cfg = raw as {
    oauthAccount?: { organizationUuid?: unknown };
    additionalModelOptionsCache?: unknown;
  };
  const orgUuid = cfg.oauthAccount?.organizationUuid;
  if (typeof orgUuid !== "string" || orgUuid === "") return null;
  const additional = new Set<string>();
  const options = cfg.additionalModelOptionsCache;
  for (const opt of Array.isArray(options) ? options : []) {
    const o = opt as { value?: unknown; disabled?: unknown } | null;
    if (typeof o?.value === "string" && o.disabled !== true)
      additional.add(o.value.replace(/\[1m\]$/, ""));
  }
  return { orgUuid, additional };
}

/** File access, injectable so tests can count reads. `mtimeMs` returns null for a missing file. */
export interface AccountModelsFs {
  readText(path: string): string;
  mtimeMs(path: string): number | null;
  list(dir: string): string[];
}

const nodeFs: AccountModelsFs = {
  readText: (path) => readFileSync(path, "utf8"),
  mtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

export interface AccountModels {
  /** Whether the logged-in account can spawn {@link MYTHOS_MODEL}. */
  mythosAvailable(): boolean;
}

/**
 * Build the account-model reader for a Claude config dir. Each parsed file is memoised by mtime:
 * `.claude.json` runs to megabytes and the check runs on every settings read and spawn, so a file
 * is re-parsed only after the CLI rewrote it.
 */
export function createAccountModels(
  paths: { home: string; claudeDir: string },
  fs: AccountModelsFs = nodeFs,
): AccountModels {
  const memo = new Map<string, { mtimeMs: number; value: unknown }>();

  function read<T>(path: string, parse: (raw: unknown) => T | null): T | null {
    const mtimeMs = fs.mtimeMs(path);
    if (mtimeMs === null) {
      memo.delete(path);
      return null;
    }
    const hit = memo.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value as T | null;
    let value: T | null;
    try {
      value = parse(JSON.parse(fs.readText(path)));
    } catch {
      value = null;
    }
    memo.set(path, { mtimeMs, value });
    return value;
  }

  function accountModelIds(): Set<string> | null {
    const account = read(claudeConfigPath(paths.home, paths.claudeDir), parseAccountConfig);
    if (account === null) return null;
    const dir = join(paths.claudeDir, "cache", "model-catalog");
    let newest: { fetchedAt: number; ids: Set<string> } | null = null;
    for (const name of fs.list(dir)) {
      if (!name.startsWith(`${account.orgUuid}-`) || !name.endsWith("-cc.json")) continue;
      const catalog = read(join(dir, name), parseCatalog);
      if (catalog && (newest === null || catalog.fetchedAt > newest.fetchedAt)) newest = catalog;
    }
    // The CLI consults the additional-options cache only when it has no served catalog.
    return newest?.ids ?? account.additional;
  }

  return { mythosAvailable: () => accountModelIds()?.has(MYTHOS_MODEL) ?? false };
}

let shared: AccountModels | null = null;
let forTest: (() => boolean) | null = null;

/** Test seam: pin {@link accountMythosAvailable} so the suite never reads the developer's real
 *  Claude caches. Production never sets it. */
export function __setAccountMythosAvailableForTest(fn: (() => boolean) | null): void {
  forTest = fn;
}

/**
 * Production wiring shared by the settings route, the session service and every transient-agent
 * spawn: the account logged in under THIS process's Claude config dir. An api-key spawn runs under
 * a key that login does not describe, so Mythos never counts as available in api-key mode.
 */
export function accountMythosAvailable(): boolean {
  if (forTest) return forTest();
  if (isApiKeyMode()) return false;
  shared ??= createAccountModels({ home: process.env.HOME ?? "", claudeDir: config.claudeDir });
  return shared.mythosAvailable();
}
