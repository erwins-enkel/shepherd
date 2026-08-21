import { execFile } from "node:child_process";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { promisify } from "node:util";
import { DIAGNOSTICS_PROBE_TIMEOUT_MS } from "./config";

/**
 * Is the `claude` Shepherd spawns the one mise manages — and is a native duplicate lying around?
 * (issue #2052)
 *
 * Claude Code self-updates by writing a native install into `~/.local/share/claude/versions` and
 * repointing `~/.local/bin/claude` at it. On a host where mise ALSO manages claude that native copy
 * shadows the mise-managed one, the two diverge, and `mise upgrade claude` then moves only the one
 * nothing runs. Two consumers read this module: the `claude_install` DIAGNOSE row (reports the
 * divergence, and the leftover native tree when there is none) and the spawn env pin
 * (`DISABLE_AUTOUPDATER=1`, see `buildWrappedArgv`) that stops the re-planting at the source.
 *
 * **Ownership is decided by VERSION EQUALITY, not by path shape.** `codex-update.ts` decides
 * mise-ownership structurally — the on-PATH path sits under the mise data dir, or realpaths to the
 * same file as `mise which codex`. That test does not survive the third host shape: a launcher
 * SCRIPT on `PATH` that re-runs `mise use` and `exec`s `mise x claude` (the shape the shepherd host
 * this was written on actually uses). Such a launcher is a plain regular file outside the mise tree,
 * so a structural test calls it "not mise-managed" and both consumers go silent on the very host the
 * issue was filed from. Comparing what `claude --version` reports against the mise-managed binary's
 * own `--version` reads correctly for all three shapes — shim, `~/.local/bin` symlink, launcher.
 *
 * NOTE ON FIDELITY: the on-PATH resolution walks THIS process's `PATH`. herdr — a sibling systemd
 * user unit — is what ultimately execs the agent, so in principle it could resolve a different
 * `claude`. In practice both units are started by the same user manager with the same
 * `~/.local/bin`-first PATH, and a mismatch would only cost accuracy in the row, never safety:
 * every disagreement resolves to "not managed", i.e. no row and no pin.
 *
 * `mise which claude` is the managed-or-not test, exactly as in `remediations.ts`: exit 0 + a path
 * when mise can hand us that binary right now, non-zero otherwise. `mise ls claude` exits 0 either
 * way and cannot be used. Anything that throws (no mise on the service PATH, an unreadable
 * `--version`) resolves to "not managed" / no verdict, so a non-mise host is byte-identical to
 * before: no row, no pin.
 */
export interface MiseClaudeState {
  /** `mise which claude` resolved — mise can hand us a claude right now. */
  managed: boolean;
  /** Version the on-PATH `claude` reports; null when absent or unparseable. */
  pathVersion: string | null;
  /** Version the mise-managed binary reports; null when unparseable. */
  miseVersion: string | null;
  /** The on-PATH claude realpaths INTO the native install tree — i.e. what we run is the
   *  native copy, whatever its version happens to be. Gates the spawn pin only. */
  nativeOnPath: boolean;
  /** Native builds sitting under `~/.local/share/claude/versions`; null when the tree is absent
   *  or empty. Only reported to the operator on the `residue` verdict, which by construction means
   *  `nativeOnPath` is false — so there, every one of them really is a leftover. */
  nativeResidue: { count: number; bytes: number } | null;
}

/** What the `claude_install` row should say. `absent` ⇒ emit no row at all. The non-absent set is
 *  exactly aligned with {@link pinFor}: `ok`/`residue` are the pinned states, `diverged`/`native`
 *  the unpinned ones — so the row never claims a pin the spawn path did not apply. */
export type MiseClaudeVerdict = "absent" | "diverged" | "native" | "residue" | "ok";

export interface MiseClaudeDeps {
  /** Run a binary and return stdout; rejects on non-zero exit / missing binary / timeout. */
  run?: (bin: string, args: string[]) => Promise<string>;
  /** First executable named `name` on `PATH`, or null. Mirrors execvp's own resolution. */
  resolveOnPath?: (name: string) => Promise<string | null>;
  realpath?: (path: string) => Promise<string>;
  /** Regular files directly under `dir`, with their sizes. Missing dir ⇒ []. */
  listNative?: (dir: string) => Promise<{ path: string; bytes: number }[]>;
  home?: string;
}

const SEMVER_RE = /(\d+\.\d+\.\d+)/;
/** Refresh cadence for the shared probe — the same 6h the herdr/codex update checks use. */
const MISE_CLAUDE_TTL_MS = 6 * 60 * 60 * 1000;
/** Bound the native-tree scan. Claude Code keeps a handful of builds; a pathological dir must
 *  not turn a diagnostics refresh into thousands of stats. */
const NATIVE_SCAN_CAP = 100;

const NOT_MANAGED: MiseClaudeState = {
  managed: false,
  pathVersion: null,
  miseVersion: null,
  nativeOnPath: false,
  nativeResidue: null,
};

const execFileAsync = promisify(execFile);

async function defaultRun(bin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    encoding: "utf8",
    timeout: DIAGNOSTICS_PROBE_TIMEOUT_MS,
  });
  return stdout.toString();
}

async function defaultResolveOnPath(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here — keep walking PATH, exactly as execvp does.
    }
  }
  return null;
}

async function defaultListNative(dir: string): Promise<{ path: string; bytes: number }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: { path: string; bytes: number }[] = [];
  for (const name of names.sort().slice(0, NATIVE_SCAN_CAP)) {
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (st.isFile()) out.push({ path, bytes: st.size });
    } catch {
      // vanished mid-scan / unreadable — not evidence of anything.
    }
  }
  return out;
}

/** Best-effort `<bin> --version` → semver, null when the binary or its output won't cooperate. */
async function probeVersion(
  run: (bin: string, args: string[]) => Promise<string>,
  bin: string,
): Promise<string | null> {
  try {
    return SEMVER_RE.exec(await run(bin, ["--version"]))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** One live read of the host's claude install shape. Never throws. */
export async function detectMiseClaude(deps: MiseClaudeDeps = {}): Promise<MiseClaudeState> {
  const run = deps.run ?? defaultRun;
  const resolveOnPath = deps.resolveOnPath ?? defaultResolveOnPath;
  const toReal = deps.realpath ?? realpath;
  const listNative = deps.listNative ?? defaultListNative;
  const home = deps.home ?? homedir();

  let misePath: string;
  try {
    misePath = (await run("mise", ["which", "claude"])).trim();
  } catch {
    return NOT_MANAGED;
  }
  if (!misePath) return NOT_MANAGED;

  const onPath = await resolveOnPath("claude").catch(() => null);
  // A launcher script realpaths to itself; a shim/symlink realpaths into the mise tree; a native
  // install realpaths into `~/.local/share/claude`. Only the last one blocks the spawn pin.
  const running = onPath ? await toReal(onPath).catch(() => onPath) : null;
  const nativeRoot = join(home, ".local", "share", "claude");
  const nativeOnPath = running !== null && running.startsWith(nativeRoot + sep);

  const [pathVersion, miseVersion] = await Promise.all([
    onPath ? probeVersion(run, onPath) : Promise.resolve(null),
    probeVersion(run, misePath),
  ]);

  const builds = await listNative(join(nativeRoot, "versions")).catch(() => []);
  const nativeResidue = builds.length
    ? { count: builds.length, bytes: builds.reduce((sum, e) => sum + e.bytes, 0) }
    : null;

  return { managed: true, pathVersion, miseVersion, nativeOnPath, nativeResidue };
}

/** What the DIAGNOSE row should report. Either version unreadable ⇒ `absent`: we cannot compare,
 *  and guessing would be worse than staying quiet. Ordered most- to least-urgent: divergence
 *  outranks everything (on a diverged host the native tree is the LIVE install, not leftovers),
 *  then running a native copy that merely HAPPENS to match mise's version today, then leftovers. */
export function verdictFor(state: MiseClaudeState): MiseClaudeVerdict {
  if (!state.managed || state.pathVersion === null || state.miseVersion === null) return "absent";
  if (state.pathVersion !== state.miseVersion) return "diverged";
  if (state.nativeOnPath) return "native";
  return state.nativeResidue ? "residue" : "ok";
}

/** Should a spawned claude get `DISABLE_AUTOUPDATER=1`?
 *
 *  Equal versions alone would also match a NATIVE duplicate sitting at mise's version — pinning
 *  there would freeze a build mise cannot advance, silently. So the pin additionally requires that
 *  what we run does not live in the native tree; `verdictFor` reports that state as `native` so
 *  the row and the pin agree. */
export function pinFor(state: MiseClaudeState): boolean {
  return (
    state.managed &&
    state.pathVersion !== null &&
    state.pathVersion === state.miseVersion &&
    !state.nativeOnPath
  );
}

/** Human size for the residue row. Binary units, one decimal above 1 GB — matches the
 *  `27G`-style host facts `fixActionParams` already carries. */
export function formatResidueSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

let cached: MiseClaudeState | null = null;
let cachedAt = 0;
let pinned = false;

/** TTL-cached read shared by BOTH consumers, so the row and the spawn pin can never disagree.
 *  `index.ts` kicks it early at boot and refreshes it on the same 6h cadence as the other update
 *  checks; the DIAGNOSE row reads through the same cache. */
export async function miseClaudeState(
  now: number,
  deps?: MiseClaudeDeps,
): Promise<MiseClaudeState> {
  if (cached && now - cachedAt < MISE_CLAUDE_TTL_MS) return cached;
  const state = await detectMiseClaude(deps);
  cached = state;
  cachedAt = now;
  pinned = pinFor(state);
  return state;
}

/** Synchronous read for the spawn path — `buildWrappedArgv` runs on the single event loop and
 *  must never probe. Cold (pre-first-check) reads `false`: worst case one more native plant,
 *  which the row then reports. */
export function claudeSpawnPinned(): boolean {
  return pinned;
}

/** Test-only: drop the cache so each case starts cold. */
export function __resetMiseClaude(): void {
  cached = null;
  cachedAt = 0;
  pinned = false;
}
