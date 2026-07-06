// Plugin management (install-from-URL / uninstall / on-disk scan) behind the
// Settings → Plugins manager. Kept OUT of loader.ts — which is boot-load only — so the
// install path never entangles with the register()/spawn-hook machinery. Every fs/git
// operation is async + bounded (the server is one Bun event loop; docs/plugins.md).
//
// Trust model unchanged: plugins run in-process with full server privileges and no sandbox.
// This module only makes the existing manual `git clone … ~/.shepherd/plugins/` flow
// reachable from the UI; it adds no capability a shell couldn't already do. The UI gates
// install behind a trust-confirm dialog. A freshly installed plugin is loaded in-process by
// `PluginRegistry.activateOne` (no restart); an uninstalled-but-loaded one still needs a
// restart to fully unload, as does editing/reconfiguring an already-loaded plugin.

import { readdir, readFile, lstat, stat, realpath, rm, unlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { PLUGIN_API_VERSION, type InstalledPlugin, type PluginManifest } from "./types";
import { validManifest } from "./loader";
import { browserRepositoryUrl } from "./repository";
import { classifyCloneError } from "../repos";

const execFileAsync = promisify(execFile);

/** Route segments directly under `/api/plugins/` that are NOT plugin ids. A plugin
 *  declaring one of these as its `id` would install fine but have its own
 *  `/api/plugins/<id>/*` routes permanently shadowed by the management handler, so install
 *  rejects them. Keep in sync with `handlePluginManagement`'s `parts[2] === "manage"` in
 *  server.ts. */
const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set(["manage"]);

const CLONE_TIMEOUT_MS = 60_000;

export type InstallResult =
  | { ok: true; plugin: { id: string; name: string; version: string; folder: string } }
  | { ok: false; error: string };

export type UninstallResult = { ok: true } | { ok: false; error: string };

/** How install shells out to git. Injectable so tests exercise the validation/collision
 *  logic without a network round-trip. Resolves on a successful clone into `dest`; rejects
 *  (like `execFile`) with an error `classifyCloneError` understands otherwise. */
export type CloneFn = (url: string, dest: string) => Promise<void>;

const defaultClone: CloneFn = async (url, dest) => {
  // `--` terminates options (no flag injection from a crafted URL/dest); the disabled
  // terminal prompt + no-system-config make a private/typo'd URL fail fast instead of
  // hanging on a credential prompt until the timeout (mirrors src/repos.ts).
  await execFileAsync("git", ["clone", "--depth", "1", "--", url, dest], {
    timeout: CLONE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  });
};

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Read + validate a folder's `plugin.json` with the loader's exact structural check
 *  ({@link validManifest}). Returns null when missing / unparseable / structurally invalid. */
async function readManifest(dir: string): Promise<PluginManifest | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, "plugin.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return validManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Strict GitHub-HTTPS validation + target-folder derivation. Rejects anything but an
 *  `https://github.com/<owner>/<repo>` URL: `hostname` must EQUAL `github.com` (an equality
 *  check, never a substring/suffix test — so `github.com.evil.com` and `evilgithub.com` are
 *  refused), and any embedded credentials (`user:pass@github.com`) are refused. */
export function parseGithubUrl(
  raw: string,
): { ok: true; folder: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "url_not_https" };
  if (u.hostname !== "github.com") return { ok: false, error: "url_not_github" };
  if (u.username !== "" || u.password !== "") return { ok: false, error: "url_has_credentials" };
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 2) return { ok: false, error: "url_not_repo" };
  const repo = segs[1]!.replace(/\.git$/, "");
  const folder = repo.replace(/[^A-Za-z0-9._-]/g, "-");
  // The sanitiser admits "." and "-", so an all-dots/dashes basename could yield "." / "..".
  if (folder === "" || folder === "." || folder === "..")
    return { ok: false, error: "url_not_repo" };
  return { ok: true, folder };
}

/** Scan the plugins dir into one row per folder for the manager. `loadedIds` are the
 *  manifest ids currently in the live registry (pass an empty set when there is no
 *  registry — never throws on a fresh clone). Mirrors the loader's directory handling:
 *  plain dirs + symlinks that resolve to a dir; other entries skipped. A folder without a
 *  valid manifest is surfaced as a minimal `broken` row keyed by folder name, so nothing on
 *  disk is invisible or un-removable. */
export async function scanInstalled(
  pluginsDir: string,
  loadedIds: ReadonlySet<string>,
): Promise<InstalledPlugin[]> {
  let entries;
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return []; // missing dir → nothing installed
  }
  const rows: InstalledPlugin[] = [];
  for (const e of entries) {
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = (await stat(join(pluginsDir, e.name))).isDirectory();
      } catch {
        continue; // dangling symlink — skip, like the loader
      }
    }
    if (!isDir) continue;
    const folder = e.name;
    const manifest = await readManifest(join(pluginsDir, folder));
    if (!manifest) {
      rows.push({
        id: folder,
        name: folder,
        version: "",
        folder,
        loaded: false,
        disabled: false,
        broken: true,
      });
      continue;
    }
    rows.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      repository: browserRepositoryUrl(manifest.repository),
      folder,
      loaded: loadedIds.has(manifest.id),
      disabled: manifest.enabled === false,
      broken: false,
    });
  }
  rows.sort((a, b) => a.folder.localeCompare(b.folder));
  return rows;
}

/** Clone a GitHub repo into the plugins dir. Validates the URL, refuses a folder-name
 *  collision (two repos sharing a basename — NOT the same as an id collision), clones, then
 *  validates the cloned manifest and rejects an apiVersion mismatch (a DELIBERATE
 *  stricter-than-loader block — the loader would surface it as an `errored` card; blocking
 *  up front is clearer, and a manual `git clone` remains the escape hatch to inspect it) or
 *  an id that collides with a loaded/installed plugin or a reserved route segment. On ANY
 *  rejection the clone is removed so no partial/dead folder is left behind. */
export async function installPlugin(
  pluginsDir: string,
  url: string,
  loadedIds: ReadonlySet<string>,
  clone: CloneFn = defaultClone,
): Promise<InstallResult> {
  const parsed = parseGithubUrl(url);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { folder } = parsed;
  const dest = join(pluginsDir, folder);

  if (await exists(dest)) return { ok: false, error: "folder_exists" };

  await mkdir(pluginsDir, { recursive: true }); // git clone needs the parent to exist

  try {
    await clone(url, dest);
  } catch (e) {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: classifyCloneError(e) };
  }

  const fail = async (error: string): Promise<InstallResult> => {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error };
  };

  const manifest = await readManifest(dest);
  if (!manifest) return fail("invalid_manifest");
  if (manifest.apiVersion !== PLUGIN_API_VERSION) return fail("api_version_mismatch");
  if (RESERVED_PLUGIN_IDS.has(manifest.id)) return fail("id_reserved");
  if (loadedIds.has(manifest.id)) return fail("id_collision");
  const installed = await scanInstalled(pluginsDir, loadedIds);
  if (installed.some((p) => p.folder !== folder && !p.broken && p.id === manifest.id)) {
    return fail("id_collision");
  }

  return {
    ok: true,
    plugin: { id: manifest.id, name: manifest.name, version: manifest.version, folder },
  };
}

/** Remove a plugin folder. Defense-in-depth path validation (the `[A-Za-z0-9._-]` folder
 *  sanitiser admits `..`): reject `.`/`..`/separators, then require the target's REAL
 *  parent to equal the real plugins dir. Symlink-aware: `unlink`s a symlinked install
 *  (the link only) rather than `rm -rf`-ing through it into the operator's real source
 *  checkout (`docs/plugins.md` recommends `ln -s`). Uninstalling a still-LOADED plugin
 *  removes the folder but cannot unload it from memory — a restart does that. */
export async function uninstallPlugin(
  pluginsDir: string,
  folder: string,
): Promise<UninstallResult> {
  if (
    folder === "" ||
    folder === "." ||
    folder === ".." ||
    folder.includes("/") ||
    folder.includes("\\")
  ) {
    return { ok: false, error: "invalid_folder" };
  }
  const target = join(pluginsDir, folder);

  let st;
  try {
    st = await lstat(target); // does NOT follow the link — so a symlink reports as one
  } catch {
    return { ok: false, error: "not_found" };
  }

  // For a symlinked entry validate the LINK's own location (its parent), not its resolved
  // destination — a legitimate symlinked install points OUTSIDE the plugins dir on purpose.
  let realParent: string, realPluginsDir: string;
  try {
    realParent = await realpath(dirname(target));
    realPluginsDir = await realpath(pluginsDir);
  } catch {
    return { ok: false, error: "not_found" };
  }
  if (realParent !== realPluginsDir) return { ok: false, error: "invalid_folder" };

  try {
    if (st.isSymbolicLink()) await unlink(target);
    else await rm(target, { recursive: true, force: true });
  } catch {
    return { ok: false, error: "remove_failed" };
  }
  return { ok: true };
}
