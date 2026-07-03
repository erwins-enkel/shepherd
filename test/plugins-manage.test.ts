// Plugin install/uninstall/scan management (Settings → Plugins install-from-URL). Covers
// strict URL validation, the on-disk scan (loaded/disabled/broken/symlink), install-time
// collision + apiVersion rejection with clone cleanup, and symlink-safe/traversal-safe
// uninstall. The git clone is injected so no network/git is touched.
import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGithubUrl,
  scanInstalled,
  installPlugin,
  uninstallPlugin,
  type CloneFn,
} from "../src/plugins/manage";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "shep-plugins-"));
}

function writePlugin(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
}

const validManifest = (id: string) => ({ id, name: id, version: "1.0.0", apiVersion: 1 });

// A clone stub that materializes a folder with the given manifest (or nothing, to simulate
// a repo with no plugin.json).
const cloneWith = (manifest: Record<string, unknown> | null): CloneFn => {
  return async (_url, dest) => {
    mkdirSync(dest, { recursive: true });
    if (manifest) writeFileSync(join(dest, "plugin.json"), JSON.stringify(manifest));
  };
};

// ── parseGithubUrl ────────────────────────────────────────────────────────────

test("parseGithubUrl accepts a github https repo url and derives the folder", () => {
  expect(parseGithubUrl("https://github.com/owner/my-repo")).toEqual({
    ok: true,
    folder: "my-repo",
  });
  expect(parseGithubUrl("https://github.com/owner/my-repo.git")).toEqual({
    ok: true,
    folder: "my-repo",
  });
});

test("parseGithubUrl rejects non-github / credentialed / non-https / non-repo urls", () => {
  // Exact-hostname check — a look-alike host must NOT pass.
  expect(parseGithubUrl("https://github.com.evil.com/owner/repo").ok).toBe(false);
  expect(parseGithubUrl("https://evilgithub.com/owner/repo").ok).toBe(false);
  // Embedded credentials.
  expect(parseGithubUrl("https://user:pass@github.com/owner/repo").ok).toBe(false);
  // Non-https.
  expect(parseGithubUrl("http://github.com/owner/repo").ok).toBe(false);
  expect(parseGithubUrl("git@github.com:owner/repo.git").ok).toBe(false);
  // Missing repo segment.
  expect(parseGithubUrl("https://github.com/owner").ok).toBe(false);
  expect(parseGithubUrl("not a url").ok).toBe(false);
});

// ── scanInstalled ─────────────────────────────────────────────────────────────

test("scanInstalled reports loaded / disabled / broken folders", async () => {
  const dir = tmp();
  writePlugin(join(dir, "alpha"), validManifest("alpha"));
  writePlugin(join(dir, "beta"), { ...validManifest("beta"), enabled: false });
  mkdirSync(join(dir, "brokenfolder"), { recursive: true }); // no plugin.json

  const rows = await scanInstalled(dir, new Set(["alpha"]));
  const byFolder = Object.fromEntries(rows.map((r) => [r.folder, r]));

  expect(byFolder.alpha).toMatchObject({
    id: "alpha",
    loaded: true,
    disabled: false,
    broken: false,
  });
  expect(byFolder.beta).toMatchObject({ id: "beta", loaded: false, disabled: true, broken: false });
  // Broken row is keyed by folder name and is removable (has a folder).
  expect(byFolder.brokenfolder).toMatchObject({
    id: "brokenfolder",
    folder: "brokenfolder",
    broken: true,
  });
});

test("scanInstalled follows a symlinked plugin dir and is null-registry safe", async () => {
  const dir = tmp();
  const external = tmp();
  writePlugin(join(external, "src-checkout"), validManifest("linked"));
  symlinkSync(join(external, "src-checkout"), join(dir, "linked"));

  const rows = await scanInstalled(dir, new Set()); // empty set == no registry
  expect(rows.find((r) => r.id === "linked")).toMatchObject({ loaded: false, broken: false });
});

test("scanInstalled on a missing dir returns an empty list", async () => {
  expect(await scanInstalled(join(tmp(), "nope"), new Set())).toEqual([]);
});

// ── installPlugin ─────────────────────────────────────────────────────────────

test("installPlugin clones a valid plugin and returns its manifest info", async () => {
  const dir = tmp();
  const res = await installPlugin(
    dir,
    "https://github.com/o/cool-plugin",
    new Set(),
    cloneWith(validManifest("cool")),
  );
  expect(res).toEqual({
    ok: true,
    plugin: { id: "cool", name: "cool", version: "1.0.0", folder: "cool-plugin" },
  });
  expect(existsSync(join(dir, "cool-plugin", "plugin.json"))).toBe(true);
});

test("installPlugin rejects a folder-name collision without cloning", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "cool-plugin"), { recursive: true });
  let cloned = false;
  const spy: CloneFn = async (u, d) => {
    cloned = true;
    await cloneWith(validManifest("cool"))(u, d);
  };
  const res = await installPlugin(dir, "https://github.com/o/cool-plugin", new Set(), spy);
  expect(res).toEqual({ ok: false, error: "folder_exists" });
  expect(cloned).toBe(false);
});

test("installPlugin rejects apiVersion mismatch and removes the clone", async () => {
  const dir = tmp();
  const res = await installPlugin(
    dir,
    "https://github.com/o/badver",
    new Set(),
    cloneWith({ ...validManifest("badver"), apiVersion: 99 }),
  );
  expect(res).toEqual({ ok: false, error: "api_version_mismatch" });
  expect(existsSync(join(dir, "badver"))).toBe(false); // cleaned up
});

test("installPlugin rejects a manifest-less repo and removes the clone", async () => {
  const dir = tmp();
  const res = await installPlugin(dir, "https://github.com/o/empty", new Set(), cloneWith(null));
  expect(res).toEqual({ ok: false, error: "invalid_manifest" });
  expect(existsSync(join(dir, "empty"))).toBe(false);
});

test("installPlugin rejects the reserved id 'manage'", async () => {
  const dir = tmp();
  const res = await installPlugin(
    dir,
    "https://github.com/o/manage",
    new Set(),
    cloneWith(validManifest("manage")),
  );
  expect(res).toEqual({ ok: false, error: "id_reserved" });
  expect(existsSync(join(dir, "manage"))).toBe(false);
});

test("installPlugin rejects an id already loaded", async () => {
  const dir = tmp();
  const res = await installPlugin(
    dir,
    "https://github.com/o/dup-repo",
    new Set(["dup"]),
    cloneWith(validManifest("dup")),
  );
  expect(res).toEqual({ ok: false, error: "id_collision" });
});

test("installPlugin rejects an id colliding with another installed folder", async () => {
  const dir = tmp();
  writePlugin(join(dir, "existing"), validManifest("shared")); // id 'shared' already on disk
  const res = await installPlugin(
    dir,
    "https://github.com/o/other-repo",
    new Set(),
    cloneWith(validManifest("shared")),
  );
  expect(res).toEqual({ ok: false, error: "id_collision" });
  expect(existsSync(join(dir, "other-repo"))).toBe(false);
});

test("installPlugin refuses a non-github url before cloning", async () => {
  const dir = tmp();
  let cloned = false;
  const res = await installPlugin(dir, "https://evil.com/o/repo", new Set(), async () => {
    cloned = true;
  });
  expect(res.ok).toBe(false);
  expect(cloned).toBe(false);
});

// ── uninstallPlugin ─────────────────────────────────────────────────────────────

test("uninstallPlugin removes a real plugin folder", async () => {
  const dir = tmp();
  writePlugin(join(dir, "gone"), validManifest("gone"));
  expect(await uninstallPlugin(dir, "gone")).toEqual({ ok: true });
  expect(existsSync(join(dir, "gone"))).toBe(false);
});

test("uninstallPlugin unlinks a symlinked install without touching the source checkout", async () => {
  const dir = tmp();
  const external = tmp();
  const source = join(external, "checkout");
  writePlugin(source, validManifest("linked"));
  symlinkSync(source, join(dir, "linked"));

  expect(await uninstallPlugin(dir, "linked")).toEqual({ ok: true });
  expect(existsSync(join(dir, "linked"))).toBe(false); // link gone
  expect(existsSync(join(source, "plugin.json"))).toBe(true); // real checkout intact
});

test("uninstallPlugin rejects traversal / separators", async () => {
  const dir = tmp();
  expect((await uninstallPlugin(dir, "..")).ok).toBe(false);
  expect((await uninstallPlugin(dir, ".")).ok).toBe(false);
  expect((await uninstallPlugin(dir, "a/b")).ok).toBe(false);
  expect((await uninstallPlugin(dir, "")).ok).toBe(false);
});

test("uninstallPlugin returns not_found for a missing folder", async () => {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  realpathSync(dir); // ensure dir exists so the realpath parent-check can run
  expect(await uninstallPlugin(dir, "ghost")).toEqual({ ok: false, error: "not_found" });
});
