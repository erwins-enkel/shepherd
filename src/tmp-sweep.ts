import { promises as fsp, type Dirent } from "node:fs";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  parseWorktrees,
  parseGitVersion,
  gitVersionAtLeast,
  MIN_GIT_MAJOR,
  MIN_GIT_MINOR,
} from "./forge/local";
import { WORKTREE_MARKER, isUnder } from "./process-reaper";

const execFileAsync = promisify(execFile);

/**
 * Centralizes the "claude tmp directory" geometry and a threshold-gated inode-guard
 * sweep. Claude Code points spawned agents at `TMPDIR=/tmp/claude-$uid`; Node's V8
 * compile cache (`$TMPDIR/node-compile-cache`) and per-session scratch accumulate
 * unbounded there and exhaust the tmpfs *inodes* (ENOSPC with bytes to spare).
 *
 * The proven operator fix is `rm -rf /tmp/claude-$uid/node-compile-cache` (inode use
 * ~88%→16%); this module automates that plus age-gated removal of known regenerable tool
 * caches, but only once inode use crosses a threshold — so a healthy tmpfs is never
 * disturbed, and a live session's per-session scratch is never wholesale-removed.
 *
 * The server runs on a single Bun event loop, so EVERYTHING here is async `fs/promises`:
 * a sync stat/rm on the loop freezes the live web terminal.
 */

/** Process uid, derived at call time (1000 fallback when getuid is absent, e.g. Windows). */
const uid = (): number => process.getuid?.() ?? 1000;

/** A worktree cwd → the dash-encoded directory name a nested claude derives for it. */
const dashify = (p: string): string => p.replace(/[/.]/g, "-");

/**
 * Parse a numeric env override, honoring a legitimate `0` (unlike `Number(x) || d`, which
 * coerces a configured `0` back to the default). Empty/whitespace/non-finite → the fallback.
 */
const envNum = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The claude tmp root for this user. Read from env at call time so tests and operators
 * can redirect it; falls back to the conventional `<tmpdir>/claude-$uid`.
 */
function claudeTmpRoot(): string {
  return (
    process.env.SHEPHERD_TMP_SWEEP_DIR ??
    process.env.CLAUDE_CODE_TMPDIR ??
    join(tmpdir(), `claude-${uid()}`)
  );
}

/**
 * Disk-backed compile-cache dir (deliberately OFF tmpfs). Other code sets
 * `NODE_COMPILE_CACHE` to this on spawns so the cache stops eating tmpfs inodes.
 */
export function compileCacheDir(): string {
  return (
    process.env.SHEPHERD_NODE_COMPILE_CACHE ??
    join(homedir(), ".cache", "shepherd", "node-compile-cache")
  );
}

/**
 * The disk-backed `TMPDIR` that spawned (trusted) agents are pointed at (#1875), so ALL their temp
 * I/O — the per-session scratch tree, git worktrees, dependency installs, and bare-`$TMPDIR` tool
 * caches (fallow/bunx/agent-browser) — lands on a real filesystem instead of the `/tmp` tmpfs, whose
 * INODE table it otherwise exhausts (ENOSPC with bytes to spare). Default mirrors `compileCacheDir()`'s
 * `~/.cache/shepherd/*` home. Read from env at call time.
 *
 * Returns `null` when the redirect is DISABLED — the operator set `SHEPHERD_AGENT_TMPDIR` to the
 * empty string — restoring the pre-#1875 tmpfs inheritance as a one-env-var rollback (the write
 * traffic this relocates to disk is unmeasured). A non-empty value overrides the default path.
 */
export function agentTmpDir(): string | null {
  const v = process.env.SHEPHERD_AGENT_TMPDIR;
  if (v === "") return null; // explicitly disabled
  return v ?? join(homedir(), ".cache", "shepherd", "tmp");
}

/**
 * The value the SERVER sets as its own `CLAUDE_CODE_TMPDIR` at boot so `claudeTmpRoot()` (and every
 * scratch consumer) follows trusted agents onto the disk `agentTmpDir()`. It is `agentTmpDir()` plus
 * the `claude-$uid` suffix, because `claudeTmpRoot()` treats `CLAUDE_CODE_TMPDIR` as the FINAL root
 * (returns it verbatim). Null when the redirect is disabled.
 *
 * The spawn shim STRIPS `CLAUDE_CODE_TMPDIR` from the agent (`env -u`, see `buildWrappedArgv`): claude
 * honours it as a BASE and appends its OWN `claude-$uid`, so an inherited value would double-suffix the
 * agent's root (`<disk>/claude-$uid/claude-$uid`) and desync it from this server-side read path. Instead
 * the agent re-derives this SAME path from `TMPDIR=agentTmpDir()` alone.
 */
export function agentClaudeTmpRoot(): string | null {
  const base = agentTmpDir();
  return base === null ? null : join(base, `claude-${uid()}`);
}

/**
 * The pre-#1875 claude tmp root on the system tmpfs — `<os.tmpdir()>/claude-$uid`. After the boot
 * override moves `claudeTmpRoot()` to the disk `agentClaudeTmpRoot()`, this is where an ADOPTED
 * (pre-upgrade) session's live agent — which kept its spawn-time `TMPDIR=/tmp` across the deploy —
 * still writes. The dual-read / dual-clean / sweep paths consult it so those sessions are not orphaned.
 * Read at call time.
 */
export function legacyClaudeTmpRoot(): string {
  return join(tmpdir(), `claude-${uid()}`);
}

/**
 * The per-session scratch dir a NESTED claude derives for a given worktree cwd:
 * `<claudeTmpRoot>/claude-$uid/<dashified-worktree-path>`. The doubled `claude-$uid`
 * is real — our spawned agents inherit TMPDIR and re-derive their own claude root under it.
 */
export function worktreeScratchDir(worktreePath: string): string {
  return join(claudeTmpRoot(), `claude-${uid()}`, dashify(worktreePath));
}

/**
 * Ordered, DEDUPED nested-scratch-dir candidates for a worktree (#1875 migration). Primary is the
 * live `worktreeScratchDir()` (disk after the boot override); the second is the same doubled
 * `claude-$uid/<dashified>` tail under the legacy tmpfs root, where an ADOPTED pre-upgrade session's
 * live agent still writes. `removeWorktreeScratch` reclaims BOTH on archival — without this the
 * disk-only primary would silently stop reclaiming those tmpfs dirs, regressing an existing
 * automatic tmpfs-inode reclaim. No override → the two collapse and dedupe to one → unchanged.
 */
export function worktreeScratchDirCandidates(worktreePath: string): string[] {
  const primary = worktreeScratchDir(worktreePath);
  const legacy = join(legacyClaudeTmpRoot(), `claude-${uid()}`, dashify(worktreePath));
  return [...new Set([primary, legacy])];
}

/**
 * The per-session SCRATCHPAD dir for a Shepherd session's OWN (top-level) claude agent:
 * `<claudeTmpRoot>/<dashified-worktree>/<claudeSessionId>/scratchpad`.
 *
 * DISTINCT from `worktreeScratchDir` above: that helper models the doubled `claude-$uid` base
 * a NESTED sub-agent derives (those dirs hold `<uuid>/tasks`, never a `scratchpad`). A session's
 * own artifacts live under the SINGLE base, keyed by the claude session UUID. The issue (#1164)
 * originally said to reuse `worktreeScratchDir` — that is the wrong base; verified empirically
 * against the live tmp tree (the server runs with no TMPDIR override, so `claudeTmpRoot()` here
 * matches the agent's). Reuses the same `claudeTmpRoot()` + `dashify()` primitives, dropping the
 * nested `claude-$uid` segment and appending the session-scoped tail.
 */
export function sessionScratchpadDir(worktreePath: string, claudeSessionId: string): string {
  return join(claudeTmpRoot(), dashify(worktreePath), claudeSessionId, "scratchpad");
}

/**
 * Ordered, DEDUPED scratchpad-dir candidates for a session (#1875 migration). The primary is the
 * live `sessionScratchpadDir()` (disk after the boot override); the second is the same tail under
 * the legacy tmpfs root, where an ADOPTED pre-upgrade session's live agent — which kept its
 * spawn-time `TMPDIR=/tmp` — still writes. When no override is active (`claudeTmpRoot()` ===
 * `legacyClaudeTmpRoot()`) the two collapse and the list dedupes to a single entry, so every
 * non-migration consumer is byte-for-byte unchanged.
 */
export function sessionScratchpadDirCandidates(
  worktreePath: string,
  claudeSessionId: string,
): string[] {
  const primary = sessionScratchpadDir(worktreePath, claudeSessionId);
  const legacy = join(legacyClaudeTmpRoot(), dashify(worktreePath), claudeSessionId, "scratchpad");
  return [...new Set([primary, legacy])];
}

/**
 * Resolve which scratchpad root a session ACTUALLY uses: the first candidate that exists, else the
 * primary (for creation). Rule: a live disk session → disk; a legacy-only (adopted) session →
 * legacy tmpfs; if BOTH exist (e.g. a respawned session) → prefer disk (the live root). Keeps a
 * SINGLE root per session so reads, downloads, and uploads never split across roots. Returns the
 * primary on a blank `claudeSessionId` (callers already guard that separately).
 */
export async function existingScratchpadDir(
  worktreePath: string,
  claudeSessionId: string,
): Promise<string> {
  const primary = sessionScratchpadDir(worktreePath, claudeSessionId);
  for (const dir of sessionScratchpadDirCandidates(worktreePath, claudeSessionId)) {
    try {
      await fsp.access(dir);
      return dir;
    } catch {
      // try the next candidate
    }
  }
  return primary;
}

/**
 * Shallow, async, non-throwing "does this session's scratchpad hold any entry?" probe — the
 * cheap signal that gates the UI's Files tab (#1164). Counts ANY entry (files OR subdirs,
 * dotfiles included). Returns false on a blank `claudeSessionId` (pre-`--session-id` session /
 * agent not yet started), a missing dir, or any read error. Dual-read across the disk + legacy
 * candidates (#1875) so an adopted pre-upgrade session on the tmpfs still lights the tab; a single
 * shallow `readdir` per candidate, short-circuiting on the first non-empty hit.
 */
export async function scratchpadHasFiles(
  worktreePath: string,
  claudeSessionId: string,
): Promise<boolean> {
  if (!claudeSessionId) return false;
  for (const dir of sessionScratchpadDirCandidates(worktreePath, claudeSessionId)) {
    try {
      const entries = await fsp.readdir(dir);
      if (entries.length > 0) return true;
    } catch {
      // missing/unreadable candidate — try the next
    }
  }
  return false;
}

export interface SweepResult {
  swept: boolean;
  reason: string;
  removed: number;
}

interface FsOps {
  statfs: typeof fsp.statfs;
  readdir: typeof fsp.readdir;
  stat: typeof fsp.stat;
  rm: typeof fsp.rm;
  unlink: typeof fsp.unlink;
  rmdir: typeof fsp.rmdir;
  /** Optional so the many existing partial `fsOps` test fixtures stay valid; only the
   *  entry-count pressure signal uses it, and it falls back to the real `fsp.opendir`. */
  opendir?: OpenDirFn;
}

interface SweepOpts {
  root?: string;
  thresholdPct?: number;
  staleMs?: number;
  now?: number;
  fsOps?: FsOps;
  log?: (msg: string) => void;
}

/** Resolved options for one sweep run, threaded through the internal helpers. */
interface SweepCtx {
  ops: FsOps;
  now: number;
  staleMs: number;
  nestedName: string;
  log: (msg: string) => void;
}

/** What a `statfs` read says about a root's INODE CEILING. */
type InodeCeiling =
  /** A real ceiling exists and is readable — `usePct` of it is in use. */
  | { kind: "pct"; usePct: number }
  /** `statfs` succeeded but reports NO ceiling (`files: 0`): btrfs/XFS/ZFS allocate inodes
   *  dynamically, so a percentage is meaningless. NOT a failure — see `tmpPressure`. */
  | { kind: "none" }
  /** Nothing could be read: no `statfs` function, an unusable count, or an absent root. */
  | { kind: "unreadable"; why: "statfs-unavailable" | "root-missing" };

/**
 * Read a root's inode ceiling. Deliberately distinguishes "there is no ceiling" from "the ceiling
 * could not be read": conflating the two is what made every gate here fail open to DO NOTHING on
 * a disk-backed tmp root (#1862) — `statfs` reports `files: 0` on btrfs, which is an answer, not
 * an error.
 */
async function readInodeCeiling(
  root: string,
  // Accepts `undefined` on purpose: a caller injecting an absent `statfs` is saying "this
  // filesystem cannot be read", and that must resolve to `unreadable`, not a type error.
  statfs: FsOps["statfs"] | undefined,
): Promise<InodeCeiling> {
  if (typeof statfs !== "function") return { kind: "unreadable", why: "statfs-unavailable" };

  let stats: Awaited<ReturnType<typeof fsp.statfs>>;
  try {
    stats = await statfs(root);
  } catch {
    // Root absent / unstatfs-able — nothing to guard.
    return { kind: "unreadable", why: "root-missing" };
  }

  const files = Number((stats as { files?: unknown }).files);
  const ffree = Number((stats as { ffree?: unknown }).ffree);
  if (!Number.isFinite(files) || !Number.isFinite(ffree) || files < 0) {
    return { kind: "unreadable", why: "statfs-unavailable" };
  }
  if (files === 0) return { kind: "none" };
  return { kind: "pct", usePct: (1 - ffree / files) * 100 };
}

/**
 * Minimal shape of `fs.promises.opendir`'s result that the entry counter needs. Typed structurally
 * (rather than as `Dir`) so a test can inject a plain async-iterable without constructing one.
 */
type OpenDirFn = (path: string) => Promise<AsyncIterable<{ name: string }>>;

/** Ops `tmpPressure` needs. Injectable wholesale so no test touches a real filesystem. */
export interface PressureOps {
  statfs: FsOps["statfs"];
  opendir: OpenDirFn;
}

/**
 * Count a directory's top-level entries, stopping at `cap`. Returns `null` when the directory
 * cannot be read at all (missing/unreadable ⇒ no signal, never "0 entries", which would read as
 * a healthy root). Breaking out of the `for await` calls the iterator's `return()`, which is how
 * `fs.Dir` closes its handle — so the early exit does not leak an fd.
 */
async function countEntriesUpTo(
  dir: string,
  cap: number,
  opendir: OpenDirFn,
): Promise<number | null> {
  if (typeof opendir !== "function") return null;
  let handle: AsyncIterable<{ name: string }>;
  try {
    handle = await opendir(dir);
  } catch {
    return null;
  }
  let n = 0;
  try {
    for await (const _ of handle) {
      void _;
      if (++n >= cap) break;
    }
  } catch {
    return null;
  }
  return n;
}

/**
 * How far above `entryLimit` the counter keeps counting. The gate only needs to know whether the
 * limit was reached, but the `tmp_inodes` Diagnose row needs a number it can band, so the walk
 * runs to the error band (10× the warning band) before giving up precision.
 */
const ENTRY_COUNT_CAP_FACTOR = 10;

/** The pressure reading for ONE root. */
export type TmpPressureSignal =
  /** The root's filesystem caps inodes and `usePct` of them are in use. */
  | { kind: "inode-pct"; usePct: number }
  /** No inode ceiling — `entries` top-level entries counted (capped; see `atCap`). */
  | { kind: "entry-count"; entries: number; limit: number; atCap: boolean }
  /** Nothing could be measured. Never acts. */
  | { kind: "uninspectable"; why: string };

export interface TmpPressureResult {
  /** True when this root is under enough pressure to justify acting on it. */
  act: boolean;
  signal: TmpPressureSignal;
  /** Short log-ready summary of what was measured and decided. */
  reason: string;
}

export interface TmpPressureOpts {
  thresholdPct?: number;
  entryLimit?: number;
  ops?: Partial<PressureOps>;
}

/**
 * Is this root under enough pressure to act on? Resolves one of three signals — never throws.
 *
 * Evaluated PER ROOT by every consumer, because unlike an inode percentage (a property of the
 * filesystem) an entry count is a property of the PATH: `claudeTmpRoot()` is
 * `<agentTmpDir()>/claude-$uid` and holds only session scratch, while the tool caches and
 * agent-created worktrees this module reclaims accumulate in the BARE `agentTmpDir()` beside it.
 * A single reading taken off one of them says nothing about the other.
 *
 * `uninspectable` never acts — the pre-existing fail-open, deliberately preserved: a guard that
 * cannot see must not delete.
 */
export async function tmpPressure(
  root: string,
  opts: TmpPressureOpts = {},
): Promise<TmpPressureResult> {
  const thresholdPct =
    opts.thresholdPct ?? envNum(process.env.SHEPHERD_TMP_INODE_PCT, DEFAULT_TMP_INODE_PCT);
  const entryLimit =
    opts.entryLimit ?? envNum(process.env.SHEPHERD_TMP_ENTRY_LIMIT, DEFAULT_TMP_ENTRY_LIMIT);
  // `statfs` honours an EXPLICITLY-PRESENT key even when its value is undefined: "I cannot read
  // this filesystem" is a meaningful injection, and `??`-ing the real `statfs` in its place would
  // silently re-arm the gate a caller deliberately disarmed. `opendir` takes the opposite rule —
  // it is optional on `FsOps`, so an ABSENT key means "not overridden".
  const statfs = opts.ops && "statfs" in opts.ops ? opts.ops.statfs : fsp.statfs;
  const opendir = opts.ops?.opendir ?? fsp.opendir;

  const ceiling = await readInodeCeiling(root, statfs);

  if (ceiling.kind === "unreadable") {
    return { act: false, signal: { kind: "uninspectable", why: ceiling.why }, reason: ceiling.why };
  }

  if (ceiling.kind === "pct") {
    const { usePct } = ceiling;
    return {
      act: usePct >= thresholdPct,
      signal: { kind: "inode-pct", usePct },
      reason:
        usePct >= thresholdPct
          ? `${usePct.toFixed(1)}% inode use`
          : `below-threshold ${usePct.toFixed(1)}%`,
    };
  }

  // No inode ceiling: fall back to how much has piled up in this root.
  // Floor of 1 so a non-positive limit (the "always act" setting) still walks one entry rather
  // than deriving a zero/negative cap that would make the counted number meaningless.
  const cap = Math.max(entryLimit * ENTRY_COUNT_CAP_FACTOR, 1);
  const entries = await countEntriesUpTo(root, cap, opendir);
  if (entries === null) {
    return {
      act: false,
      signal: { kind: "uninspectable", why: "entries-unreadable" },
      reason: "entries-unreadable",
    };
  }
  const atCap = entries >= cap;
  const act = entries >= entryLimit;
  return {
    act,
    signal: { kind: "entry-count", entries, limit: entryLimit, atCap },
    reason: act
      ? `${entries}${atCap ? "+" : ""} entries (limit ${entryLimit})`
      : `below-entry-limit ${entries}/${entryLimit}`,
  };
}

/**
 * Inode-use% band above which the `tmp_inodes` diagnostics row reports `error` rather than
 * `warning`. Lives here, beside the `SHEPHERD_TMP_INODE_PCT` read that drives both the sweep gate
 * and that row's WARNING band, so one module owns both thresholds (#1862).
 */
export const TMP_INODE_ERROR_PCT = 95;

/**
 * The documented default of `SHEPHERD_TMP_INODE_PCT` — the SINGLE source for both consumers: the
 * sweep gate in `sweepClaudeTmp` and the `tmp_inodes` row's warning band via `tmpInodeBands`. The
 * row's whole premise is that it warns exactly where the sweeper starts acting, so two independent
 * literals would let one drift and silently break that correspondence.
 */
const DEFAULT_TMP_INODE_PCT = 80;

/**
 * The documented default of `SHEPHERD_TMP_ENTRY_LIMIT` — the top-level entry count at which a root
 * whose filesystem has NO inode ceiling (btrfs/XFS/ZFS allocate inodes dynamically) counts as
 * pressured. Also the `tmp_inodes` row's warning band for that signal, via `tmpEntryBands`.
 *
 * Deliberately far more eager than the inode-% analogue, because the two failure modes are not
 * symmetric: 80% of a tmpfs means the host is near death, whereas crossing this only enables the
 * EXISTING age-gated sweep of ALLOWLISTED names and arms reclaimers that are independently walled
 * by their own refusals. Measured while diagnosing #1862: a healthy bare agent tmp root sits in the
 * tens, a normal `claude-$uid` session-scratch root at ~2,900, and the leaking root at 119,640. The
 * scratch root sitting permanently above this line is inert: its contents match nothing the sweep
 * will remove, and `diagnosedRoots()` keeps it out of the Diagnose row so it cannot raise an alarm
 * no Fix could clear.
 */
const DEFAULT_TMP_ENTRY_LIMIT = 1000;

/**
 * Ordered display bands for the `tmp_inodes` diagnostics row.
 *
 * The warning band tracks `SHEPHERD_TMP_INODE_PCT` so the row warns at exactly the point the
 * sweeper starts acting — hardcoding 80 would warn about a state an operator who raised the knob
 * deliberately told the sweeper to ignore. But the knob CANNOT be forwarded raw, because it is a
 * sweep-GATE value and this is a DISPLAY band, and the two disagree at both extremes:
 *
 *  - `0` is a legitimate gate setting meaning "always sweep" (`envNum` deliberately honours it —
 *    see its doc). Forwarded raw it means "always WARN": `usePct >= 0` holds on every host, so a
 *    healthy machine shows a permanent warning that no fix can clear, degrading the health pip
 *    forever. There is no useful display band derivable from it, so fall back to the default.
 *  - A value above `TMP_INODE_ERROR_PCT` inverts the bands: the warning range `[warn, error)` is
 *    empty, and `error` fires at 95% — BELOW the threshold the operator set — so the row alarms
 *    about a state they explicitly told Shepherd to leave alone. Raise the error band to match
 *    instead, so it never fires below the operator's own line.
 *  - A value above 100 (or otherwise outside `(0, 100]`) is not a percentage at all; treat it as
 *    misconfiguration and fall back rather than silently disabling the row.
 *
 * Postcondition, relied on by `classifyTmpInodes`: `0 < warnPct <= errorPct`.
 */
export function tmpInodeBands(): { warnPct: number; errorPct: number } {
  const configured = envNum(process.env.SHEPHERD_TMP_INODE_PCT, DEFAULT_TMP_INODE_PCT);
  const warnPct = configured > 0 && configured <= 100 ? configured : DEFAULT_TMP_INODE_PCT;
  return { warnPct, errorPct: Math.max(TMP_INODE_ERROR_PCT, warnPct) };
}

/**
 * Display bands for the `entry-count` signal. The warning band IS `SHEPHERD_TMP_ENTRY_LIMIT`, so —
 * exactly as `tmpInodeBands` does for the percentage signal — the row warns at the point the
 * sweeper starts acting. A non-positive or non-finite knob has no coherent display band (it would
 * mean "always warn", which no fix could clear), so it falls back to the default for the ROW while
 * the gate still honours whatever was configured.
 *
 * Postcondition, relied on by the classifier: `0 < warnEntries < errorEntries`.
 */
export function tmpEntryBands(): { warnEntries: number; errorEntries: number } {
  const configured = envNum(process.env.SHEPHERD_TMP_ENTRY_LIMIT, DEFAULT_TMP_ENTRY_LIMIT);
  const warnEntries = configured > 0 ? configured : DEFAULT_TMP_ENTRY_LIMIT;
  return { warnEntries, errorEntries: warnEntries * ENTRY_COUNT_CAP_FACTOR };
}

/**
 * The roots a default (production) sweep visits — the bare disk `agentTmpDir()`, the claude root
 * and its nested `claude-$uid`, and the legacy tmpfs pair. Shared by `readTmpPressureSignal` and
 * the worktree reaper so both act on exactly the set `sweepClaudeTmp` does, rather than on a
 * filesystem the sweeper never touches.
 */
function sweptRoots(): string[] {
  return resolveSweepRoots(claudeTmpRoot(), `claude-${uid()}`, false);
}

/**
 * The roots the `tmp_inodes` Diagnose row measures. Deliberately NOT `sweptRoots()`.
 *
 * A swept root also includes the SESSION-SCRATCH roots — `claudeTmpRoot()` and its nested
 * `claude-$uid`, plus the legacy pair. Their contents are the dashified per-worktree dirs, which
 * match nothing in `REGENERABLE_CACHE` by design (a live long-running session leaves a stale
 * top-level mtime, so a coarse age check would delete a running agent's scratch) and are reclaimed
 * only by `removeWorktreeScratch` at archival. Counting them would put the row permanently at
 * `warning` on a healthy host — 2,902 such dirs were measured on one while diagnosing #1862 — with
 * a Fix button whose forced sweep cannot remove a single one of them. An alarm no action can clear
 * is exactly the trap `tmpInodeBands` already documents for the percentage knob.
 *
 * So the row watches the two roots whose pressure a sweep CAN act on:
 *  - the bare disk `agentTmpDir()` — where the regenerable tool caches accumulate; and
 *  - `tmpdir()` — the tmpfs, still real for sandboxed spawns and tools that hardcode `/tmp`.
 *
 * Nothing is lost by dropping the nested roots: each sits on the same filesystem as a root that
 * remains, so the inode percentage is identical, and `tmpdir()` is always present (unlike
 * `<tmpdir>/claude-$uid` on a freshly booted host — the #1876 rationale, restored).
 *
 * Session-scratch accumulation is a real signal, but it needs a different remedy and different
 * copy than this row offers; it is tracked separately in #2304.
 */
function diagnosedRoots(): string[] {
  const agentTmp = agentTmpDir();
  return [...new Set([...(agentTmp ? [agentTmp] : []), tmpdir()])];
}

/** Bands for both signals, as `classifyTmpInodes` applies them. */
interface PressureBands {
  warnPct: number;
  errorPct: number;
  warnEntries: number;
  errorEntries: number;
}

/**
 * How bad a signal is, for picking the worst root. Ordered by the STATE it will classify to
 * FIRST, and only then by how deep into that state it sits.
 *
 * Ranking on a normalised ratio alone is wrong ACROSS KINDS, because warn sits at a different
 * fraction of error in each: 80/95 = 0.84 for the percentage, 1000/10000 = 0.10 for the entry
 * count. A quiet `/tmp` at 70% (`ok`, ratio 0.74) would then outrank an agent tmp root at 1,500
 * entries (`warning`, ratio 0.15) and the row would report the healthy one — the exact masking
 * this function exists to prevent. `ratio` is kept only to break ties WITHIN a state, where both
 * candidates classify the same and it is a meaningful "how far in".
 *
 * `uninspectable` sorts below every real reading, so one unreadable root cannot mask a real one.
 */
function severityOf(
  signal: TmpPressureSignal,
  bands: PressureBands,
): { rank: number; ratio: number } {
  const [value, warn, error] =
    signal.kind === "inode-pct"
      ? [signal.usePct, bands.warnPct, bands.errorPct]
      : signal.kind === "entry-count"
        ? [signal.entries, bands.warnEntries, bands.errorEntries]
        : [null, 0, 0];

  if (value === null) return { rank: -1, ratio: 0 };
  // Thresholds are `>=`, matching `classifyTmpInodes` exactly: a rank that disagreed with the
  // classifier would reintroduce the same masking by a different route.
  const rank = value >= error ? 2 : value >= warn ? 1 : 0;
  return { rank, ratio: value / error };
}

/**
 * The worst pressure signal across the roots the sweeper actually visits — the value behind the
 * `tmp_inodes` Diagnose row.
 *
 * Post-#1875 no single path answers this. Trusted agents write to the disk `agentTmpDir()`, while
 * the tmpfs `tmpdir()` is still real for sandboxed spawns and tools that hardcode `/tmp`; reading
 * only one reports a healthy filesystem while the other fills. Roots that cannot be measured are
 * skipped rather than allowed to mask a measurable one; `uninspectable` is returned only when NO
 * root could be read.
 *
 * NOTE the roots are not necessarily under `/tmp` — user-facing copy driven by this must say "the
 * temporary filesystem", never a hardcoded path, and no absolute path crosses the check payload.
 */
export async function readTmpPressureSignal(opts?: {
  roots?: string[];
  ops?: Partial<PressureOps>;
}): Promise<TmpPressureSignal> {
  const roots = opts?.roots ?? diagnosedRoots();
  const bands = { ...tmpInodeBands(), ...tmpEntryBands() };
  let worst: TmpPressureSignal = { kind: "uninspectable", why: "no-root-readable" };
  let worstRank = -Infinity;
  let worstRatio = -Infinity;
  for (const root of roots) {
    const { signal } = await tmpPressure(root, { ops: opts?.ops });
    const { rank, ratio } = severityOf(signal, bands);
    if (rank > worstRank || (rank === worstRank && ratio > worstRatio)) {
      worstRank = rank;
      worstRatio = ratio;
      worst = signal;
    }
  }
  return worst;
}

/**
 * Entry names this sweep is willing to age-gate-remove: regenerable tool caches that hold NO
 * live session working state — Bun's bunx cache, fallow's audit base cache, agent-browser's
 * Chrome profiles, the browser-profile and artifact dirs Chromium/Playwright leave behind
 * (4,963 observed on one host while diagnosing #1862), and the per-run root a crashed
 * `bun test` leaves behind (`test/setup-test-env.ts` removes it on a clean exit).
 * Per-session scratch — the dashified `-home-…` worktree dirs and their
 * session-id subdirs — is deliberately EXCLUDED: a still-running session leaves a stale
 * TOP-LEVEL mtime because it only writes into subdirs, so a coarse mtime check would let this
 * best-effort sweep `rm -rf` a live agent's scratch out from under it. Those dirs are reclaimed
 * precisely by `removeWorktreeScratch` on archival, when the session is known to be finished.
 */
const REGENERABLE_CACHE =
  /^(bunx-|fallow-|agent-browser-|shepherd-test-run-|\.?org\.chromium\.Chromium\.|playwright_|playwright-artifacts-)/;

/**
 * Name prefix for fallow's audit-base worktree caches: `fallow-audit-base-cache-<srcHash>-<shaHash>`.
 * Each `git worktree prune` pre-push creates one; they accumulate until reaped.
 */
export const FALLOW_CACHE_PREFIX = "fallow-audit-base-cache-";

/**
 * Shared helper: age-gate a single known-regenerable-cache dir by its own top-level mtime and
 * `rm -rf` it if stale. Returns 1 if removed, 0 if kept. Fail-closed: a stat or rm failure is
 * logged and counted as 0 (never miscounted as success). Does NOT remove sidecar files — callers
 * that need sidecar cleanup (e.g. `reapFallowCaches`) must do so themselves.
 */
async function removeIfStale(
  p: string,
  st: { mtimeMs: number | bigint },
  ctx: Pick<SweepCtx, "now" | "staleMs" | "log"> & { ops: Pick<FsOps, "rm"> },
): Promise<number> {
  // Deliberately the top-level entry's own mtime, not a recursive
  // newest-descendant walk — don't "fix" this into a sync/expensive tree traversal.
  if (ctx.now - Number(st.mtimeMs) > ctx.staleMs) {
    try {
      await ctx.ops.rm(p, { recursive: true, force: true });
      return 1;
    } catch (err) {
      ctx.log(`[tmp-sweep] failed to remove ${p}: ${String(err)}`);
      return 0;
    }
  }
  return 0;
}

/**
 * Handles ONE directory entry, returning the count removed (0 or 1). Fail-closed per-entry:
 * its own try/catch surfaces a removal failure in the log and continues, so a bad entry NEVER
 * aborts the sweep and is never miscounted as success. The cases:
 *  - `node-compile-cache` — pure V8 compile cache, dropped wholesale regardless of age.
 *  - the nested `claude-$uid` root — never wholesale-removed (its children are swept when it is
 *    itself the sweep root); skipped here.
 *  - a known regenerable cache (see `REGENERABLE_CACHE`) — age-gated by its top-level mtime via
 *    `removeIfStale`.
 *  - anything else (per-session/unknown scratch) — LEFT in place; never wholesale-removed by
 *    this sweep (reclaimed via `removeWorktreeScratch` on archival instead).
 */
async function sweepEntry(dir: string, ent: Dirent, ctx: SweepCtx): Promise<number> {
  const p = join(dir, ent.name);
  try {
    if (ent.name === "node-compile-cache") {
      await ctx.ops.rm(p, { recursive: true, force: true });
      return 1;
    }
    if (ent.name === ctx.nestedName) return 0;
    // Only known regenerable caches are eligible for age-gated removal; everything else
    // (live/orphaned session scratch, unrecognized dirs) is left untouched by the sweep.
    if (!REGENERABLE_CACHE.test(ent.name)) return 0;

    const st = await ctx.ops.stat(p);
    return removeIfStale(p, st, ctx);
  } catch (err) {
    // Fail-closed per-entry: a stat or wholesale-rm failure is surfaced in the log and
    // skipped — it NEVER aborts the sweep and is never miscounted as success.
    ctx.log(`[tmp-sweep] failed to remove ${p}: ${String(err)}`);
    return 0;
  }
}

/** Sweep one directory: readdir (skip a missing/unreadable dir) then sum sweepEntry over it. */
async function sweepDir(dir: string, ctx: SweepCtx): Promise<number> {
  let entries: Dirent[];
  try {
    entries = (await ctx.ops.readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    // Missing/unreadable dir (e.g. no nested claude root yet) — skip it.
    return 0;
  }
  let removed = 0;
  for (const ent of entries) removed += await sweepEntry(dir, ent, ctx);
  return removed;
}

/**
 * The directories one sweep visits. An explicit `root` (`explicitRoot`, tests) sweeps ONLY that
 * root + its nested `claude-$uid` dir — today's behavior, byte-for-byte, and never touches the real
 * disk/legacy roots. The default (production) path expands (#1875) to the DEDUPED set of the bare
 * disk `agentTmpDir()` — where bare-`$TMPDIR` tool caches (fallow/bunx/agent-browser) land — the
 * disk claude `root` + nested, and the legacy tmpfs root + nested — where an adopted pre-upgrade
 * session's live agent still writes. No override → the roots collapse and dedupe to today's pair.
 */
function resolveSweepRoots(root: string, nestedName: string, explicitRoot: boolean): string[] {
  if (explicitRoot) return [root, join(root, nestedName)];
  const agentTmp = agentTmpDir();
  const legacy = legacyClaudeTmpRoot();
  return [
    ...new Set([
      ...(agentTmp ? [agentTmp] : []),
      root,
      join(root, nestedName),
      legacy,
      join(legacy, nestedName),
    ]),
  ];
}

/** One pressure-gated pass over the sweep roots. `forced` skips the gate entirely (and measures
 *  nothing). Returns what was removed plus the per-root reasons, split into roots that acted and
 *  roots that declined, so the caller can report both without re-deriving them. */
async function sweepGatedRoots(
  sweepRoots: string[],
  forced: boolean,
  thresholdPct: number,
  ctx: SweepCtx,
): Promise<{ removed: number; acted: string[]; gated: string[] }> {
  let removed = 0;
  const acted: string[] = [];
  const gated: string[] = [];
  for (const dir of sweepRoots) {
    if (!forced) {
      const { act, reason } = await tmpPressure(dir, { thresholdPct, ops: ctx.ops });
      (act ? acted : gated).push(reason);
      if (!act) continue;
    }
    removed += await sweepDir(dir, ctx);
  }
  return { removed, acted, gated };
}

/**
 * Threshold-gated inode guard. TOTAL by contract: it NEVER throws or rejects — any
 * unexpected error resolves to `{ swept:false, reason:"error", removed:0 }` after logging,
 * so a caller can fire-and-forget it on a timer without a guard.
 *
 * `thresholdPct <= 0` FORCES a sweep: the gate is skipped entirely (no `statfs` call), so no
 * unreadable-pressure reason can silently suppress an explicitly-requested sweep. That path
 * reports `reason: "swept forced (gate bypassed)"` — there is no measured use% to quote.
 *
 * Otherwise the gate is evaluated PER ROOT (`tmpPressure`) and only the pressured roots are swept;
 * an unpressured root in the same pass is left untouched. Gating once on `root` alone was wrong on
 * any host with a disk-backed `TMPDIR` (#1862): in production `root` is
 * `<agentTmpDir()>/claude-$uid`, holding only session scratch, while the caches this sweep exists
 * to reclaim pile up in the BARE `agentTmpDir()` beside it — so the single reading reported a quiet
 * root and the sweep never ran. When it does sweep, it walks `root` and the nested
 * `root/claude-$uid`, removing `node-compile-cache`
 * wholesale (pure cache) and age-gating known regenerable tool caches (see `REGENERABLE_CACHE`),
 * while LEAVING per-session/unknown scratch in place, the nested scratch dir itself (its
 * children are swept when it is the sweep root), and every root dir itself. Age-gating is
 * evaluated at stat time: an entry that looks fresh by mtime is kept. This is a best-effort age
 * check, not a TOCTOU-atomic guarantee — a writer touching an entry between our stat and rm is
 * not fenced out.
 */
export async function sweepClaudeTmp(opts?: SweepOpts): Promise<SweepResult> {
  const log = opts?.log ?? console.warn;
  try {
    const root = opts?.root ?? claudeTmpRoot();
    const thresholdPct =
      opts?.thresholdPct ?? envNum(process.env.SHEPHERD_TMP_INODE_PCT, DEFAULT_TMP_INODE_PCT);
    const staleMs = opts?.staleMs ?? envNum(process.env.SHEPHERD_TMP_STALE_HOURS, 24) * 3600_000;
    const now = opts?.now ?? Date.now();
    const ops: FsOps = opts?.fsOps ?? {
      statfs: fsp.statfs,
      readdir: fsp.readdir,
      stat: fsp.stat,
      rm: fsp.rm,
      unlink: fsp.unlink,
      rmdir: fsp.rmdir,
      opendir: fsp.opendir,
    };

    const nestedName = `claude-${uid()}`;
    const ctx: SweepCtx = { ops, now, staleMs, nestedName, log };
    const sweepRoots = resolveSweepRoots(root, nestedName, opts?.root !== undefined);

    // FORCED sweep (#1862): `thresholdPct <= 0` means "sweep unconditionally" — the operator's
    // one-click Doctor fix passes 0 for exactly that. Without this branch an unreadable gate
    // ("statfs-unavailable", or "root-missing" on a host whose claude root doesn't exist yet)
    // would silently suppress an explicitly-requested sweep. A 0% threshold has no other coherent
    // meaning. No pressure is measured at all here, so the reason string says so rather than
    // formatting a figure that was never taken.
    const forced = thresholdPct <= 0;
    const { removed, acted, gated } = await sweepGatedRoots(sweepRoots, forced, thresholdPct, ctx);

    // Every root declined ⇒ nothing was swept. Report the roots' own reasons rather than a single
    // invented one: on a mixed host they differ (a below-threshold tmpfs beside an unreadable
    // disk root), and collapsing them hides which reading actually held the sweep back.
    if (!forced && gated.length === sweepRoots.length) {
      return { swept: false, reason: [...new Set(gated)].join("; "), removed: 0 };
    }

    return {
      swept: true,
      // Keep the MEASUREMENT in the line, not just a root tally: "swept 1/2 root(s)" alone would
      // drop the one fact an operator reading the log needs — what the pressure actually was.
      reason: forced
        ? "swept forced (gate bypassed)"
        : `swept ${acted.length}/${sweepRoots.length} root(s): ${[...new Set(acted)].join("; ")}`,
      removed,
    };
  } catch (err) {
    log(`[tmp-sweep] unexpected error: ${String(err)}`);
    return { swept: false, reason: "error", removed: 0 };
  }
}

/**
 * Best-effort targeted teardown of one worktree's scratch dir (e.g. on session retire). Reclaims
 * BOTH the disk and legacy-tmpfs candidates (#1875) so an adopted pre-upgrade session's nested
 * scratch on the tmpfs is still freed. No-op per candidate when absent (`force:true`), swallows
 * every error — never throws. An explicit `opts.dir` (tests) targets exactly that one dir.
 */
export async function removeWorktreeScratch(
  worktreePath: string,
  opts?: { dir?: string; rm?: typeof fsp.rm },
): Promise<void> {
  const dirs = opts?.dir ? [opts.dir] : worktreeScratchDirCandidates(worktreePath);
  const rm = opts?.rm ?? fsp.rm;
  for (const dir of dirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort — continue to the next candidate */
    }
  }
}

interface ReapFallowOpts {
  staleMs?: number;
  now?: number;
  fsOps?: Pick<FsOps, "readdir" | "stat" | "rm">;
  log?: (msg: string) => void;
  /**
   * Overrides the directories scanned (default: computed `[claudeTmpRoot(), claude-$uid subdir,
   * tmpdir()]` set). Lets a test isolate the scan to a controlled root so the bare-`/tmp` scan
   * can't pull in a concurrent process's caches. Reference #817.
   */
  roots?: string[];
}

export interface ReapFallowResult {
  removed: number;
}

/** Shared context threaded through the fallow reaper helpers. */
interface ReapFallowCtx {
  ops: Pick<FsOps, "readdir" | "stat" | "rm">;
  now: number;
  staleMs: number;
  log: (msg: string) => void;
}

/** Sidecar files fallow writes beside each audit-base cache dir. Removed WITH their dir, and —
 *  when the dir is already gone — age-gate-removed on their own (see `reapOrphanSidecar`). */
const FALLOW_SIDECARS = [".lock", ".last-used", ".sha"];

/**
 * Age-gate-remove a sidecar whose cache dir NO LONGER EXISTS. A sidecar with a live dir is left
 * alone — it is removed alongside that dir. Without this an interrupted/externally-removed cache
 * leaves its sidecars behind permanently: they never match the dir path the reaper stats (157 such
 * orphans observed while diagnosing #1862). Fail-closed: any stat error counts as 0.
 */
async function reapOrphanSidecar(
  sidecar: string,
  dir: string,
  ctx: ReapFallowCtx,
): Promise<number> {
  try {
    await ctx.ops.stat(dir);
    return 0; // dir still there — the dir pass owns this sidecar
  } catch {
    /* dir gone ⇒ orphan */
  }
  try {
    return await removeIfStale(sidecar, await ctx.ops.stat(sidecar), ctx);
  } catch (err) {
    ctx.log(`[tmp-sweep] fallow sidecar reap failed for ${sidecar}: ${String(err)}`);
    return 0;
  }
}

/**
 * Handles ONE fallow-cache entry. A sidecar file is reaped only when orphaned; any name not
 * starting with `FALLOW_CACHE_PREFIX` is skipped. For a cache dir: stats the path, age-gates via
 * `removeIfStale`, and on removal best-effort removes each `FALLOW_SIDECARS` file beside it.
 * Per-entry try/catch — never aborts the pass, never rejects. Returns the number of entries
 * removed (the dir counts as 1; its sidecars are not counted separately).
 */
async function reapFallowEntry(root: string, ent: Dirent, ctx: ReapFallowCtx): Promise<number> {
  if (!ent.name.startsWith(FALLOW_CACHE_PREFIX)) return 0;

  const p = join(root, ent.name);
  const suffix = FALLOW_SIDECARS.find((s) => ent.name.endsWith(s));
  if (suffix) return reapOrphanSidecar(p, p.slice(0, -suffix.length), ctx);

  try {
    const st = await ctx.ops.stat(p);
    const wasRemoved = await removeIfStale(p, st, ctx);
    if (wasRemoved) {
      // Best-effort removal of sidecars; ignore individual failures.
      for (const s of FALLOW_SIDECARS) {
        await ctx.ops.rm(`${p}${s}`, { recursive: false, force: true }).catch(() => {});
      }
      return 1;
    }
    return 0;
  } catch (err) {
    ctx.log(`[tmp-sweep] fallow reap failed for ${p}: ${String(err)}`);
    return 0;
  }
}

/**
 * Reaps one root directory: readdirs it (skipping missing/unreadable roots silently) then
 * sums `reapFallowEntry` over every entry. Returns the count of dirs removed.
 */
async function reapFallowRoot(root: string, ctx: ReapFallowCtx): Promise<number> {
  let entries: Dirent[];
  try {
    entries = (await ctx.ops.readdir(root, { withFileTypes: true })) as Dirent[];
  } catch {
    // Missing/unreadable root — skip it silently.
    return 0;
  }
  let removed = 0;
  for (const ent of entries) removed += await reapFallowEntry(root, ent, ctx);
  return removed;
}

/**
 * Ungated reaper for stale `fallow-audit-base-cache-*` worktree cache dirs. Runs regardless of
 * inode pressure — decoupled from the `sweepClaudeTmp` threshold gate.
 *
 * Scans the deduped set of roots `[claudeTmpRoot(), join(claudeTmpRoot(), "claude-"+uid()),
 * tmpdir()]` (the third catches caches whose `TMPDIR` was the bare system `/tmp`). Only considers
 * entries whose name starts with `FALLOW_CACHE_PREFIX`. For each stale cache dir it removes the
 * dir and every `FALLOW_SIDECARS` file beside it; a sidecar whose dir is already gone is
 * age-gate-removed on its own. Per-entry try/catch — never aborts the pass, never rejects.
 * Returns `{ removed }` — entries removed, dirs and orphaned sidecars alike.
 */
export async function reapFallowCaches(opts?: ReapFallowOpts): Promise<ReapFallowResult> {
  const log = opts?.log ?? console.warn;
  const staleMs = opts?.staleMs ?? envNum(process.env.SHEPHERD_TMP_STALE_HOURS, 24) * 3600_000;
  const now = opts?.now ?? Date.now();
  const ops: Pick<FsOps, "readdir" | "stat" | "rm"> = opts?.fsOps ?? {
    readdir: fsp.readdir,
    stat: fsp.stat,
    rm: fsp.rm,
  };

  // Dedupe roots: claudeTmpRoot(), claude-$uid subdir, bare tmpdir() for caches whose TMPDIR was
  // the system default, and (when enabled) the bare disk agentTmpDir() — where an agent's Bash tool
  // running fallow writes `fallow-audit-base-cache-*` at its bare `$TMPDIR` (#1875). Without the
  // agentTmpDir() root those disk caches are reaped by NEITHER this pass nor sweepClaudeTmp, so they
  // accrete unbounded on disk. Using a Set so a reconfigured env can't double-scan. opts?.roots
  // overrides the computed set (lets tests isolate from bare /tmp — #817).
  const claudeRoot = claudeTmpRoot();
  const nestedRoot = join(claudeRoot, `claude-${uid()}`);
  const systemTmp = tmpdir();
  const agentTmp = agentTmpDir();
  const roots = opts?.roots
    ? [...new Set(opts.roots)]
    : [...new Set([claudeRoot, nestedRoot, systemTmp, ...(agentTmp ? [agentTmp] : [])])];

  const ctx: ReapFallowCtx = { ops, now, staleMs, log };
  let removed = 0;
  for (const root of roots) removed += await reapFallowRoot(root, ctx);

  return { removed };
}

// ── worktree reaper ─────────────────────────────────────────────────────────
//
// Removes abandoned agent git worktrees that live under a tmp root: a nested agent
// creates its own `git worktree add /tmp/…` for a configured repo, then finishes
// without removing it. Those worktrees hardlink `node_modules` into the forked pnpm
// store, so their survival pins every store file at `nlink = 2` — the store pass
// can only reclaim once they are gone. This reaper drops them; its `retained` count
// is the store pass's go/no-go signal.
//
// The removal is DESTRUCTIVE against possibly-unrecoverable data (a worktree can hold
// uncommitted edits + untracked files existing nowhere else), so it is guarded by a
// wall of refusals AND gated on live inode pressure — a destructive act needs a live
// justification. Every path comparison is realpath-normalized: porcelain emits resolved
// paths while a stored `worktreePath` / `tmpdir()` may be a symlink (macOS `/private/tmp`),
// and a non-match on the protective side is the dangerous direction.

/** Injectable git exec for the reaper: runs `git -C <cwd> <args>`, resolves stdout,
 *  rejects on non-zero exit or spawn failure. */
type ExecGit = (cwd: string, args: string[]) => Promise<string>;

const defaultExecGit: ExecGit = (cwd, args) =>
  execFileAsync("git", ["-C", cwd, ...args], { timeout: 60_000 }).then((r) => r.stdout);

export interface ReapWorktreesOpts {
  /** Configured repo paths to enumerate worktrees for (`listRepos(...).map(r => r.path)`). */
  repoPaths: string[];
  /** Live-session worktree dirs to spare (from `store.list({ activeOnly: true })`). */
  liveWorktreePaths?: string[];
  /** A RESOLVED snapshot of same-uid process cwds (from `liveProcCwds()`), taken by the
   *  caller so the synchronous `/proc` scan stays out of this async module. */
  liveCwds?: string[];
  /** Tmp roots a candidate must live under to be eligible. Default: the roots the sweep visits
   *  (`sweptRoots()`) plus the bare `tmpdir()`. Must include the BARE `agentTmpDir()`, not just
   *  `claudeTmpRoot()`: post-#1875 an agent's `git worktree add "$TMPDIR/x"` lands there (#1862). */
  tmpRoots?: string[];
  thresholdPct?: number;
  staleMs?: number;
  now?: number;
  log?: (msg: string) => void;
  execGit?: ExecGit;
  realpath?: (p: string) => Promise<string>;
  statfs?: FsOps["statfs"];
  fsOps?: Pick<FsOps, "readdir" | "stat" | "opendir">;
  /** Injectable removal (default `git worktree remove`, no `--force` — cleanliness proven). */
  removeWorktree?: (repo: string, worktreePath: string) => Promise<void>;
}

export interface ReapWorktreesResult {
  reaped: number;
  /** Candidates under a tmp root still on disk after the pass — the store pass skips when > 0. */
  retained: number;
}

/** A discovered, realpath-resolved worktree candidate under a tmp root. */
interface WorktreeCandidate {
  repo: string;
  path: string; // git-registered path
  real: string; // realpath-resolved (implies on-disk: realpath threw ⇒ not a candidate)
  root: string; // the MOST SPECIFIC tmp root it lives under — whose pressure gates its removal
  locked: boolean;
  bare: boolean;
  prunable: boolean;
}

/** Realpath-resolve each path, dropping unresolvable ones, deduped. */
async function resolveAllRealpaths(
  paths: string[],
  realpath: (p: string) => Promise<string>,
): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    try {
      out.push(await realpath(p));
    } catch {
      /* unresolvable (gone / broken) — drop */
    }
  }
  return [...new Set(out)];
}

/** Max entries the freshness walk will stat before giving up. Sized for a source tree
 *  with `node_modules`/`.git` pruned from descent; exhaustion resolves to *keep*. */
const FRESHNESS_ENTRY_BUDGET = 10_000;

/**
 * True when the worktree looks fresh (recently touched) — the KEEP-biased direction.
 * Bounded DFS from `root`, statting every entry for its mtime but pruning `node_modules`
 * and `.git` from DESCENT (they are stat'd for their own mtime — a recent install/git op
 * shows there — but never walked: `node_modules/.pnpm` alone is thousands of dirs and
 * would exhaust the budget). ANY of {a mtime within the window, a stat/readdir error,
 * budget exhaustion} ⇒ `true` (keep). Only a full, error-free walk finding nothing fresh
 * ⇒ `false` (provably stale ⇒ reapable).
 */
/** Mutable entry budget shared across a single freshness/idle walk. */
interface Budget {
  n: number;
}

/**
 * Scan ONE directory for the freshness walk. `stop: true` is the KEEP-biased outcome (a fresh
 * mtime, a stat/readdir error, or budget exhaustion); otherwise `children` are the sub-dirs to
 * descend, with `node_modules`/`.git` pruned from descent (stat'd for mtime, never walked).
 */
async function scanFreshDir(
  dir: string,
  cutoff: number,
  budget: Budget,
  readdir: FsOps["readdir"],
  stat: FsOps["stat"],
): Promise<{ stop: boolean; children: string[] }> {
  const keep = { stop: true, children: [] as string[] };
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return keep; // unreadable subtree → keep
  }
  const children: string[] = [];
  for (const ent of entries) {
    if (--budget.n < 0) return keep; // budget exhausted → keep (never a reap by omission)
    const p = join(dir, ent.name);
    try {
      if (Number((await stat(p)).mtimeMs) > cutoff) return keep; // a fresh entry → keep
    } catch {
      return keep; // stat error → keep
    }
    if (ent.isDirectory() && ent.name !== "node_modules" && ent.name !== ".git") children.push(p);
  }
  return { stop: false, children };
}

async function worktreeIsFresh(
  root: string,
  cutoff: number,
  readdir: FsOps["readdir"],
  stat: FsOps["stat"],
): Promise<boolean> {
  try {
    if (Number((await stat(root)).mtimeMs) > cutoff) return true;
  } catch {
    return true; // can't even stat the root → keep
  }
  const budget: Budget = { n: FRESHNESS_ENTRY_BUDGET };
  const stack: string[] = [root];
  while (stack.length > 0) {
    const scan = await scanFreshDir(stack.pop() as string, cutoff, budget, readdir, stat);
    if (scan.stop) return true;
    stack.push(...scan.children);
  }
  return false; // fully walked within budget, nothing fresh
}

/**
 * The refusal reason for a candidate, or `null` when it is safe to reap. Cheap checks
 * (porcelain annotations, the Shepherd-worktree marker, the live sets) run before the
 * `git status` spawn, which runs before the freshness fs-walk.
 */
async function worktreeRefusal(
  c: WorktreeCandidate,
  ctx: {
    liveWorktreePaths: string[];
    liveCwds: string[];
    cutoff: number;
    execGit: ExecGit;
    readdir: FsOps["readdir"];
    stat: FsOps["stat"];
  },
): Promise<string | null> {
  if (c.locked) return "locked";
  if (c.bare) return "bare";
  if (c.prunable) return "prunable";
  if (c.real.includes(WORKTREE_MARKER) || c.path.includes(WORKTREE_MARKER))
    return "shepherd-worktree";
  if (ctx.liveWorktreePaths.includes(c.real)) return "live-session";
  if (ctx.liveCwds.some((cwd) => isUnder(cwd, c.real))) return "live-cwd";

  // Dirty check — the `src/worktree.ts` idiom: ANY error counts as dirty (safe default),
  // because a worktree can hold work that exists nowhere else.
  let status: string;
  try {
    status = await ctx.execGit(c.path, ["status", "--porcelain"]);
  } catch {
    return "dirty";
  }
  if (status.trim().length > 0) return "dirty";

  if (await worktreeIsFresh(c.real, ctx.cutoff, ctx.readdir, ctx.stat)) return "fresh";
  return null;
}

/** Shared option resolution for the two tmp reclaimers: current time, the staleness `cutoff`
 *  (`SHEPHERD_TMP_STALE_HOURS`, default 24h), and the inode-pressure gate (`SHEPHERD_TMP_INODE_PCT`). */
function resolveTmpGate(opts: { now?: number; staleMs?: number; thresholdPct?: number }): {
  now: number;
  cutoff: number;
  thresholdPct: number;
} {
  const now = opts.now ?? Date.now();
  const cutoff =
    now - (opts.staleMs ?? envNum(process.env.SHEPHERD_TMP_STALE_HOURS, 24) * 3600_000);
  const thresholdPct =
    opts.thresholdPct ?? envNum(process.env.SHEPHERD_TMP_INODE_PCT, DEFAULT_TMP_INODE_PCT);
  return { now, cutoff, thresholdPct };
}

/** True iff the installed git meets the worktree-annotation floor (>= 2.38); unreadable ⇒ false. */
async function gitMeetsFloor(execGit: ExecGit, repo: string): Promise<boolean> {
  try {
    const v = parseGitVersion(await execGit(repo, ["--version"]));
    return !!v && gitVersionAtLeast(v, MIN_GIT_MAJOR, MIN_GIT_MINOR);
  } catch {
    return false;
  }
}

/** Enumerate every worktree of the configured repos that realpath-resolves under a tmp root,
 *  deduped by resolved path (overlapping repo configs can list the same tmp worktree twice). A
 *  path that fails realpath is gone (not on disk) and skipped. */
async function discoverTmpWorktreeCandidates(ctx: {
  repoPaths: string[];
  tmpRoots: string[];
  execGit: ExecGit;
  realpath: (p: string) => Promise<string>;
  log: (msg: string) => void;
}): Promise<WorktreeCandidate[]> {
  const candidates: WorktreeCandidate[] = [];
  const seen = new Set<string>();
  for (const repo of ctx.repoPaths) {
    let porcelain: string;
    try {
      porcelain = await ctx.execGit(repo, ["worktree", "list", "--porcelain"]);
    } catch (err) {
      ctx.log(`[tmp-sweep] worktree list failed for ${repo}: ${String(err)}`);
      continue;
    }
    for (const e of parseWorktrees(porcelain)) {
      let real: string;
      try {
        real = await ctx.realpath(e.path); // resolves ⇒ on disk; throws ⇒ gone, not a candidate
      } catch {
        continue;
      }
      // Most specific (longest) containing root wins: the roots nest
      // (`<agentTmpDir()>/claude-$uid` inside `agentTmpDir()`), and a candidate's removal should be
      // justified by the pressure of the directory it is actually piling up in, not its parent's.
      const root = ctx.tmpRoots
        .filter((r) => isUnder(real, r))
        .sort((a, b) => b.length - a.length)[0];
      if (root === undefined || seen.has(real)) continue;
      seen.add(real);
      candidates.push({
        repo,
        path: e.path,
        real,
        root,
        locked: e.locked,
        bare: e.bare,
        prunable: e.prunable,
      });
    }
  }
  return candidates;
}

/** Apply refusals to each candidate and reap those with a live justification. Returns the count
 *  removed. `canRemove` folds the git-floor + PER-ROOT pressure gate: false ⇒ discover-only. */
async function reapCandidates(
  candidates: WorktreeCandidate[],
  canRemove: (c: WorktreeCandidate) => boolean,
  refusalCtx: Parameters<typeof worktreeRefusal>[1],
  removeWorktree: (repo: string, worktreePath: string) => Promise<void>,
  log: (msg: string) => void,
): Promise<number> {
  let reaped = 0;
  for (const c of candidates) {
    const reason = await worktreeRefusal(c, refusalCtx);
    if (reason) {
      log(`[tmp-sweep] keep worktree ${c.real}: ${reason}`);
      continue;
    }
    if (!canRemove(c)) continue; // reapable but no live justification to act
    try {
      await removeWorktree(c.repo, c.path);
      reaped += 1;
      log(`[tmp-sweep] reaped abandoned worktree ${c.real}`);
    } catch (err) {
      log(`[tmp-sweep] worktree remove failed for ${c.real}: ${String(err)}`);
    }
  }
  return reaped;
}

/** Resolve each root's pressure once, logging the ones that decline. Keyed by the SAME resolved
 *  root strings a candidate is attributed to, so the lookup cannot silently miss. */
async function pressureByRoot(
  roots: string[],
  thresholdPct: number,
  ops: Partial<PressureOps>,
  log: (msg: string) => void,
): Promise<Map<string, boolean>> {
  const pressured = new Map<string, boolean>();
  for (const root of roots) {
    const { act, reason } = await tmpPressure(root, { thresholdPct, ops });
    pressured.set(root, act);
    if (!act) log(`[tmp-sweep] worktree reap: no pressure under ${root} (${reason})`);
  }
  return pressured;
}

/**
 * Reap abandoned tmp worktrees of the configured repos. TOTAL by contract — never throws;
 * any unexpected failure resolves to a conservative `retained >= 1` so the store pass skips.
 *
 * Discovery + refusal always run; only the actual REMOVAL is gated on git >= 2.38 (the floor
 * for the `locked`/`prunable` annotations that keep a dangling record from being reaped) AND
 * inode pressure >= `thresholdPct`. `retained` = candidates under a tmp root still on disk
 * after the pass (every candidate was realpath-resolved, so it exists) minus those removed —
 * deliberately NOT the raw refusal list, whose off-tmp entries would pin it non-zero forever.
 */
export async function reapAbandonedWorktrees(
  opts: ReapWorktreesOpts,
): Promise<ReapWorktreesResult> {
  const log = opts.log ?? console.warn;
  try {
    const firstRepo = opts.repoPaths[0];
    if (firstRepo === undefined) return { reaped: 0, retained: 0 };

    const { cutoff, thresholdPct } = resolveTmpGate(opts);
    const realpath = opts.realpath ?? fsp.realpath;
    const statfs = opts.statfs ?? fsp.statfs;
    const readdir = opts.fsOps?.readdir ?? fsp.readdir;
    const stat = opts.fsOps?.stat ?? fsp.stat;
    const execGit = opts.execGit ?? defaultExecGit;
    const removeWorktree =
      opts.removeWorktree ??
      ((repo: string, wt: string) => execGit(repo, ["worktree", "remove", wt]).then(() => {}));

    const [tmpRoots, liveWorktreePaths, liveCwds] = await Promise.all([
      resolveAllRealpaths(opts.tmpRoots ?? [...sweptRoots(), tmpdir()], realpath),
      resolveAllRealpaths(opts.liveWorktreePaths ?? [], realpath),
      resolveAllRealpaths(opts.liveCwds ?? [], realpath),
    ]);

    // Git floor: without the 2.36+ porcelain annotations a locked/prunable worktree looks
    // reapable while its record can't be pruned — a dangling entry. Below the floor we still
    // discover (so `retained` reflects reality and the store skips) but never remove.
    const gitOk = await gitMeetsFloor(execGit, firstRepo);
    if (!gitOk) log("[tmp-sweep] worktree reap: git < 2.38 or unreadable — discovering only");

    // PER-ROOT pressure (#1862): reading it once off `tmpdir()` let a quiet tmpfs veto reclaim on
    // a pressured disk root — and post-#1875 the disk root is where agents actually write.
    const pressured = await pressureByRoot(
      tmpRoots,
      thresholdPct,
      { statfs, opendir: opts.fsOps?.opendir },
      log,
    );

    const candidates = await discoverTmpWorktreeCandidates({
      repoPaths: opts.repoPaths,
      tmpRoots,
      execGit,
      realpath,
      log,
    });

    const refusalCtx = { liveWorktreePaths, liveCwds, cutoff, execGit, readdir, stat };
    const reaped = await reapCandidates(
      candidates,
      (c) => gitOk && (pressured.get(c.root) ?? false),
      refusalCtx,
      removeWorktree,
      log,
    );
    // Every candidate is on-disk-under-tmp (realpath-resolved); those not reaped remain.
    return { reaped, retained: candidates.length - reaped };
  } catch (err) {
    log(`[tmp-sweep] worktree reap unexpected error: ${String(err)}`);
    // Defensive: an unknown failure must NOT let the store pass proceed.
    return { reaped: 0, retained: 1 };
  }
}

// ── forked pnpm store reclaimer ─────────────────────────────────────────────
//
// pnpm forks a content-addressable store onto the tmpfs (`<tmp>/.pnpm-store/v<N>/`) to
// stay same-filesystem for hardlinking. Store content lingers pinning inodes long after the
// worktrees that linked it are gone. Reclaim is PARTIAL (#1880): under each idle version dir,
// unlink only the `nlink === 1` content (nothing else references it) and prune the bucket dirs
// that empty out, leaving still-linked (`nlink > 1`) content and the `index/` metadata intact.
// `index/` pointing at removed content is a clean re-fetch trigger, not a hard error — measured
// on pnpm 10.28.2: offline reinstall reports `ERR_PNPM_NO_OFFLINE_TARBALL` (it *wants* to
// download), online reinstall re-fetches cleanly. So partial reclaim is safe GIVEN NETWORK AT
// REINSTALL TIME. This supersedes #1874's all-or-nothing removal: the residual case where some
// content is still hardlinked (a surviving worktree, an orphaned `node_modules`) — where
// all-or-nothing freed ZERO — now frees the unlinked fraction. Every unprobable subtree or
// per-entry error resolves to KEEP: we only ever remove content we positively proved is
// `nlink === 1`, never on a failure-to-probe.

/** The `/^v\d+$/` version subdirs of a store root. An empty result makes the caller skip (an
 *  unrecognized layout is never touched) — the harmless direction. */
export function resolveStoreVersionDirs(rootEntries: Dirent[]): string[] {
  return rootEntries.filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => e.name);
}

/**
 * Provably idle iff a full depth-2 enumeration from the versioned dir finds every mtime
 * <= `cutoff`. Depth 2 is load-bearing: a mid-install store's depth-<=1 mtimes stop moving
 * once the buckets exist, so a shallower probe reads a busy store as idle. Any error, or a
 * budget overrun, ⇒ `false` (keep).
 */
/** Every entry directly under `dir` has an mtime <= `cutoff` (and budget wasn't exhausted).
 *  Throws propagate to the caller's catch. */
async function childrenAllStale(
  dir: string,
  cutoff: number,
  budget: Budget,
  readdir: FsOps["readdir"],
  stat: FsOps["stat"],
): Promise<boolean> {
  for (const e of (await readdir(dir, { withFileTypes: true })) as Dirent[]) {
    if (--budget.n < 0) return false;
    if (Number((await stat(join(dir, e.name))).mtimeMs) > cutoff) return false;
  }
  return true;
}

async function storeVersionDirIsIdle(
  vdir: string,
  cutoff: number,
  readdir: FsOps["readdir"],
  stat: FsOps["stat"],
): Promise<boolean> {
  const budget: Budget = { n: 100_000 };
  try {
    for (const e1 of (await readdir(vdir, { withFileTypes: true })) as Dirent[]) {
      if (--budget.n < 0) return false;
      const p1 = join(vdir, e1.name);
      if (Number((await stat(p1)).mtimeMs) > cutoff) return false;
      if (e1.isDirectory() && !(await childrenAllStale(p1, cutoff, budget, readdir, stat)))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Running tally of a partial reclaim: content files unlinked + bucket dirs pruned. */
interface ReclaimCounters {
  freedFiles: number;
  freedDirs: number;
}
type ContentOps = Pick<FsOps, "readdir" | "stat" | "unlink" | "rmdir">;

/** Reclaim a subdir, then prune it if it emptied out. `true` iff it was pruned (`rmdir` ok). */
async function reclaimAndPruneSubdir(
  p: string,
  ops: ContentOps,
  c: ReclaimCounters,
): Promise<boolean> {
  if (!(await reclaimContentDir(p, ops, c))) return false; // still holds linked/unprobable content
  try {
    await ops.rmdir(p);
    c.freedDirs += 1;
    return true;
  } catch {
    return false; // rmdir raced/failed → keep
  }
}

/** Unlink a content file iff it is provably `nlink === 1`. `true` iff it was unlinked. Any
 *  stat/unlink error or a surviving reference (`nlink > 1`) leaves it in place → `false`. */
async function unlinkIfUnlinked(p: string, ops: ContentOps, c: ReclaimCounters): Promise<boolean> {
  let nlink: number;
  try {
    nlink = Number((await ops.stat(p)).nlink);
  } catch {
    return false; // unstattable → keep
  }
  if (nlink > 1) return false; // another reference survives → keep
  try {
    await ops.unlink(p);
    c.freedFiles += 1;
    return true;
  } catch {
    return false; // unlink failed → keep
  }
}

/**
 * Recursive post-order reclaim of one content dir: unlink every file that is provably
 * `nlink === 1` (no other reference), recurse into subdirs and `rmdir` any that empty out, and
 * leave still-linked (`nlink > 1`) files in place. NEVER throws — an unreadable dir or a
 * per-entry stat/unlink/rmdir error just leaves that entry standing (counted as remaining), so
 * we only ever remove content we positively proved is unlinked. Returns `true` iff `dir` has
 * ZERO remaining entries after the pass (so the caller can prune it). Exhaustive, unbudgeted:
 * the full walk is the point, and it runs microtask-deferred off the event loop.
 */
async function reclaimContentDir(
  dir: string,
  ops: ContentOps,
  c: ReclaimCounters,
): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = (await ops.readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return false; // unprobable subtree → keep, treat as non-empty
  }
  let remaining = 0;
  for (const ent of entries) {
    const p = join(dir, ent.name);
    const reclaimed = ent.isDirectory()
      ? await reclaimAndPruneSubdir(p, ops, c)
      : await unlinkIfUnlinked(p, ops, c);
    if (!reclaimed) remaining += 1;
  }
  return remaining === 0;
}

export interface ReclaimStoreOpts {
  /** The forked store roots. Default: `.pnpm-store` under each of `tmpdir()` and (when enabled)
   *  the bare `agentTmpDir()` — the only names allowed to reach those bare roots. pnpm forks its
   *  store beside the install to stay same-filesystem, so post-#1875 a trusted agent's install
   *  forks it on DISK, which the tmpfs-only default never reclaimed (#1862). A wrong root just
   *  yields a missing dir → safe skip. */
  storeRoots?: string[];
  thresholdPct?: number;
  staleMs?: number;
  now?: number;
  statfs?: FsOps["statfs"];
  fsOps?: Pick<FsOps, "readdir" | "stat" | "unlink" | "rmdir" | "opendir">;
  log?: (msg: string) => void;
}

/** Default store roots: `.pnpm-store` under the tmpfs and the disk agent tmp root, deduped. */
function defaultStoreRoots(): string[] {
  const agentTmp = agentTmpDir();
  return [...new Set([tmpdir(), ...(agentTmp ? [agentTmp] : [])])].map((r) =>
    join(r, ".pnpm-store"),
  );
}

export interface ReclaimStoreResult {
  /** Content files unlinked (`nlink === 1`) across all idle version dirs. */
  freedFiles: number;
  /** Bucket dirs pruned after emptying out. */
  freedDirs: number;
  /** The per-store-root outcomes, deduped and joined: a skip reason (`below-threshold …`,
   *  `no-store`, `sibling-fresh …`, …) for each root that was skipped, and `reclaimed` for each
   *  root whose per-file pass ran (the freed counts carry the detail). */
  reason: string;
}

/** A skip reason for any non-`v*` sibling of the store root that could be freshly written while
 *  the two v-dir probes (which only look inside `v*`) read "idle" — else `null`. */
async function siblingBlocker(
  rootEntries: Dirent[],
  storeRoot: string,
  cutoff: number,
  stat: FsOps["stat"],
): Promise<string | null> {
  for (const e of rootEntries) {
    if (/^v\d+$/.test(e.name)) continue;
    let st: Awaited<ReturnType<FsOps["stat"]>>;
    try {
      st = await stat(join(storeRoot, e.name));
    } catch {
      return `sibling-unstattable ${e.name}`;
    }
    if (Number(st.mtimeMs) > cutoff) return `sibling-fresh ${e.name}`;
    if (e.isDirectory()) return `sibling-unrecognized ${e.name}`;
  }
  return null;
}

/** Partial-reclaim every depth-2-idle version dir's `files/` tree into `c`; a busy dir is
 *  skipped (logged), never touched. `index/` metadata is left intact as a re-fetch trigger. */
async function reclaimIdleVersionDirs(
  storeRoot: string,
  versionDirs: string[],
  cutoff: number,
  ops: ContentOps,
  c: ReclaimCounters,
  log: (msg: string) => void,
): Promise<void> {
  for (const v of versionDirs) {
    const vdir = join(storeRoot, v);
    if (!(await storeVersionDirIsIdle(vdir, cutoff, ops.readdir, ops.stat))) {
      log(`[tmp-sweep] store reclaim: skip busy version dir ${v}`);
      continue;
    }
    await reclaimContentDir(join(vdir, "files"), ops, c);
  }
}

/**
 * Partial reclaim of the forked pnpm store. TOTAL by contract — never throws. Under sustained
 * inode pressure, for each depth-2-idle version dir it unlinks the `nlink === 1` content in
 * `files/`, prunes the bucket dirs that empty out, and leaves still-linked content, `index/`,
 * and the store root intact. WHOLE-STORE skip gates (return freed 0): inode pressure below
 * threshold, an unreadable / non-`v<N>` store, or a fresh / unrecognized non-`v*` sibling
 * (active install → touch nothing). A NON-idle version dir is skipped per-dir (logged), so an
 * idle sibling version dir is still reclaimed. Unlike #1874's all-or-nothing removal, a
 * surviving hardlink no longer blocks the reclaim — the linked file is simply kept. The caller
 * runs the worktree reaper FIRST so a truly-abandoned worktree's links drop to `nlink === 1`
 * before this pass. Safe GIVEN NETWORK AT REINSTALL TIME (see module header).
 */
export async function reclaimForkedPnpmStore(opts: ReclaimStoreOpts): Promise<ReclaimStoreResult> {
  const log = opts.log ?? console.warn;
  const c: ReclaimCounters = { freedFiles: 0, freedDirs: 0 };
  try {
    const storeRoots = opts.storeRoots ?? defaultStoreRoots();
    const { cutoff, thresholdPct } = resolveTmpGate(opts);
    const ops: ContentOps = {
      readdir: opts.fsOps?.readdir ?? fsp.readdir,
      stat: opts.fsOps?.stat ?? fsp.stat,
      unlink: opts.fsOps?.unlink ?? fsp.unlink,
      rmdir: opts.fsOps?.rmdir ?? fsp.rmdir,
    };
    const pressureOps = { statfs: opts.statfs ?? fsp.statfs, opendir: opts.fsOps?.opendir };

    const reasons: string[] = [];
    for (const storeRoot of storeRoots) {
      // Gate on the pressure of the store's OWN parent, not a fixed `tmpdir()`: a quiet tmpfs must
      // not veto reclaiming a store that forked onto a pressured disk root, or vice versa (#1862).
      const { act, reason } = await tmpPressure(dirname(storeRoot), {
        thresholdPct,
        ops: pressureOps,
      });
      reasons.push(act ? await reclaimOneStore(storeRoot, cutoff, ops, c, log) : reason);
    }
    return { ...c, reason: [...new Set(reasons)].join("; ") || "no-store-root" };
  } catch (err) {
    log(`[tmp-sweep] store reclaim unexpected error: ${String(err)}`);
    return { ...c, reason: "error" };
  }
}

/** Partial-reclaim ONE forked store root, accumulating into `c`. Returns its skip/act reason. */
async function reclaimOneStore(
  storeRoot: string,
  cutoff: number,
  ops: ContentOps,
  c: ReclaimCounters,
  log: (msg: string) => void,
): Promise<string> {
  let rootEntries: Dirent[];
  try {
    rootEntries = (await ops.readdir(storeRoot, { withFileTypes: true })) as Dirent[];
  } catch {
    return "no-store";
  }

  const versionDirs = resolveStoreVersionDirs(rootEntries);
  if (versionDirs.length === 0) return "no-version-dir";

  const sibling = await siblingBlocker(rootEntries, storeRoot, cutoff, ops.stat);
  if (sibling) return sibling;

  await reclaimIdleVersionDirs(storeRoot, versionDirs, cutoff, ops, c, log);
  return "reclaimed";
}

interface PruneOpts {
  /** Injectable git-exec hook for tests. Receives the same args as `git -C <repo> worktree prune`. */
  execGit?: (repo: string, args: string[]) => Promise<void>;
  /** Injectable git-repo predicate for tests. Defaults to an async `.git` presence check. */
  isGitRepo?: (repo: string) => Promise<boolean>;
  log?: (msg: string) => void;
}

export interface PruneResult {
  pruned: number;
  failed: number;
}

/**
 * Runs `git worktree prune` for each supplied repo path that is a git repo — prunes every
 * orphaned record (missing working dir) regardless of how the dir vanished (reboot,
 * tmpfiles, manual rm). The caller enumerates *every* work-dir folder (not just git repos),
 * so a non-git folder is skipped silently up front — neither logged nor counted — rather
 * than spawning git and logging its `fatal: not a git repository` as a failure. Per-repo
 * try/catch on the rest: a git repo whose prune truly errors is logged and skipped while the
 * others still run. Never rejects. Returns `{ pruned, failed }`.
 */
export async function pruneRepoWorktrees(
  repoPaths: string[],
  opts?: PruneOpts,
): Promise<PruneResult> {
  const log = opts?.log ?? console.warn;
  const execGit =
    opts?.execGit ?? ((repo: string, args: string[]) => execFileAsync("git", args).then(() => {}));
  const isGitRepo =
    opts?.isGitRepo ??
    ((repo: string) =>
      fsp.access(join(repo, ".git")).then(
        () => true,
        () => false,
      ));

  let pruned = 0;
  let failed = 0;
  for (const repo of repoPaths) {
    // Skip non-git folders silently: the work dir holds plain project folders alongside
    // repos, and pruning those only yields a benign "not a git repository" error.
    if (!(await isGitRepo(repo))) continue;
    try {
      // `--expire=now` makes the immediate-prune intent explicit. A bare `git worktree prune`
      // already defaults to `--expire=TIME_MAX` (prune every orphaned record regardless of age),
      // but `gc.worktreePruneExpire` (default 3.months.ago) governs the prune that automatic
      // `git gc` runs — so being explicit here keeps reaped records (deleted at ~24h) from being
      // misread as subject to that 3-month window.
      await execGit(repo, ["-C", repo, "worktree", "prune", "--expire=now"]);
      pruned += 1;
    } catch (err) {
      log(`[tmp-sweep] git worktree prune failed for ${repo}: ${String(err)}`);
      failed += 1;
    }
  }
  return { pruned, failed };
}
