/**
 * Readiness "Framework majors" (#3113): reads the repo's manifests and CLAUDE.md pins, looks the
 * tracked packages up in the registries, runs the pure checks in `readiness-drift-core.ts`, and
 * files the upgrade story through the forge.
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { GitForge } from "./forge/types";
import type { HouseStack, HouseStackResolver } from "./house-stack";
import { mapBounded } from "./map-bounded";
import { PRIORITY_LABEL } from "./drain-core";
import {
  claudeMdPins,
  dependabotBumps,
  driftKey,
  driftRows,
  parseCargoToml,
  parsePackageJson,
  renderUpgradeStory,
  resolverState,
  trackedDeclared,
  trackedKeys,
  UPGRADE_STORY_MARKER,
  type DeclaredDep,
  type DeclaredPackage,
  type FrameworkDrift,
} from "./readiness-drift-core";

const execFileP = promisify(execFile);

/** Manifests read per scan; directories below the repo root searched. */
const MAX_MANIFESTS = 50;
const MAX_DEPTH = 2;
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "vendor"]);
const RESOLVE_CONCURRENCY = 6;
const LS_REMOTE_TIMEOUT_MS = 5_000;

export interface DriftDeps {
  resolver: Pick<HouseStackResolver, "resolve">;
  forge: GitForge | null;
  houseStack: HouseStack;
  autoLabel: string;
  /** Parent issue of the repo's running epic, if any. */
  runningEpic: number | null;
  /** Open `epic/*` branches on the remote; defaults to `git ls-remote`. */
  listEpicBranches?: (dir: string) => Promise<string[]>;
}

/** One directory's manifests (pushed onto `out`) and the subdirectories worth descending into. */
async function scanDir(root: string, d: string, out: string[]): Promise<string[]> {
  const subdirs: string[] = [];
  for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && (e.name === "package.json" || e.name === "Cargo.toml")) {
      out.push(relative(root, join(d, e.name)));
    } else if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) {
      subdirs.push(join(d, e.name));
    }
  }
  return subdirs;
}

/** Manifest paths (relative to `dir`) at the root and up to {@link MAX_DEPTH} levels below. */
async function findManifests(dir: string): Promise<string[]> {
  const out: string[] = [];
  let level = [dir];
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    const next: string[] = [];
    for (const d of level) {
      next.push(...(await scanDir(dir, d, out)));
      if (out.length >= MAX_MANIFESTS) return out.slice(0, MAX_MANIFESTS);
    }
    level = next;
  }
  return out;
}

async function readDeclared(dir: string): Promise<DeclaredDep[]> {
  const manifests = await findManifests(dir);
  const parsed = await Promise.all(
    manifests.map(async (m) => {
      const text = await readFile(join(dir, m), "utf8").catch(() => "");
      return m.endsWith("Cargo.toml") ? parseCargoToml(text, m) : parsePackageJson(text, m);
    }),
  );
  return parsed.flat();
}

/** Registry version per package; null where the lookup failed (offline, 404, …). Looked up one
 *  package at a time so one unreachable package never voids the others. */
async function lookupLatest(
  packages: DeclaredPackage[],
  resolver: DriftDeps["resolver"],
): Promise<Map<string, string | null>> {
  const results = await mapBounded(packages, RESOLVE_CONCURRENCY, async (p) => {
    const res = await resolver
      .resolve({
        npm: p.ecosystem === "npm" ? [p.name] : [],
        crates: p.ecosystem === "crates" ? [p.name] : [],
        rustToolchain: false,
      })
      .catch(() => null);
    const version = res?.ok ? (res[p.ecosystem][0]?.version ?? null) : null;
    return [driftKey(p.ecosystem, p.name), version] as const;
  });
  return new Map(results);
}

async function gitEpicBranches(dir: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["ls-remote", "--heads", "origin", "refs/heads/epic/*"],
      // No credential prompt: an auth-walled remote fails fast instead of hanging to the timeout.
      {
        cwd: dir,
        timeout: LS_REMOTE_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    return stdout
      .split("\n")
      .map((l) => l.split("\t")[1]?.replace(/^refs\/heads\//, ""))
      .filter((b): b is string => !!b)
      .sort();
  } catch {
    return [];
  }
}

/** The forge to read/write, or null for none / a fork (whose issues aren't the operator's). */
function usableForge(forge: GitForge | null): GitForge | null {
  return forge && !forge.isFork ? forge : null;
}

async function openStory(forge: GitForge): Promise<{ number: number; url: string } | null> {
  const issue = (await forge.listIssues()).find((i) => i.body.includes(UPGRADE_STORY_MARKER));
  return issue ? { number: issue.number, url: issue.url } : null;
}

async function dependabotSignal(forge: GitForge | null) {
  if (!forge) return new Map();
  try {
    return dependabotBumps(await forge.listPullRequests());
  } catch {
    return new Map();
  }
}

export async function frameworkDrift(dir: string, deps: DriftDeps): Promise<FrameworkDrift> {
  const forge = usableForge(deps.forge);
  const claudeMd = await readFile(join(dir, "CLAUDE.md"), "utf8").catch(() => "");
  const tracked = trackedKeys(deps.houseStack, claudeMdPins(claudeMd));
  const packages = trackedDeclared(await readDeclared(dir), tracked);
  const [latest, bumps, epicBranches, story] = await Promise.all([
    lookupLatest(packages, deps.resolver),
    dependabotSignal(forge),
    (deps.listEpicBranches ?? gitEpicBranches)(dir).catch(() => []),
    forge ? openStory(forge).catch(() => null) : null,
  ]);
  const rows = driftRows(packages, latest, bumps);
  return {
    rows,
    resolver: resolverState(rows),
    epicBranches,
    runningEpic: deps.runningEpic,
    canCreateStory: !!forge?.createIssue,
    openStory: story,
  };
}

/** Thrown when there is nothing to file: no package behind, or no forge that can create issues. */
export class UpgradeStoryNotApplicableError extends Error {}

export type UpgradeStoryResult = { status: "created" | "exists"; number: number; url: string };

/** File the upgrade story (re-checks first, so it never acts on a stale view). An open story
 *  already filed for this repo is returned instead of a duplicate. */
export async function createUpgradeStory(
  dir: string,
  deps: DriftDeps,
): Promise<UpgradeStoryResult> {
  const forge = usableForge(deps.forge);
  if (!forge?.createIssue) throw new UpgradeStoryNotApplicableError("unsupported");
  const drift = await frameworkDrift(dir, deps);
  const behind = drift.rows.filter((r) => r.state === "behind");
  if (!behind.length) throw new UpgradeStoryNotApplicableError("no_drift");
  // Dedupe against a fresh read: a failed listing throws rather than risk a duplicate story.
  const existing = await openStory(forge);
  if (existing) return { status: "exists", ...existing };
  const issue = await forge.createIssue(renderUpgradeStory(behind, drift.epicBranches));
  // Queue it ahead of other label-drain work. The issue exists either way, so a label failure
  // is logged, not surfaced as a failed create.
  for (const label of [deps.autoLabel, PRIORITY_LABEL]) {
    await forge.addIssueLabel?.(issue.number, label).catch((e: unknown) => {
      console.warn(`[readiness-drift] label ${label} on #${issue.number} failed:`, e);
    });
  }
  return { status: "created", ...issue };
}
