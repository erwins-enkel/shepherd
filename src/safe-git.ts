/**
 * The ONE way the server runs git against a managed repo or worktree (audit F01/F02/F05/F07).
 *
 * Agents (and fork-PR authors) control repo content: worktree files, the shared `.git`
 * config/hooks, and — inside a worktree — the `.git` gitfile itself. Plain host git over that
 * state runs their code as the operator, outside the sandbox: relative `core.hooksPath`
 * (husky's `.husky/_`) resolves into the worktree, `core.fsmonitor` runs on every status/diff,
 * `ext::` remotes run on fetch, `diff.external`/textconv run on diff, and a repo-relative merge
 * driver runs the branch's own script. This module:
 *
 * - prepends `-c` overrides that disable hooks, fsmonitor and the `ext::` transport
 *   (command-line config beats repo, worktree and included config);
 * - adds `--no-ext-diff --no-textconv` to `diff`/`log`/`show`;
 * - optionally pins `GIT_DIR`/`GIT_WORK_TREE` for a worktree from the TRUSTED repo path, never
 *   from the worktree's agent-writable `.git` gitfile ({@link resolveWorktreePin});
 * - names Shepherd's own copy of the i18n union merge driver ({@link trustedUnionDriverConfig}).
 *
 * Not neutralized (documented residual in docs/sandbox-security.md): `core.sshCommand`,
 * credential helpers and filter/merge/diff drivers set in agent-writable config.
 *
 * test/safe-git-guard.test.ts fails on any raw `execFile("git", …)` outside its allowlist.
 */
import {
  execFile,
  spawn,
  type ChildProcess,
  type ExecFileOptions,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnOptions,
} from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFileSync } from "./instrument";

const execFileP = promisify(execFile);

export const SAFE_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["protocol.ext.allow", "never"],
];

/** Subcommands that can render a patch, and so run `diff.external` / textconv drivers. */
const PATCH_SUBCOMMANDS = new Set(["diff", "log", "show"]);

/** Global options that consume the following argv entry. */
const GLOBAL_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** Index of the subcommand in `args` (skipping git's global options), or -1. */
function subcommandIndex(args: readonly string[]): number {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (GLOBAL_OPTS_WITH_VALUE.has(a)) i += 2;
    else if (a.startsWith("-")) i += 1;
    else return i;
  }
  return -1;
}

/** `args` with the hardening `-c` pairs (plus `extraConfig`) in front and, for patch-rendering
 *  subcommands, `--no-ext-diff --no-textconv` right after the subcommand. */
export function safeGitArgs(
  args: readonly string[],
  extraConfig: ReadonlyArray<readonly [string, string]> = [],
): string[] {
  const out = [...args];
  const sub = subcommandIndex(out);
  if (sub >= 0 && PATCH_SUBCOMMANDS.has(out[sub]!)) {
    out.splice(sub + 1, 0, "--no-ext-diff", "--no-textconv");
  }
  const config = [...SAFE_GIT_CONFIG, ...extraConfig].flatMap(([k, v]) => ["-c", `${k}=${v}`]);
  return [...config, ...out];
}

/** A worktree's git admin dir, resolved from the trusted repo path. */
export interface GitPin {
  gitDir: string;
  workTree: string;
}

export interface SafeGitOptions {
  /** Pin `GIT_DIR`/`GIT_WORK_TREE` (from {@link resolveWorktreePin}); null/undefined = no pin. */
  pin?: GitPin | null;
  /** Extra `-c key=value` pairs, applied after the hardening set. */
  config?: ReadonlyArray<readonly [string, string]>;
}

function safeEnv(env: NodeJS.ProcessEnv | undefined, pin: GitPin | null | undefined) {
  if (!pin) return env;
  return { ...(env ?? process.env), GIT_DIR: pin.gitDir, GIT_WORK_TREE: pin.workTree };
}

/** Hardened async git. Same options/result as `promisify(execFile)`; stdout is a string unless
 *  the caller asks for a buffer encoding. */
export async function execGit(
  args: readonly string[],
  opts: ExecFileOptions & SafeGitOptions & { encoding?: BufferEncoding } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { pin, config, ...rest } = opts;
  const r = await execFileP("git", safeGitArgs(args, config), {
    encoding: "utf8",
    ...rest,
    env: safeEnv(rest.env, pin),
  });
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
}

/** Hardened sync git (via `./instrument`'s execFileSync). Only for call sites that are already
 *  synchronous — never add new sync git to the server loop. */
export function execGitSync(
  args: readonly string[],
  opts: ExecFileSyncOptionsWithStringEncoding & SafeGitOptions,
): string;
export function execGitSync(
  args: readonly string[],
  opts?: ExecFileSyncOptions & SafeGitOptions,
): Buffer;
export function execGitSync(
  args: readonly string[],
  opts: ExecFileSyncOptions & SafeGitOptions = {},
): string | Buffer {
  const { pin, config, ...rest } = opts;
  return execFileSync("git", safeGitArgs(args, config), {
    ...rest,
    env: safeEnv(rest.env, pin),
  }) as string | Buffer;
}

/** Hardened streaming git (`spawn`), for callers that must consume stdout incrementally. */
export function spawnGit(args: readonly string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn("git", safeGitArgs(args), opts);
}

/** The worktree's `.git` gitfile can't be trusted to name its admin dir, and no admin dir under
 *  the repo's common dir claims it. Fail closed: the caller treats it as any git failure. */
export class UntrustedGitDirError extends Error {
  constructor(public readonly worktreePath: string) {
    super(`no trusted git admin dir for worktree ${worktreePath}`);
    this.name = "UntrustedGitDirError";
  }
}

/** One `<common>/worktrees/<id>` admin dir, its backlinks realpath'd (null = unreadable). */
interface AdminEntry {
  dir: string;
  /** realpath of the worktree its `gitdir` file names (the dir holding that `.git`). */
  worktree: string | null;
  /** realpath of its `commondir`. */
  common: string | null;
}

/** The admin dir whose `gitdir` backlink names `wtReal` and whose `commondir` is `common`.
 *  Realpath'd on both sides, so a symlinked path git recorded (macOS `/tmp`) still matches. */
function matchAdmin(common: string, wtReal: string, entries: AdminEntry[]): string | null {
  return entries.find((e) => e.worktree === wtReal && e.common === common)?.dir ?? null;
}

/** `<admin>/<file>` content resolved against the admin dir; `up` drops the trailing `.git`. */
function backlinkPath(dir: string, content: string, up: boolean): string {
  const p = resolve(dir, content.trim());
  return up ? dirname(p) : p;
}

function adminEntrySync(dir: string): AdminEntry {
  const real = (file: string, up: boolean): string | null => {
    try {
      return realpathSync(backlinkPath(dir, readFileSync(join(dir, file), "utf8"), up));
    } catch {
      return null;
    }
  };
  return { dir, worktree: real("gitdir", true), common: real("commondir", false) };
}

async function adminEntry(dir: string): Promise<AdminEntry> {
  const real = async (file: string, up: boolean): Promise<string | null> => {
    try {
      return await realpath(backlinkPath(dir, await readFile(join(dir, file), "utf8"), up));
    } catch {
      return null;
    }
  };
  const [worktree, common] = await Promise.all([real("gitdir", true), real("commondir", false)]);
  return { dir, worktree, common };
}

/** The repo's git common dir, realpath'd. A `.git` directory is used directly; otherwise
 *  (the registered repo is itself a linked worktree) ask hardened git. */
function commonDirSync(repoPath: string): string {
  const dotGit = join(repoPath, ".git");
  if (existsSync(dotGit) && statSync(dotGit).isDirectory()) return realpathSync(dotGit);
  const out = String(
    execGitSync(["rev-parse", "--git-common-dir"], { cwd: repoPath, stdio: "pipe" }),
  ).trim();
  return realpathSync(resolve(repoPath, out));
}

async function commonDir(repoPath: string): Promise<string> {
  const dotGit = join(repoPath, ".git");
  const st = await stat(dotGit).catch(() => null);
  if (st?.isDirectory()) return realpath(dotGit);
  const { stdout } = await execGit(["rev-parse", "--git-common-dir"], { cwd: repoPath });
  return realpath(resolve(repoPath, stdout.trim()));
}

/** Sync {@link resolveWorktreePin}, for call sites that are already synchronous. */
export function resolveWorktreePinSync(repoPath: string, worktreePath: string): GitPin | null {
  const wtReal = realpathSync(worktreePath);
  if (wtReal === realpathSync(repoPath)) return null;
  const common = commonDirSync(repoPath);
  const root = join(common, "worktrees");
  const names = existsSync(root) ? readdirSync(root) : [];
  const entries = names.map((n) => adminEntrySync(join(root, n)));
  const dir = matchAdmin(common, wtReal, entries);
  if (!dir) throw new UntrustedGitDirError(worktreePath);
  return { gitDir: dir, workTree: wtReal };
}

/**
 * Pin for running git in `worktreePath`, derived from the trusted `repoPath`: the admin dir
 * under `<common>/worktrees/` whose backlink names this worktree and whose `commondir` points
 * back at the repo. The worktree's own `.git` gitfile is never read — an agent can repoint it at
 * a gitdir it owns. `null` when the worktree IS the repo (non-isolated session).
 * @throws UntrustedGitDirError when no admin dir matches.
 */
export async function resolveWorktreePin(
  repoPath: string,
  worktreePath: string,
): Promise<GitPin | null> {
  const [wtReal, repoReal] = await Promise.all([realpath(worktreePath), realpath(repoPath)]);
  if (wtReal === repoReal) return null;
  const common = await commonDir(repoPath);
  const root = join(common, "worktrees");
  const names = await readdir(root).catch(() => [] as string[]);
  const entries = await Promise.all(names.map((n) => adminEntry(join(root, n))));
  const dir = matchAdmin(common, wtReal, entries);
  if (!dir) throw new UntrustedGitDirError(worktreePath);
  return { gitDir: dir, workTree: wtReal };
}

/** Shepherd's own copy of the i18n catalog union merge driver — never the branch's copy. */
export const TRUSTED_UNION_DRIVER = join(import.meta.dir, "..", "scripts", "json-union-merge.mjs");

/** `-c` pair pinning `merge.i18n-union.driver` to {@link TRUSTED_UNION_DRIVER}. */
export function trustedUnionDriverConfig(): readonly [string, string] {
  // git runs the driver through the shell: single-quote the path (install dirs can hold spaces).
  const quoted = `'${TRUSTED_UNION_DRIVER.replace(/'/g, "'\\''")}'`;
  return ["merge.i18n-union.driver", `node ${quoted} %O %A %B %P`];
}
