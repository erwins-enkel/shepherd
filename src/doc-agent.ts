import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildTransientAgentArgv } from "./transient-agent-argv";
import { EmptyDiffError } from "./forge/types";
import type { GitForge, GitState } from "./forge/types";
import { isSettledIdle } from "./recap-core";
import type { HerdrDriver } from "./herdr";
import { HerdrUnavailableError } from "./herdr";
import type { SessionStore } from "./store";
import type { DocAgentOutcome, DocAgentRun, Session } from "./types";
import type { RoleEnvironment } from "./default-model";
import type { SessionUsage } from "./usage";
import { readSessionUsage } from "./usage";
import { apiKeyFailClosed } from "./spawn-auth";
import { resolveAuxSpawn, type MembraneSeams } from "./spawn-membrane";
import type { WorktreeMgr } from "./worktree";

const execFileP = promisify(execFile);

/** Async git runner (returns stdout) — keeps the single-process event loop unblocked during the
 *  finalize stage/commit/push and the boot sweep (house rule: no blocking subprocess on the loop). */
async function defaultGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout;
}

/** The server's own install root (the repo root, one level above src/). Used to resolve the
 *  pinned prettier binary + node_modules — the managed target repo may have no node_modules of its
 *  own, so prettier MUST NOT be resolved from there (it would silently no-op or fail on missing
 *  plugins). Mirrors the pattern at egress.ts:94 and server.ts:127. */
export const SERVER_INSTALL_ROOT = resolve(import.meta.dir, "..");

/** Run the server's pinned prettier `--check` over `files` with ALL ignore files disabled
 *  (`--ignore-path devNull`) and reject if any file is not prettier-clean. Same `cwd`/`configPath`
 *  as {@link defaultPrettierWrite}, so plugin resolution is identical (see that doc). No-op on an
 *  empty list. Used as {@link defaultPrettierWrite}'s fail-closed verify; also exported so tests can
 *  exercise the detection half on its own. */
export async function assertPrettierClean(args: {
  cwd: string;
  configPath: string;
  files: string[];
}): Promise<void> {
  if (args.files.length === 0) return;
  const binary = join(SERVER_INSTALL_ROOT, "node_modules", ".bin", "prettier");
  await execFileP(
    binary,
    ["--check", "--ignore-path", devNull, "--config", args.configPath, "--", ...args.files],
    { cwd: args.cwd },
  );
}

/** Format `files` with the server's pinned prettier, then verify. No-op when the list is empty.
 *  `cwd` should be SERVER_INSTALL_ROOT: prettier 3 resolves the bare plugin specifiers in
 *  `configPath` (`prettier-plugin-svelte`/`-tailwindcss`) by importing from a synthetic module
 *  anchored at the CWD (verified on 3.8.4 — a wrong cwd fails with `imported from <cwd>/noop.js`),
 *  and those plugins are loaded for every parser, markdown included. SERVER_INSTALL_ROOT is the one
 *  directory guaranteed to have them (co-located with this pinned prettier); the managed worktree's
 *  own node_modules may be absent.
 *
 *  `--ignore-path devNull` disables ALL ignore files: the caller passes an already-whitelisted,
 *  explicit file list (IN_SCOPE ∩ `docs/` ∩ existing), so prettier's ignore is redundant — and
 *  harmful, because doc-agent worktrees live under `.shepherd-worktrees/` (worktree.ts), whose
 *  component matches the `.shepherd-*` glob in the repo's own `.prettierignore`, silently making
 *  `--write` a no-op on every doc file (the file is "ignored"). CI then checks the same file from a
 *  clean checkout where nothing is ignored and fails `prettier --check`, so the doc PR is never
 *  green and never auto-merges. Disabling ignores makes formatting independent of the worktree's
 *  absolute location.
 *
 *  Fail-closed: after `--write`, {@link assertPrettierClean} runs `--check` with the SAME
 *  cwd/config/ignore (only the mode flag differs) → prettier write→check is idempotent, so a valid
 *  run never false-aborts, while a residual non-conformance (a future silent skip, config/version
 *  drift, plugin load failure) throws here. Throws on prettier error — the caller catches to abort
 *  the run (no commit/push/PR). */
export async function defaultPrettierWrite(args: {
  cwd: string;
  configPath: string;
  files: string[];
}): Promise<void> {
  if (args.files.length === 0) return;
  const binary = join(SERVER_INSTALL_ROOT, "node_modules", ".bin", "prettier");
  await execFileP(
    binary,
    ["--write", "--ignore-path", devNull, "--config", args.configPath, "--", ...args.files],
    { cwd: args.cwd },
  );
  await assertPrettierClean(args);
}

/** Thrown by stageInScope when `prettier --write` fails, so finalize can fail-closed:
 *  abort the run (no commit/push/PR) and record an `error` outcome instead of swallowing
 *  the failure and committing unformatted docs. */
export class PrettierFormatError extends Error {
  constructor(
    readonly repoPath: string,
    readonly files: string[],
    options?: { cause?: unknown },
  ) {
    super(`prettier failed to format docs for ${repoPath}: ${files.join(", ")}`, options);
    this.name = "PrettierFormatError";
  }
}

/** Prefix for ephemeral doc-agent herdr names. Each run appends 8 hex of a fresh UUID so an
 *  orphaned husk (after a restart) can NEVER squat a stable name — a re-spawn always gets a new
 *  name, so `agent_name_taken` is impossible by construction (the distiller's fix; see
 *  DISTILL_LABEL). The underscores are load-bearing: prompt-derived session slugs are `[a-z0-9-]`
 *  only, so no real session collides, and reapOrphans can match husks by this prefix safely. */
export const DOC_AGENT_LABEL = "__docagent__";

/** Worktree/branch name stem. worktree.create() prepends `shepherd/`, so the branch is
 *  `shepherd/docs-update-<8hex>`. reapOrphans matches `shepherd/${DOC_BRANCH_PREFIX}`. */
const DOC_BRANCH_PREFIX = "docs-update-";

/** Refname grammar (mirrors BranchPruner/worktree.ts): rejects a leading "-" so a branch name can
 *  never smuggle a flag into `git push origin --delete <branch>`. */
const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;

/** Max forge prStatus lookups per boot remote-reap (matches BranchPruner). The rest wait for the
 *  next boot — orphan remote branches are durable, so an unbounded backlog never accumulates. */
const REMOTE_REAP_CAP = 20;

/** The agent writes this at the worktree root as its FINAL action: a per-change grounding bullet
 *  list + an "Uncertain / needs human judgment" section. Its presence is the completion signal; its
 *  content becomes the PR body. It lives OUTSIDE the staged in-scope list so it is never committed. */
const SENTINEL = ".shepherd-doc-update.md";

/** Layout guard marker: the partition/prompt/staging are Shepherd-doc-layout-specific, so a repo
 *  that lacks this tree is rejected before any spawn (it would have nothing to stage). */
const DOC_TREE_MARKER = "docs-site/src/content/docs";

/** Re-target run marker (issue #956 Option B): written at the worktree root so a restart can
 *  re-adopt a re-target run with its mode + target PR even after the in-flight map is lost. Holds
 *  `{ prNumber, headBranch, base }`. It lives OUTSIDE {@link IN_SCOPE_PATHS}, so the staging
 *  `git add -- <inScope>` already excludes it (same posture as {@link SENTINEL}). */
const RETARGET_MARKER = ".shepherd-doc-retarget.json";

/** Default settled-idle debounce before a re-target run fires (mirrors recap's
 *  DEFAULT_IDLE_THRESHOLD_MS): a code-PR session must be idle+green this long before we push docs
 *  onto its branch, so we never re-target a still-churning PR. */
const DEFAULT_IDLE_THRESHOLD_MS = 120_000;

/** The EXPLICIT in-scope file list (repo-relative). finalize() stages ONLY these (∩ files that
 *  exist), so any agent edit outside the set — the Astro app, the generated `reference/cli/*`, or a
 *  brand-new file — is never staged and can't reach the PR. This is the structural off-limits
 *  boundary that backs the prompt-level instruction. New-page creation is out of scope (#882). */
const IN_SCOPE_PATHS: readonly string[] = [
  // Repo-root hand-written prose sources (the docs-site reference/* renders are git-ignored).
  "docs/external-task-api.md",
  "docs/sandbox-security.md",
  "docs/token-usage-analysis.md",
  // docs-site-native committed prose.
  "docs-site/src/content/docs/index.md",
  "docs-site/src/content/docs/getting-started.md",
  "docs-site/src/content/docs/operating.md",
  "docs-site/src/content/docs/reference/configuration.md",
  "docs-site/src/content/docs/reference/glossary.md",
];

/** How many recent commits the agent grounds its staleness check against. */
const COMMIT_WINDOW = 50;

const COMMIT_MSG = "docs: sync docs to recent source changes";

/** Zeroed usage written when a finalize completes a spawn row but the transcript is unreadable
 *  (GC'd / partial) — so the row is never left dangling. Same shape as review.ts's zeroedUsage. */
const ZEROED_USAGE: SessionUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  messageCount: 0,
  lastActivity: null,
  byModel: {},
  fullRecaches: 0,
  sidechainCount: 0,
};

export type DocAgentStatus = "started" | "skipped" | "error";
export interface DocAgentResult {
  status: DocAgentStatus;
  reason?: string;
}
export interface DocAgentFinalize {
  repoPath: string;
  /** PR url when a doc-update PR was opened; null when docs were already current. */
  url: string | null;
  outcome: DocAgentOutcome;
}

interface InFlight {
  repoPath: string;
  worktreePath: string;
  branch: string;
  base: string;
  terminalId: string;
  agentName: string;
  /** The agent's forced --session-id — the reviewer_spawns PK, used to complete the cost row. */
  spawnSessionId: string;
  startedAt: number;
  finalizing?: boolean;
  /** "fresh" = the nightly/merge path (opens a standalone `shepherd/docs-update-*` PR).
   *  "retarget" = issue #956 Option B (pushes the doc commit onto an OPEN code PR's head branch). */
  mode: "fresh" | "retarget";
  /** The code PR number being re-targeted (retarget only). */
  prNumber?: number;
  /** The code PR's head branch = the push target for the doc commit (retarget only). */
  headBranch?: string;
  /** The originating session's worktree path, for the best-effort owner-branch ff (retarget only). */
  ownerWorktreePath?: string;
  /** The code PR head SHA at re-target start — the worktree base + the ff safety guard (retarget). */
  headSha?: string;
}

/** Re-target grounding context: the open code PR the doc agent is checked out at the head of. */
export interface RetargetPromptCtx {
  prNumber: number;
  prTitle: string;
}

export interface DocAgentDeps extends MembraneSeams {
  herdr: Pick<HerdrDriver, "start" | "stop" | "list" | "closeTab">;
  worktree: Pick<WorktreeMgr, "create" | "remove" | "gitCommonDir" | "ensureBaseRef">;
  resolveForge: (repoPath: string) => GitForge | null;
  /** Repos to enumerate in the boot orphan-sweep (herdr-independent worktree prune) and the nightly
   *  cadence sweep. */
  repos: () => string[];
  /** Persisted per-repo cadence markers (last-sha / nightly-day / merged-seen) + durable
   *  spawn-cost rows (reviewer_spawns, reused for doc-agent attribution; issue #502/#905). */
  store: Pick<
    SessionStore,
    | "getSetting"
    | "setSetting"
    | "recordReviewerSpawn"
    | "completeReviewerSpawn"
    | "listReviewerSpawns"
    | "recordDocAgentRun"
    | "listDocAgentRuns"
    | "list"
  >;
  // optional environment thunk (CLI + model, read per spawn → live settings)
  env?: () => RoleEnvironment;
  /** Phase-1 escalation: when false (Phase-0 observe), finalize() is log-only (no commit/push/PR). */
  act?: boolean;
  onChange?: (f: DocAgentFinalize) => void;
  now?: () => number;
  timeoutMs?: number;
  /** Local hour (0–23) at/after which the nightly sweep evaluates a repo. */
  nightlyHour?: number;
  // Injectable seams (tests).
  /** Local `YYYY-MM-DD` for `now` — the nightly once/day key. */
  dayKey?: (now: number) => string;
  git?: (cwd: string, args: string[]) => Promise<string>;
  prettier?: (args: { cwd: string; configPath: string; files: string[] }) => Promise<void>;
  fileExists?: (p: string) => boolean;
  readSentinel?: (worktreePath: string) => string | null;
  /** Cached PR state per session (Task 2 wires it to `prPoller.get`). The re-target sweep reads it
   *  to find open+green+doc-relevant code PRs. */
  gitState?: (sessionId: string) => GitState | undefined;
  /** Settled-idle debounce before a re-target run fires (default {@link DEFAULT_IDLE_THRESHOLD_MS}). */
  idleThresholdMs?: number;
  /** Build the agent task prompt. `ctx` (re-target only) grounds the agent on the open PR's diff
   *  instead of the recent-commit window. */
  buildPrompt?: (base: string, ctx?: RetargetPromptCtx) => string;
  /** Read a spawn's token usage from its transcript at finalize (cost attribution). Mirrors
   *  herd-digest.ts's identical dep + readSessionUsage default. */
  readUsage?: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;
  /** Write the re-target marker (tests inject a fake; default `writeFileSync`). */
  writeMarker?: (path: string, contents: string) => void;
  /** Read the re-target marker on boot re-adopt (tests inject a fake; default `readFileSync`). */
  readMarker?: (path: string) => string | null;
}

/**
 * PR-gated AI doc agent (issue #882, epic #875 Phase 3).
 *
 * Manual-trigger, flag-gated (config.docAgentEnabled). On `consider(repoPath)` it spawns a scoped,
 * `dontAsk` Claude Code agent in a disposable worktree (`buildTransientAgentArgv("doc", …)`); the agent EDITS
 * stale prose docs and writes a {@link SENTINEL} summary, but runs NO git. On the next `tick()` the
 * trusted server stages ONLY the in-scope file list, commits `--no-verify`, pushes, and opens a PR
 * via `forge.openPr()` — never an auto-merge. Mirrors the worktree+git tail of {@link
 * import("./promote").Promoter} and the spawn/membrane posture of ReviewService.
 *
 * Restart-safety: the unique-per-run herdr name (`__docagent__<8hex>`) makes name-squat impossible;
 * `reapOrphans()` (boot) additionally re-adopts a finished/in-progress interrupted run, prunes dead
 * ones (+ their husk tabs / dangling cost rows), and reaps orphan remote `shepherd/docs-update-*`
 * branches with no PR, working even when the herdr daemon also restarted (it parses `git worktree
 * list`).
 */
function computeDocAgentOutcome(
  result: { url: string | null; hadStagedChanges: boolean; prettierFailed: boolean },
  act: boolean,
): DocAgentOutcome {
  if (result.prettierFailed) return "error";
  if (result.url !== null) return "pr";
  if (result.hadStagedChanges && !act) return "observe";
  return "nochange";
}

export class DocAgentService {
  private inflight = new Map<string, InFlight>();
  private starting = new Set<string>();
  private git: (cwd: string, args: string[]) => Promise<string>;
  private prettier: (args: { cwd: string; configPath: string; files: string[] }) => Promise<void>;
  private now: () => number;
  private timeoutMs: number;
  private nightlyHour: number;
  private dayKey: (now: number) => string;
  private fileExists: (p: string) => boolean;
  private readSentinel: (worktreePath: string) => string | null;
  private buildPrompt: (base: string, ctx?: RetargetPromptCtx) => string;
  private act: boolean;
  private readUsage: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;
  private idleThresholdMs: number;
  private writeMarkerFn: (path: string, contents: string) => void;
  private readMarkerFn: (path: string) => string | null;
  /** Per-session settled-idle debounce for the re-target sweep (mirrors RecapService.debounce). */
  private readyDebounce = new Map<string, { stamp: number; fired: boolean }>();

  constructor(private deps: DocAgentDeps) {
    this.git = deps.git ?? defaultGit;
    this.prettier = deps.prettier ?? defaultPrettierWrite;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 20 * 60 * 1000;
    this.nightlyHour = deps.nightlyHour ?? 3;
    this.dayKey = deps.dayKey ?? defaultDayKey;
    this.fileExists = deps.fileExists ?? existsSync;
    this.readSentinel = deps.readSentinel ?? defaultReadSentinel;
    this.buildPrompt = deps.buildPrompt ?? ((base, ctx) => docAgentPrompt(base, ctx));
    this.act = deps.act ?? false;
    this.readUsage = deps.readUsage ?? readSessionUsage;
    this.idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.writeMarkerFn = deps.writeMarker ?? ((p, c) => writeFileSync(p, c, "utf8"));
    this.readMarkerFn = deps.readMarker ?? defaultReadMarker;
  }

  /** Serialize + write the re-target marker JSON (best-effort caller catches). */
  private writeMarker(
    path: string,
    data: { prNumber: number; headBranch: string; base: string },
  ): void {
    this.writeMarkerFn(path, JSON.stringify(data));
  }

  /** Start a doc-agent run for `repoPath` (manual trigger). At most one per repo at a time. */
  async consider(repoPath: string): Promise<DocAgentResult> {
    if (this.inflight.has(repoPath) || this.starting.has(repoPath)) {
      return { status: "skipped", reason: "doc agent already running for this repo" };
    }
    this.starting.add(repoPath);
    try {
      return await this.begin(repoPath);
    } finally {
      this.starting.delete(repoPath);
    }
  }

  /** Whether a doc-agent run is currently active (inflight or starting) for the given repo. */
  isRunning(repoPath: string): boolean {
    return this.inflight.has(repoPath) || this.starting.has(repoPath);
  }

  /**
   * Merge-triggered consideration (issue #904). Called when a managed session's PR merges. Only a
   * merge INTO the repo's default branch is considered — `baseBranch` (the session's PR target) must
   * equal `forge.defaultBranch()`; a feat/config PR merging into a non-default (epic/stacked) base
   * would spawn a near-no-op run grounded on the default tip, and those changes reach the default
   * branch at epic-landing time (caught by the nightly sweep) anyway.
   *
   * Gated on a PER-PR persisted `merged-seen` key (NOT the sha-gate): the merged `session:git` event
   * fires ONCE (the open→merged transition; `gitStateChanged` re-emits only on
   * state/checks/headSha/mergeable/review/handoff moves) and this method does NO fetch, so the local
   * `origin/<base>` is still the pre-merge sha at that instant — a sha-gate would wrongly skip with no
   * re-emit to retry. The per-PR key is freshness-independent: it fires immediately (consider() →
   * begin() fetches via ensureBaseRef so the agent grounds on the merged commits) and is
   * restart-idempotent (the 3s boot warm-tick replays the merged event, but the key is already set).
   */
  async onMergedPr(
    repoPath: string,
    prNumber: number | undefined,
    prTitle: string | undefined,
    baseBranch: string,
  ): Promise<DocAgentResult> {
    if (prNumber == null) return { status: "skipped", reason: "merged event without a PR number" };
    if (!isDocRelevantMerge(prTitle))
      return { status: "skipped", reason: "merge subject is not doc-relevant (feat/config)" };
    // Default-branch gate (cheap forge call, reached only for doc-relevant subjects). On a resolve
    // failure, skip — better a missed fast-path (nightly catches it) than a wrong-tip spawn.
    const forge = this.deps.resolveForge(repoPath);
    let def: string;
    try {
      def = forge ? await forge.defaultBranch() : "";
    } catch {
      return { status: "skipped", reason: "could not resolve default branch" };
    }
    if (!forge || baseBranch !== def)
      return { status: "skipped", reason: "merge target is not the default branch" };
    // Re-target ownership (issue #956): a re-target run claims this PR's docs at its START (it sets
    // prSyncedKey before spawning). If that key is set the doc commit is already (or about to be) on
    // this PR's own branch — DEFER, and crucially do NOT consume the per-PR mergedSeenKey below, so
    // the merge fast-path stays available should the re-target run later fall through to a fresh PR.
    if (this.deps.store.getSetting(prSyncedKey(repoPath, prNumber)) != null)
      return { status: "skipped", reason: "re-target already owns this PR's docs" };
    const key = mergedSeenKey(repoPath, prNumber);
    if (this.deps.store.getSetting(key) != null)
      return { status: "skipped", reason: "merge already handled" };
    this.deps.store.setSetting(key, "1");
    return this.consider(repoPath);
  }

  /**
   * Nightly cadence sweep (issue #904). Called on the 15s tick (flag-gated in index.ts). For each
   * doc-tree repo, at most once per local day (the `nightly-day` marker), freshens `origin/<base>`
   * and spawns a run ONLY when the default branch advanced since the last run (the `last-sha` gate) —
   * so quiet days cost a fetch but no agent spawn.
   */
  async sweepNightly(): Promise<void> {
    if (new Date(this.now()).getHours() < this.nightlyHour) return;
    const today = this.dayKey(this.now());
    for (const repo of this.deps.repos()) {
      if (!this.fileExists(join(repo, DOC_TREE_MARKER))) continue;
      if (this.deps.store.getSetting(nightlyDayKey(repo)) === today) continue;
      // Stamp "evaluated today" BEFORE the freshen/compare so any outcome (skip, fire, fetch failure)
      // counts as today's evaluation and the bounded fetch runs at most once/day/repo.
      this.deps.store.setSetting(nightlyDayKey(repo), today);
      try {
        await this.considerNightly(repo);
      } catch (err) {
        console.warn(`[doc-agent] nightly sweep failed for ${repo}:`, err);
      }
    }
  }

  /** Per-repo nightly decision: freshen origin/<base>, sha-gate, spawn on change. */
  private async considerNightly(repo: string): Promise<void> {
    const forge = this.deps.resolveForge(repo);
    if (!forge || forge.isLightweight) return; // no PR surface; guardRepo would skip anyway
    let base: string;
    try {
      base = await forge.defaultBranch();
    } catch {
      return;
    }
    // REQUIRED freshen: PrPoller polls PR state via the gh API and never `git fetch`s, and nothing
    // else periodically fetches managed repos' base refs — so without this the local origin/<base>
    // only advances when the doc agent itself last ran, and a quiet repo (or one whose last merge was
    // non-conventional) would skip indefinitely. ensureBaseRef is timeout-bounded and never throws.
    await this.deps.worktree.ensureBaseRef(repo, base);
    const sha = await this.originSha(repo, base);
    if (sha === null) {
      // fetch failed AND the remote ref was never local (offline) — skip today, retry tomorrow.
      console.warn(
        `[doc-agent] nightly: cannot resolve origin/${base} for ${repo}; skipping today`,
      );
      return;
    }
    if (sha === this.deps.store.getSetting(lastShaKey(repo))) return; // no new commits → no spawn
    await this.consider(repo);
  }

  /** Stamp `last-sha` = `refs/remotes/origin/<base>` (the nightly gate's ref). Best-effort. */
  private async stampLastSha(repoPath: string, base: string): Promise<void> {
    const sha = await this.originSha(repoPath, base);
    if (sha !== null) this.deps.store.setSetting(lastShaKey(repoPath), sha);
  }

  /** `refs/remotes/origin/<base>` sha, or null when the ref isn't locally present. */
  private async originSha(repoPath: string, base: string): Promise<string | null> {
    try {
      const out = await this.git(repoPath, ["rev-parse", `refs/remotes/origin/${base}`]);
      const sha = out.trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  /**
   * Pre-merge re-target sweep (issue #956 Option B). Called on the tick (flag-gated in index.ts).
   * For each managed session whose code PR is OPEN + green + doc-relevant and has been settled-idle
   * long enough, spawn a re-target run that pushes the doc commit onto THAT PR's own head branch —
   * one PR carries both code and docs, instead of a second `shepherd/docs-update-*` PR after merge.
   *
   * Modeled on {@link import("./recap").RecapService.sweep}/considerSession: a per-session
   * settled-idle debounce ({@link readyDebounce}) ensures we never re-target a still-churning PR, and
   * the per-repo `inflight`/`starting` lock serializes against the fresh path (one doc run per repo).
   */
  async sweepReadyPrs(): Promise<void> {
    const now = this.now();
    for (const s of this.deps.store.list()) {
      try {
        await this.considerReady(s, now);
      } catch (err) {
        console.warn(`[doc-agent] re-target sweep failed for ${s.id}:`, err);
      }
    }
  }

  /** Per-session re-target decision: gate → settled-idle debounce → per-repo lock → beginRetarget. */
  private async considerReady(s: Session, now: number): Promise<void> {
    if (s.status === "archived") return;
    // Not settled (still working) → reset the debounce so a later settle re-evaluates cleanly.
    if (s.status === "running" || s.status === "blocked") {
      this.readyDebounce.delete(s.id);
      return;
    }
    // Eligibility gates (cheap, no spawn). A miss leaves the debounce untouched so it can fire once
    // the session becomes eligible without restarting the idle clock.
    const git = this.retargetCandidate(s);
    if (!git) return;

    // Settled-idle debounce (mirrors RecapService.considerSession).
    const e = this.readyDebounce.get(s.id);
    if (!e) {
      this.readyDebounce.set(s.id, { stamp: now, fired: false });
      return; // first settle tick — start the idle clock
    }
    if (e.fired) return; // already fired this idle episode
    if (!isSettledIdle(s.status, now - e.stamp, this.idleThresholdMs)) return;

    // Per-repo lock: don't fire while a doc run is in flight/starting for this repo. Do NOT set
    // `fired` — retry next tick once the lock frees (a missed episode would otherwise never fire).
    if (this.inflight.has(s.repoPath) || this.starting.has(s.repoPath)) return;

    e.fired = true;
    await this.beginRetarget(s, git);
  }

  /**
   * Cheap, no-spawn eligibility gate for the re-target sweep: returns the validated cached
   * {@link GitState} when `s` is a re-target candidate (has a branch, lives in a doc-tree repo, and
   * its cached PR state is open + green + has a head sha + number + a doc-relevant title + is not
   * already claimed by a prior re-target), else null. A null leaves the caller's idle debounce
   * untouched so it can fire once the session becomes eligible without restarting the idle clock.
   */
  private retargetCandidate(s: Session): GitState | null {
    if (!s.branch) return null;
    if (!this.fileExists(join(s.repoPath, DOC_TREE_MARKER))) return null;
    const git = this.deps.gitState?.(s.id);
    if (!git || git.state !== "open" || git.checks !== "success") return null;
    if (!git.headSha || git.number == null) return null;
    if (!isDocRelevantMerge(git.title)) return null;
    if (this.deps.store.getSetting(prSyncedKey(s.repoPath, git.number)) != null) return null;
    return git;
  }

  /**
   * Start a re-target run for `session` against its open code PR (issue #956). Mirrors {@link begin}
   * but checks the worktree out at the PR's HEAD sha and, on finalize, pushes the doc commit onto the
   * PR's own head branch instead of opening a standalone PR.
   *
   * Sets the {@link prSyncedKey} ownership claim BEFORE the spawn so {@link onMergedPr} defers even if
   * the code PR merges mid-run. Re-checks the per-repo lock (the sweep checked it without holding it).
   * Does NOT call stampLastSha — that is the nightly gate's marker, irrelevant to a PR-targeted run.
   */
  private async beginRetarget(session: Session, git: GitState): Promise<DocAgentResult> {
    const repoPath = session.repoPath;
    if (this.inflight.has(repoPath) || this.starting.has(repoPath))
      return { status: "skipped", reason: "doc agent already running for this repo" };
    this.starting.add(repoPath);
    try {
      const guard = this.guardRepo(repoPath);
      if (!guard.ok) return guard.result;
      const forge = guard.forge;
      const prNumber = git.number!;
      const headSha = git.headSha!;

      let base: string;
      try {
        base = await forge.defaultBranch();
      } catch {
        return { status: "error", reason: "could not resolve default branch" };
      }

      // Claim ownership BEFORE the spawn: if the code PR merges mid-run, onMergedPr now defers and the
      // re-target run's own finalize fallback opens the single fresh PR (no double PR).
      this.deps.store.setSetting(prSyncedKey(repoPath, prNumber), "1");

      const promptCtx: RetargetPromptCtx = { prNumber, prTitle: git.title ?? "" };
      const launched = await this.launchRun(
        repoPath,
        headSha,
        base,
        {
          mode: "retarget",
          prNumber,
          headBranch: session.branch!,
          ownerWorktreePath: session.worktreePath,
          headSha,
        },
        promptCtx,
        // Drop the restart marker so a boot reconcile re-adopts this as a re-target run. Runs after
        // worktree creation, before the spawn — same position as the original inline write.
        (worktreePath) => {
          try {
            this.writeMarker(join(worktreePath, RETARGET_MARKER), {
              prNumber,
              headBranch: session.branch!,
              base,
            });
          } catch (err) {
            console.warn(`[doc-agent] writing re-target marker failed for ${repoPath}:`, err);
          }
        },
      );
      if (!launched.ok) return launched.result;
      return { status: "started" };
    } finally {
      this.starting.delete(repoPath);
    }
  }

  /**
   * Shared run-launch mechanics for {@link begin} (fresh) and {@link beginRetarget} (retarget):
   * create a disposable `shepherd/docs-update-<8hex>` worktree off `baseRef`, optionally run
   * `afterCreate` (the re-target marker write — between create and spawn), spawn the scoped agent,
   * register it in `inflight` (merging `extra` for mode + the retarget-only fields), and persist the
   * durable cost row. Returns `{ ok: true }` on success or `{ ok: false, result }` carrying the
   * skip/error result the caller returns. The worktree is removed on any post-create failure.
   *
   * `baseRef` is the worktree start point — `resolved.baseRef` (fresh) or the PR head sha (retarget).
   * `base` is the default-branch name stored on the run + threaded into the prompt. `promptCtx`
   * (retarget only) grounds the agent on the open PR's diff. Callers keep their own pre/post steps
   * (begin's stampLastSha, beginRetarget's prSyncedKey claim) outside this helper.
   */
  private async launchRun(
    repoPath: string,
    baseRef: string,
    base: string,
    extra: Partial<InFlight>,
    promptCtx?: RetargetPromptCtx,
    afterCreate?: (worktreePath: string) => void,
  ): Promise<{ ok: true } | { ok: false; result: DocAgentResult }> {
    const id8 = randomUUID().slice(0, 8);
    const wtName = DOC_BRANCH_PREFIX + id8;
    let wt;
    try {
      wt = this.deps.worktree.create(repoPath, baseRef, wtName);
    } catch (err) {
      console.warn(`[doc-agent] worktree creation failed for ${repoPath}:`, err);
      return { ok: false, result: { status: "error", reason: "worktree creation failed" } };
    }
    if (!wt.isolated || !wt.branch) {
      if (wt.worktreePath !== repoPath) this.deps.worktree.remove(wt.worktreePath);
      return { ok: false, result: { status: "error", reason: "worktree creation failed" } };
    }

    afterCreate?.(wt.worktreePath);

    const spawned = await this.spawnAgent(
      repoPath,
      wt.worktreePath,
      DOC_AGENT_LABEL + id8,
      base,
      promptCtx,
    );
    if (spawned === "aborted") {
      this.deps.worktree.remove(wt.worktreePath);
      return { ok: false, result: { status: "skipped", reason: "plugin aborted spawn" } };
    }
    if (!spawned) {
      this.deps.worktree.remove(wt.worktreePath);
      return { ok: false, result: { status: "error", reason: "spawn failed" } };
    }
    const { terminalId, spawnSessionId, reviewerProvider, model, reviewerEffort } = spawned;
    const startedAt = this.now();
    this.inflight.set(repoPath, {
      repoPath,
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      base,
      terminalId,
      agentName: DOC_AGENT_LABEL + id8,
      spawnSessionId,
      startedAt,
      mode: "fresh",
      ...extra,
    });
    // AFTER inflight.set (the ordering mirrors plan-gate's documented invariant): persist a durable
    // reviewer_spawns row so this run's token burn is attributable even if it crashes before finalize.
    // Session-less — repoPath is the correlation key (herd-digest uses "" for its herd-wide spawn).
    this.deps.store.recordReviewerSpawn({
      reviewerSessionId: spawnSessionId,
      taskSessionId: repoPath,
      kind: "doc_agent",
      worktreePath: wt.worktreePath,
      reviewerProvider,
      model,
      reviewerEffort,
      spawnedAt: startedAt,
    });
    return { ok: true };
  }

  private async begin(repoPath: string): Promise<DocAgentResult> {
    const guard = this.guardRepo(repoPath);
    if (!guard.ok) return guard.result;
    const forge = guard.forge;

    let base: string;
    try {
      base = await forge.defaultBranch();
    } catch {
      return { status: "error", reason: "could not resolve default branch" };
    }
    // Freshen the base ref off origin (best-effort, never throws; the fetch is timeout-bounded
    // inside ensureBaseRef). A non-diverged branch resolves to the upstream sha so the worktree
    // starts fresh; offline degrades to the local base.
    const resolved = await this.deps.worktree.ensureBaseRef(repoPath, base);

    // forget() can't race a manual trigger here, but a second trigger could have landed during the
    // awaits above — the `starting` claim (held until this returns) prevents that double-spawn.
    const launched = await this.launchRun(repoPath, resolved.baseRef, base, { mode: "fresh" });
    if (!launched.ok) return launched.result;
    // Stamp the cadence marker from the SAME ref the nightly gate reads (`refs/remotes/origin/<base>`,
    // freshened by ensureBaseRef above) — NOT resolved.baseRef, which falls back to the branch
    // name/local sha in the diverged/no-upstream case and could never reach equality with the gate's
    // origin/<base> read, re-firing nightly on quiet days. Best-effort: a repo without the remote ref
    // simply isn't sha-gated by nightly (it has its own rev-parse-failure skip).
    await this.stampLastSha(repoPath, base);
    return { status: "started" };
  }

  /** Pre-spawn fail-closed guards (api-key, forge, local-forge, doc-tree layout). Returns the
   *  resolved forge on success, else the skip/error result to return from begin(). */
  private guardRepo(
    repoPath: string,
  ): { ok: true; forge: GitForge } | { ok: false; result: DocAgentResult } {
    if (apiKeyFailClosed(this.deps.env?.().provider ?? "claude")) {
      console.warn(
        "[doc-agent] api-key mode enabled but no API key configured — skipping (fail closed, not billing subscription)",
      );
      return {
        ok: false,
        result: { status: "skipped", reason: "api-key mode without a configured key" },
      };
    }
    const forge = this.deps.resolveForge(repoPath);
    if (!forge)
      return { ok: false, result: { status: "error", reason: "no forge configured for repo" } };
    if (forge.isLightweight) {
      return {
        ok: false,
        result: { status: "skipped", reason: "lightweight repo mode has no PR surface" },
      };
    }
    if (!this.fileExists(join(repoPath, DOC_TREE_MARKER))) {
      return { ok: false, result: { status: "skipped", reason: "repo has no docs-site doc tree" } };
    }
    return { ok: true, forge };
  }

  /** Build the scoped argv + membrane and spawn the agent via herdr. Returns the terminalId +
   *  the agent's forced --session-id (the reviewer_spawns PK), or null on a spawn failure (logged),
   *  or "aborted" when a plugin onSpawn hook aborts (distinct from a spawn failure). */
  private async spawnAgent(
    repoPath: string,
    worktreePath: string,
    agentName: string,
    base: string,
    promptCtx?: RetargetPromptCtx,
  ): Promise<
    | {
        terminalId: string;
        spawnSessionId: string;
        reviewerProvider: RoleEnvironment["provider"];
        model: string | null;
        reviewerEffort: string | null;
      }
    | null
    | "aborted"
  > {
    const env = this.deps.env?.() ?? { provider: "claude" as const, model: null };
    const { argv, sessionId } = buildTransientAgentArgv("doc", {
      provider: env.provider,
      model: env.model,
      effort: env.effort,
      prompt: this.buildPrompt(base, promptCtx),
    });
    // Fire plugin onSpawn hooks (issue #1205) + bind any patched env THROUGH the membrane.
    // Session-less doc agent → no parentSessionId. abortSpawn → "aborted" so launchRun can reap
    // the worktree and skip cleanly (distinct from a spawn failure).
    const aux = await resolveAuxSpawn({
      argv,
      worktreePath,
      repoPath,
      worktree: this.deps.worktree,
      seams: this.deps,
      descriptor: {
        sessionId,
        kind: "doc",
        model: env.model,
      },
    });
    if ("aborted" in aux) {
      console.warn(`[doc-agent] onSpawn aborted for ${repoPath}: ${aux.aborted.reason}`);
      return "aborted";
    }
    try {
      const terminalId = (
        await this.deps.herdr.start(agentName, worktreePath, aux.wrapped, aux.spawnEnv)
      ).terminalId;
      return {
        terminalId,
        spawnSessionId: sessionId,
        reviewerProvider: env.provider,
        model: env.model,
        reviewerEffort: env.effort ?? null,
      };
    } catch (err) {
      if (err instanceof HerdrUnavailableError) {
        console.warn(`[doc-agent] herdr unavailable for ${repoPath}:`, err);
      } else {
        console.warn(`[doc-agent] spawn failed for ${repoPath}:`, err);
      }
      return null;
    }
  }

  /** Finalize any run whose sentinel is ready or that timed out. */
  async tick(): Promise<void> {
    for (const f of [...this.inflight.values()]) {
      if (f.finalizing) continue;
      const sentinel = this.readSentinel(f.worktreePath);
      const timedOut = this.now() - f.startedAt > this.timeoutMs;
      if (sentinel === null && !timedOut) continue;
      f.finalizing = true;
      try {
        await this.finalize(f, sentinel);
      } catch (err) {
        console.warn(`[doc-agent] finalize failed for ${f.repoPath}:`, err);
      }
      this.inflight.delete(f.repoPath);
    }
  }

  /**
   * Stage the in-scope doc edits and return the staged-file diff (`git diff --cached --name-only`,
   * trimmed; "" when nothing staged or no in-scope file exists). STRUCTURAL off-limits boundary:
   * stages ONLY {@link IN_SCOPE_PATHS} ∩ files that exist, so an agent edit to the Astro app,
   * reference/cli/*, or a brand-new file is never staged → can't reach the PR.
   *
   * Before staging it formats the `docs/`-prefixed in-scope files (abs paths) with the server's
   * pinned prettier — then verifies (`--check`) — so the PR passes CI's `prettier --check .` gate;
   * both run with ignores disabled so the worktree's `.shepherd-worktrees/` location can't make
   * prettier silently skip the file (see {@link defaultPrettierWrite}). docs-site/** is
   * Astro/Starlight-governed and must NEVER be passed to root prettier. Prettier is fail-closed: a
   * format OR verify failure throws {@link PrettierFormatError}, which finalize catches to abort the
   * run (no commit/push/PR) and record an `error` outcome. A skipped doc update beats a red PR.
   */
  private async stageInScope(f: InFlight): Promise<string> {
    const inScope = IN_SCOPE_PATHS.filter((p) => this.fileExists(join(f.worktreePath, p)));
    if (inScope.length === 0) return "";
    const absDocs = inScope
      .filter((p) => p.startsWith("docs/"))
      .map((p) => join(f.worktreePath, p));
    if (absDocs.length > 0) {
      try {
        await this.prettier({
          cwd: SERVER_INSTALL_ROOT,
          configPath: join(f.worktreePath, ".prettierrc"),
          files: absDocs,
        });
      } catch (err) {
        // Fail-closed: never commit unformatted docs. Abort the run (finalize catches this,
        // records an `error` outcome, and cleans up); a skipped doc update beats a red PR.
        throw new PrettierFormatError(f.repoPath, absDocs, { cause: err });
      }
    }
    await this.git(f.worktreePath, ["add", "--", ...inScope]);
    return (await this.git(f.worktreePath, ["diff", "--cached", "--name-only"])).trim();
  }

  /** Stage the in-scope docs and publish them. Returns the run's url (null if nothing
   *  published / observe phase), whether anything was staged, and whether prettier aborted
   *  the run (fail-closed). A non-PrettierFormatError propagates (handled by tick()). */
  private async stageAndPublish(
    f: InFlight,
    sentinel: string | null,
  ): Promise<{ url: string | null; hadStagedChanges: boolean; prettierFailed: boolean }> {
    const forge = this.deps.resolveForge(f.repoPath);
    if (!forge) return { url: null, hadStagedChanges: false, prettierFailed: false };
    let stagedOut: string;
    try {
      stagedOut = await this.stageInScope(f);
    } catch (err) {
      if (err instanceof PrettierFormatError) {
        console.error(
          `[doc-agent] aborting run — prettier failed for ${f.repoPath}; refusing to commit unformatted docs (fail-closed): ${err.files.join(", ")}`,
          err.cause ?? err,
        );
        return { url: null, hadStagedChanges: false, prettierFailed: true };
      }
      throw err; // unexpected — keep existing propagate-to-tick() behaviour
    }
    if (stagedOut.length === 0)
      return { url: null, hadStagedChanges: false, prettierFailed: false };
    const url =
      f.mode === "retarget"
        ? await this.publishRetarget(f, sentinel, forge, stagedOut)
        : await this.publishStaged(f, sentinel, forge, stagedOut);
    return { url, hadStagedChanges: true, prettierFailed: false };
  }

  private async finalize(f: InFlight, sentinel: string | null): Promise<void> {
    let result:
      { url: string | null; hadStagedChanges: boolean; prettierFailed: boolean } | undefined;
    try {
      result = await this.stageAndPublish(f, sentinel);
    } finally {
      // Complete the durable cost row with real usage (best-effort) on EVERY finalize path (observe
      // and act) BEFORE the worktree is removed — mirrors herd-digest.ts / review.ts.
      // completeReviewerSpawn no-ops on an unknown id, so an empty/missing id is safe.
      const usage = await this.readUsage(f.worktreePath, f.spawnSessionId).catch(() => null);
      this.deps.store.completeReviewerSpawn(f.spawnSessionId, usage ?? ZEROED_USAGE, this.now());
      // Cleanup mirrors Promoter.cleanup: stop the agent (closes its tab), remove the worktree, and
      // force-delete the local branch (the pushed remote branch backs any opened PR).
      await this.deps.herdr.stop(f.terminalId);
      this.deps.worktree.remove(f.worktreePath);
      try {
        await this.git(f.repoPath, ["branch", "-D", f.branch]);
      } catch {
        /* best-effort: a never-committed branch may already be gone */
      }
    }
    // Compute outcome from locals set above (after try/finally so cleanup always runs first).
    // result is always defined here — an error in stageAndPublish propagates out of finalize.
    const r = result!;
    const outcome: DocAgentOutcome = computeDocAgentOutcome(r, this.act);
    // Record the run in the durable per-repo history (additive alongside the cost-ledger spawn row).
    const run: DocAgentRun = { at: this.now(), url: r.url, outcome };
    this.deps.store.recordDocAgentRun(f.repoPath, run);
    this.deps.onChange?.({ repoPath: f.repoPath, url: r.url, outcome });
  }

  /**
   * Phase-gated publish of the staged in-scope doc changes. Phase-0 OBSERVE (`!act`) logs exactly
   * what it WOULD open and returns null (no commit/push/openPr) — onChange then fires the same
   * `{repoPath, url:null}` shape as the already-current path. Phase-1 act commits `--no-verify`
   * (deliberately DIVERGES from promote.ts, which commits WITH hooks: a server-side docs-only
   * commit must not run the repo's pre-commit hooks on unrelated state — the change is grounded +
   * human-reviewed via the PR), pushes, opens the PR, and returns its url (null on no net diff).
   */
  private async publishStaged(
    f: InFlight,
    sentinel: string | null,
    forge: GitForge,
    stagedOut: string,
  ): Promise<string | null> {
    const existing = await this.findOpenDocPr(forge, f.branch);
    const intent = existing
      ? `would roll up docs onto existing PR #${existing.number} (${existing.headBranch})`
      : `would open a doc-update PR on ${f.branch}`;
    if (!(await this.observeOrCommit(f, stagedOut, intent))) return null;
    return existing
      ? this.rollupOnto(f, existing, sentinel, forge)
      : this.openFreshPr(f, sentinel, forge);
  }

  /**
   * Shared OBSERVE-vs-commit gate for both publish paths. Phase-0 OBSERVE (`!act`) logs `intent` (the
   * per-mode "would …" phrase) with the repo path + the staged file count/list appended, and returns
   * false (the caller then returns null — no commit/push/PR). Phase-1 act commits `--no-verify`
   * (deliberately DIVERGES from promote.ts, which commits WITH hooks: a server-side docs-only commit
   * must not run the repo's pre-commit hooks on unrelated state — the change is grounded +
   * human-reviewed via the PR) and returns true so the caller proceeds to push/open the PR.
   */
  private async observeOrCommit(f: InFlight, stagedOut: string, intent: string): Promise<boolean> {
    if (!this.act) {
      const staged = stagedOut.split("\n");
      console.warn(
        `[doc-agent] OBSERVE: ${f.repoPath} ${intent} (${staged.length} files): ${staged.join(", ")}`,
      );
      return false;
    }
    await this.git(f.worktreePath, ["commit", "--no-verify", "-m", COMMIT_MSG]);
    return true;
  }

  /**
   * Find the single open standalone docs PR to roll a fresh run onto, or null when none exists.
   * Keeps open PRs whose head branch is a `shepherd/docs-update-*` branch (BRANCH_RE-valid, so the
   * branch name can't smuggle a flag into the force-push refspec) other than our own in-flight
   * branch, and returns the LOWEST-numbered one (a stable survivor so repeated runs converge on the
   * same PR). On a listPullRequests failure it returns null (fail-open: the caller opens a fresh PR)
   * and warns — a transient list failure could momentarily allow a duplicate, which is manually
   * recoverable; failing closed would silently skip a run.
   */
  private async findOpenDocPr(
    forge: GitForge,
    excludeBranch: string,
  ): Promise<{ number: number; headBranch: string; url: string | null } | null> {
    let prs;
    try {
      prs = await forge.listPullRequests();
    } catch (err) {
      console.warn(`[doc-agent] roll-up: listPullRequests failed — opening fresh:`, err);
      return null;
    }
    const prefix = `shepherd/${DOC_BRANCH_PREFIX}`;
    const matches = prs.filter(
      (p) =>
        !!p.headRefName &&
        p.headRefName.startsWith(prefix) &&
        p.headRefName !== excludeBranch &&
        BRANCH_RE.test(p.headRefName),
    );
    if (matches.length === 0) return null;
    const chosen = matches.reduce((a, b) => (b.number < a.number ? b : a));
    return { number: chosen.number, headBranch: chosen.headRefName!, url: chosen.url ?? null };
  }

  /**
   * Roll a fresh doc-update commit onto an EXISTING open standalone docs PR (issue: never >1 open
   * docs PR). Force-pushes our commit onto that PR's own head branch (the branch is server-owned and
   * ephemeral — only the doc agent ever pushes `shepherd/docs-update-*` — so a force-push is safe and
   * keeps the single PR a current "docs vs base" diff), then best-effort refreshes the PR body so it
   * matches the new diff (title is the constant COMMIT_MSG, so it never goes stale). On a push
   * failure it defers (returns null) rather than falling back to openFreshPr — opening a fresh PR
   * would create the very duplicate this prevents. Returns the existing PR's url.
   */
  private async rollupOnto(
    f: InFlight,
    existing: { number: number; headBranch: string; url: string | null },
    sentinel: string | null,
    forge: GitForge,
  ): Promise<string | null> {
    try {
      await this.git(f.worktreePath, [
        "push",
        "--force",
        "origin",
        `HEAD:refs/heads/${existing.headBranch}`,
      ]);
    } catch (err) {
      console.warn(
        `[doc-agent] roll-up: force-push onto ${existing.headBranch} failed for ${f.repoPath} — deferring:`,
        err,
      );
      return null;
    }
    // Refresh the PR body so it matches the force-pushed diff (best-effort).
    if (forge.editPr) {
      try {
        await forge.editPr(existing.number, { title: COMMIT_MSG, body: docPrBody(sentinel) });
      } catch (err) {
        console.warn(
          `[doc-agent] roll-up: editPr(#${existing.number}) failed for ${f.repoPath} — PR body may be stale:`,
          err,
        );
      }
    } else {
      console.warn(
        `[doc-agent] roll-up: forge has no editPr — PR #${existing.number} body may be stale`,
      );
    }
    return existing.url;
  }

  /** Push the local `shepherd/docs-update-*` branch and open a standalone doc-update PR. Shared by
   *  the fresh path and the re-target merged-first fallback. Assumes the commit is already made.
   *  Returns the PR url (null on no net diff vs base). */
  private async openFreshPr(
    f: InFlight,
    sentinel: string | null,
    forge: GitForge,
  ): Promise<string | null> {
    await this.git(f.worktreePath, ["push", "-u", "origin", f.branch]);
    try {
      const status = await forge.openPr({
        head: f.branch,
        base: f.base,
        title: COMMIT_MSG,
        body: docPrBody(sentinel),
      });
      return status.url ?? null;
    } catch (err) {
      // No net diff vs base → nothing to land; not an error.
      if (!(err instanceof EmptyDiffError)) throw err;
      return null;
    }
  }

  /**
   * Re-target publish (issue #956 Option B). Commits the staged doc changes, then — IF the code PR is
   * still open — pushes the commit onto that PR's own head branch (no new PR opened) and best-effort
   * fast-forwards the owner session's local branch. If the PR is no longer open (merged/closed
   * mid-run), falls through to {@link openFreshPr} so the doc change still lands as exactly ONE
   * standalone PR. OBSERVE (`!act`) logs what it would push and returns null (no commit/push/PR).
   */
  private async publishRetarget(
    f: InFlight,
    sentinel: string | null,
    forge: GitForge,
    stagedOut: string,
  ): Promise<string | null> {
    if (
      !(await this.observeOrCommit(
        f,
        stagedOut,
        `would push docs onto PR #${f.prNumber} branch ${f.headBranch}`,
      ))
    )
      return null;

    // Re-check the PR right before the push: it may have merged/closed since the run started.
    let status;
    try {
      status = await forge.prStatus(f.headBranch!);
    } catch (err) {
      console.warn(
        `[doc-agent] re-target: prStatus(${f.headBranch}) failed for ${f.repoPath}:`,
        err,
      );
      return null; // defer to the nightly path rather than guess
    }
    if (status.state !== "open") {
      // PR merged/closed mid-run → land the docs as exactly ONE standalone PR: roll up onto an
      // existing open docs PR if present (never a 2nd), else open fresh. (key already set → onMergedPr defers.)
      const existing = await this.findOpenDocPr(forge, f.branch);
      return existing
        ? this.rollupOnto(f, existing, sentinel, forge)
        : this.openFreshPr(f, sentinel, forge);
    }

    // Push the doc commit onto the code PR's OWN head branch (never force, explicit refspec).
    try {
      await this.git(f.worktreePath, ["push", "origin", `HEAD:refs/heads/${f.headBranch}`]);
    } catch (err) {
      // Non-ff or other push failure → defer to the nightly fresh path; do NOT throw or force.
      console.warn(
        `[doc-agent] re-target: pushing onto ${f.headBranch} failed for ${f.repoPath} — deferring to nightly:`,
        err,
      );
      return null;
    }
    // Best-effort: fast-forward the owner session's local branch so it isn't left behind origin.
    await this.ffOwnerBranch(f);
    return status.url ?? null;
  }

  /**
   * Best-effort fast-forward of the originating session's local branch to the just-pushed head
   * (issue #956). NEVER throws, NEVER force-pushes, NEVER rewrites the owner's branch: it fetches the
   * code PR's branch and `merge --ff-only`s, but only when the owner worktree is clean AND still at
   * the pre-push head (so an operator who resumed work mid-run is never clobbered).
   */
  private async ffOwnerBranch(f: InFlight): Promise<void> {
    if (!f.ownerWorktreePath || !f.headBranch || !f.headSha) return;
    try {
      const dirty = (await this.git(f.ownerWorktreePath, ["status", "--porcelain"])).trim();
      if (dirty.length > 0) return; // uncommitted work — never touch it
      const head = (await this.git(f.ownerWorktreePath, ["rev-parse", "HEAD"])).trim();
      if (head !== f.headSha) return; // owner moved on since we forked — leave it alone
      await this.git(f.ownerWorktreePath, ["fetch", "origin", f.headBranch]);
      await this.git(f.ownerWorktreePath, ["merge", "--ff-only", `origin/${f.headBranch}`]);
    } catch (err) {
      console.warn(
        `[doc-agent] re-target: owner-branch ff skipped for ${f.ownerWorktreePath}:`,
        err,
      );
    }
  }

  /** Drop a repo's in-flight tracking (e.g. on shutdown); does not touch the worktree. */
  forget(repoPath: string): void {
    this.inflight.delete(repoPath);
    this.starting.delete(repoPath);
  }

  /**
   * Free the per-session re-target debounce on archive (mirrors RecapService.onArchived).
   *
   * Without this the `readyDebounce` Map leaks entries for archived sessions — they never
   * re-enter the sweep's active-session list to be cleared (considerReady() early-returns on
   * `status === "archived"` before touching the map).
   *
   * Deliberately does NOT touch `inflight`/`starting` — a doc run is keyed by repoPath, not
   * sessionId, so archiving a session has no bearing on an in-flight run for its repo.
   */
  onArchived(sessionId: string): void {
    this.readyDebounce.delete(sessionId);
  }

  /**
   * Boot reconcile (issue #905). Unlike the reviewer's reapOrphans (which DISCARDS the worktree and
   * re-kicks a fresh run), the doc agent KEEPS a finished worktree and FINALIZES the work already
   * produced — the SENTINEL edits are the deliverable, so throwing them away on a restart that
   * happened to land right after the agent finished would waste a whole run.
   *
   * Per repo (skipping any already `inflight`/`starting`), for each surviving
   * `shepherd/docs-update-*` worktree it applies {@link reapOneWorktree}'s decision tree
   * (re-adopt / prune / keep-across-a-forge-blip), reaps orphan REMOTE branches with no PR
   * (the crash-between-push-and-openPr leak), and finally mops up dangling spawn rows + leftover
   * husk tabs. Works even when the herdr daemon ALSO restarted (it parses `git worktree list`).
   * Scoped strictly to the doc-agent namespace, so it never collides with the reviewer's `review *`
   * reaper or the tmpfs sweeper.
   *
   * The boot callsite is best-effort (not awaited): the per-repo `starting` claim is the load-bearing
   * double-spawn guard regardless, and a merged trigger lost during the brief reconcile window is
   * recovered by the nightly catch-all.
   */
  async reapOrphans(): Promise<void> {
    for (const repo of this.deps.repos()) {
      if (this.inflight.has(repo) || this.starting.has(repo)) continue; // never reap a live run
      this.starting.add(repo); // claim BEFORE any await so a concurrent consider() short-circuits
      let readopted = false;
      try {
        readopted = await this.reapRepoWorktrees(repo);
      } catch (err) {
        console.warn(`[doc-agent] reapOrphans: error reaping ${repo}:`, err);
      } finally {
        if (!readopted) this.starting.delete(repo); // re-adopt keeps the claim (handed to inflight)
      }
    }
    await this.sweepDanglingRows();
    this.closeHuskTabs();
  }

  /** Per repo: walk the doc-update worktrees applying the decision tree, then reap orphan remote
   *  branches. Returns true iff a worktree was RE-ADOPTED into `inflight` (so the caller keeps the
   *  `starting` claim, already handed to `inflight`). At most one re-adopt per repo. */
  private async reapRepoWorktrees(repo: string): Promise<boolean> {
    const orphanPrefix = `shepherd/${DOC_BRANCH_PREFIX}`;
    let entries: { path: string; branch: string }[];
    try {
      entries = await this.listWorktreeBranches(repo);
    } catch {
      return false;
    }
    const forge = this.deps.resolveForge(repo);
    let readopted = false;
    for (const { path, branch } of entries) {
      if (!branch.startsWith(orphanPrefix)) continue;
      if (readopted) {
        // begin() allows one in-flight run per repo, so any extra orphan worktree is prunable.
        await this.pruneWorktree(repo, path, branch);
        continue;
      }
      readopted = await this.reapOneWorktree(repo, path, branch, forge);
    }
    const protectedBranches = new Set<string>(readopted ? [this.inflight.get(repo)!.branch] : []);
    if (forge && !forge.isLightweight) {
      await this.reapOrphanRemoteBranches(repo, forge, protectedBranches);
    }
    return readopted;
  }

  /** Decision tree for ONE surviving doc-update worktree. Returns true iff it was re-adopted. */
  private async reapOneWorktree(
    repo: string,
    path: string,
    branch: string,
    forge: GitForge | null,
  ): Promise<boolean> {
    // No PR surface (no forge / lightweight repo) → nothing to finalize against → prune.
    if (!forge || forge.isLightweight) {
      await this.pruneWorktree(repo, path, branch);
      return false;
    }
    const sentinel = this.readSentinel(path);
    const liveTab = this.findLiveTab(path);
    let base: string;
    try {
      base = await forge.defaultBranch();
    } catch {
      // Transient forge failure (offline). Preserve anything worth finishing for a later boot;
      // otherwise prune. KEEP leaves the row + tab untouched so the next reachable boot retries.
      if (sentinel !== null || liveTab) return false;
      await this.pruneWorktree(repo, path, branch);
      return false;
    }
    if (sentinel === null && !liveTab) {
      // Agent died mid-edit (no completion signal, no live process) → nothing to salvage.
      await this.pruneWorktree(repo, path, branch);
      return false;
    }
    // sentinel present (finished) OR a live tab (still editing after a Shepherd-only restart) →
    // RE-ADOPT: hand the `starting` claim to `inflight`; the next tick() finalizes it (and completes
    // the row). Recover spawnedAt + the spawn session id from the uncompleted row when present.
    const row = this.uncompletedRowFor(path);
    // Restart-safety (issue #956): a re-target run dropped a marker; re-adopt it as such so the next
    // tick()→finalize routes to publishRetarget (which re-checks prStatus and either pushes onto the
    // open PR or falls through to a fresh PR). Absent/unparseable marker → fresh path (unchanged).
    const marker = this.readRetargetMarker(path);
    this.inflight.set(repo, {
      repoPath: repo,
      worktreePath: path,
      branch,
      base,
      terminalId: liveTab?.terminalId ?? "",
      agentName: liveTab?.name ?? "",
      startedAt: row?.spawnedAt ?? this.now(),
      spawnSessionId: row?.reviewerSessionId ?? "",
      mode: marker ? "retarget" : "fresh",
      ...(marker ? { prNumber: marker.prNumber, headBranch: marker.headBranch } : {}),
    });
    this.starting.delete(repo);
    return true;
  }

  /** Reap orphan REMOTE `shepherd/docs-update-*` branches that have NO PR at all (state "none") —
   *  the crash-between-push-and-openPr leak. open/merged/closed branches are left alone. */
  private async reapOrphanRemoteBranches(
    repo: string,
    forge: GitForge,
    protectedBranches: Set<string>,
  ): Promise<void> {
    let candidates: string[];
    try {
      candidates = await this.listRemoteDocBranches(repo, forge);
    } catch (err) {
      console.warn(`[doc-agent] reapOrphans: listing remote branches failed for ${repo}:`, err);
      return;
    }
    let checks = 0;
    for (const branch of candidates) {
      if (protectedBranches.has(branch) || !BRANCH_RE.test(branch)) continue;
      if (checks >= REMOTE_REAP_CAP) break; // bounded per sweep; the rest wait for the next boot
      checks++;
      let state: string;
      try {
        state = (await forge.prStatus(branch)).state;
      } catch {
        console.warn(`[doc-agent] reapOrphans: prStatus failed for ${branch}; keeping`);
        continue;
      }
      if (state !== "none") continue; // an open/merged/closed PR owns the branch — keep it
      try {
        await this.git(repo, ["push", "origin", "--delete", branch]);
      } catch {
        /* best-effort: the branch may already be gone */
      }
    }
  }

  /** Candidate remote `shepherd/docs-update-*` short-names. Prefer the authoritative forge view
   *  (GitHub matching-refs API, free of stale local refs); fall back to git, pruning stale
   *  remote-tracking refs FIRST so a deleted-on-origin branch can't permanently consume the cap. */
  private async listRemoteDocBranches(repo: string, forge: GitForge): Promise<string[]> {
    const prefix = `shepherd/${DOC_BRANCH_PREFIX}`;
    if (forge.listBranches) return forge.listBranches(prefix);
    try {
      await this.git(repo, ["remote", "prune", "origin"]);
    } catch {
      /* best-effort: a prune failure just leaves stale refs in the for-each-ref read */
    }
    // Pattern must end on a FULL path component: `git for-each-ref` matches a literal pattern only
    // completely or up to a slash, so a mid-component prefix (`…/shepherd/docs-update-`) matches
    // nothing. Use the full `…/shepherd/` component (as branch-pruner does for `refs/heads/shepherd/`)
    // and narrow to the `docs-update-` branches in code.
    const out = await this.git(repo, [
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/remotes/origin/shepherd/`,
    ]);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^origin\//, ""))
      .filter((b) => b.startsWith(prefix));
  }

  /** Remove a worktree + force-delete its local branch + complete its dangling row + close any
   *  husk tab. The terminal prune branch of the decision tree. */
  private async pruneWorktree(repo: string, path: string, branch: string): Promise<void> {
    await this.completeRowFor(path);
    const tab = this.findLiveTab(path);
    if (tab) await this.deps.herdr.closeTab(tab.tabId);
    this.deps.worktree.remove(path);
    try {
      await this.git(repo, ["branch", "-D", branch]);
    } catch {
      /* best-effort: a never-committed branch may already be gone */
    }
  }

  /** After the worktree loop: complete any uncompleted `doc_agent` row whose worktree no longer
   *  exists on disk (finalize ran but never completed it, or it was pruned elsewhere) so cost
   *  attribution never leaks. Rows owned by a live in-flight run are left for tick() to complete. */
  private async sweepDanglingRows(): Promise<void> {
    const owned = new Set([...this.inflight.values()].map((f) => f.worktreePath));
    for (const row of this.deps.store.listReviewerSpawns()) {
      if (row.kind !== "doc_agent" || row.completedAt != null) continue;
      if (owned.has(row.worktreePath) || this.fileExists(row.worktreePath)) continue;
      await this.completeRowFor(row.worktreePath);
    }
  }

  /** Complete the uncompleted `doc_agent` cost row for `worktreePath` with real usage (best-effort,
   *  zeroed fallback). No-op when no matching row exists. */
  private async completeRowFor(worktreePath: string): Promise<void> {
    const row = this.uncompletedRowFor(worktreePath);
    if (!row) return;
    const u = await this.readUsage(worktreePath, row.reviewerSessionId).catch(() => null);
    this.deps.store.completeReviewerSpawn(row.reviewerSessionId, u ?? ZEROED_USAGE, this.now());
  }

  /** The uncompleted `doc_agent` reviewer_spawns row for a worktree path, or undefined. */
  private uncompletedRowFor(worktreePath: string) {
    return this.deps.store
      .listReviewerSpawns()
      .find(
        (r) => r.kind === "doc_agent" && r.completedAt == null && r.worktreePath === worktreePath,
      );
  }

  /** A live herdr agent (doc-agent prefix) whose cwd is this worktree, or undefined. */
  private findLiveTab(
    worktreePath: string,
  ): { tabId: string; terminalId: string; name: string } | undefined {
    try {
      return this.deps.herdr
        .list()
        .find((a) => a.name.startsWith(DOC_AGENT_LABEL) && a.cwd === worktreePath);
    } catch {
      return undefined;
    }
  }

  /** Final pass: close any leftover doc-agent husk tab NOT owned by a re-adopted in-flight run. */
  private closeHuskTabs(): void {
    const ownedCwds = new Set([...this.inflight.values()].map((f) => f.worktreePath));
    const ownedTerms = new Set(
      [...this.inflight.values()].map((f) => f.terminalId).filter(Boolean),
    );
    try {
      for (const a of this.deps.herdr.list()) {
        if (!a.name.startsWith(DOC_AGENT_LABEL)) continue;
        if (ownedTerms.has(a.terminalId) || ownedCwds.has(a.cwd)) continue; // spare re-adopted runs
        void this.deps.herdr.closeTab(a.tabId);
      }
    } catch (err) {
      console.warn("[doc-agent] reapOrphans tab pass:", err);
    }
  }

  /** Read + parse the re-target marker at a worktree root, or null when absent/unparseable. */
  private readRetargetMarker(
    worktreePath: string,
  ): { prNumber: number; headBranch: string; base: string } | null {
    const raw = this.readMarkerFn(join(worktreePath, RETARGET_MARKER));
    if (raw == null) return null;
    try {
      const m = JSON.parse(raw) as { prNumber?: unknown; headBranch?: unknown; base?: unknown };
      if (typeof m.prNumber !== "number" || typeof m.headBranch !== "string") return null;
      return {
        prNumber: m.prNumber,
        headBranch: m.headBranch,
        base: typeof m.base === "string" ? m.base : "",
      };
    } catch {
      return null;
    }
  }

  /** Parse `git worktree list --porcelain` → [{path, branch}] (branch "" for detached). */
  private async listWorktreeBranches(repo: string): Promise<{ path: string; branch: string }[]> {
    const out = await this.git(repo, ["worktree", "list", "--porcelain"]);
    const res: { path: string; branch: string }[] = [];
    let cur: { path: string; branch: string } | null = null;
    const flush = () => {
      if (cur) res.push(cur);
      cur = null;
    };
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        flush();
        cur = { path: line.slice("worktree ".length).trim(), branch: "" };
      } else if (line.startsWith("branch ") && cur) {
        cur.branch = line
          .slice("branch ".length)
          .trim()
          .replace(/^refs\/heads\//, "");
      } else if (line === "") {
        flush();
      }
    }
    flush();
    return res;
  }
}

// ── cadence markers (settings KV) ─────────────────────────────────────────────
const lastShaKey = (repo: string) => `docagent:last-sha:${repo}`;
const nightlyDayKey = (repo: string) => `docagent:nightly-day:${repo}`;
// One tiny row per merged feat/config PR per repo. Bounded by the count of such PRs (finite, modest)
// and never read back beyond an existence check, so it needs no cleanup path — same accept-and-grow
// posture as the existing `learnings:*` per-key settings markers (e.g. learnings:retired-seen:<repo>).
const mergedSeenKey = (repo: string, prNumber: number) =>
  `docagent:merged-seen:${repo}:${prNumber}`;
// Re-target ownership claim (issue #956 Option B). Set at re-target START (in beginRetarget, before
// the spawn) so onMergedPr defers even if the code PR merges mid-run. Same accept-and-grow posture
// as mergedSeenKey — one tiny row per re-targeted PR, never cleaned up.
const prSyncedKey = (repo: string, prNumber: number) => `docagent:pr-synced:${repo}:${prNumber}`;

/** Local `YYYY-MM-DD` for `now` — the nightly once/day key (mirrors herd-digest's dayKeyFor). */
function defaultDayKey(now: number): string {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * True when a merged PR's title (the squash/merge commit subject) classifies as a documentation-
 * relevant change: a conventional-commit header whose type is `feat`/`config` or whose scope is
 * `config`. Returns false for an absent/empty title, a bare (non-conventional) title, and the
 * doc-sync subject (`docs: sync …`) — so non-conventional titles cleanly degrade to the nightly path
 * and the doc agent never self-triggers off its own merged PR. `config` is a forward-looking
 * allowance (not yet in this repo's history). See issue #904.
 */
export function isDocRelevantMerge(title: string | undefined): boolean {
  if (!title) return false;
  const m = /^\s*(\w+)(?:\(([^)]*)\))?!?:/.exec(title);
  if (!m) return false;
  const type = m[1]!.toLowerCase();
  const scope = m[2]?.toLowerCase();
  return type === "feat" || type === "config" || scope === "config";
}

function defaultReadSentinel(worktreePath: string): string | null {
  const p = join(worktreePath, SENTINEL);
  if (!existsSync(p)) return null;
  try {
    const txt = readFileSync(p, "utf8");
    return txt.trim().length > 0 ? txt : null;
  } catch {
    return null; // partial write — retry next tick
  }
}

/** Read the re-target marker file at an absolute path, or null when absent/unreadable. */
function defaultReadMarker(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** PR body: the agent's grounding/uncertainty summary + a human-review banner. */
function docPrBody(sentinel: string | null): string {
  const summary =
    sentinel && sentinel.trim().length > 0 ? sentinel.trim() : "_(the doc agent left no summary)_";
  return [
    "Automated, **grounded** documentation update proposed by Shepherd's PR-gated doc agent.",
    "",
    "Each change below cites the source it was grounded in; items the agent was unsure about are",
    "flagged for human judgment. **This PR is for review only — it is never auto-merged.**",
    "",
    "---",
    "",
    summary,
  ].join("\n");
}

/** The doc-agent task prompt. Grounds the agent in recent source changes, restricts edits to the
 *  enumerated existing in-scope prose, forbids touching generated docs + creating new files +
 *  running git, and asks for a grounded/uncertainty summary written to the sentinel. */
function docAgentPrompt(base: string, ctx?: RetargetPromptCtx): string {
  const grounding = ctx
    ? [
        "You are Shepherd's documentation-maintenance agent. Your working directory is checked out at",
        `the HEAD of open PR #${ctx.prNumber} (\`${ctx.prTitle}\`). The change under review is`,
        `\`git diff ${base}...HEAD\`. Focus your doc review on what THIS change made stale, and update`,
        "ONLY the existing prose pages listed below.",
        "",
        "## Ground yourself in this PR's diff",
        `Use read-only git to understand exactly what this PR changed: \`git diff ${base}...HEAD\`,`,
        `\`git log ${base}..HEAD --stat\`, \`git show <sha>\` (these forms are what you may run).`,
        "Pay attention to changes in:",
      ]
    : [
        "You are Shepherd's documentation-maintenance agent. Your working directory is a fresh checkout",
        `of the \`${base}\` branch. Your job: find where the documentation has gone stale relative to`,
        "recent source changes, and update ONLY the existing prose pages listed below.",
        "",
        "## Ground yourself in recent changes",
        `Use read-only git to understand what changed recently: \`git log -n ${COMMIT_WINDOW} --stat\`,`,
        "`git show <sha>`, `git diff <ref>..<ref>` (these forms are what you are permitted to run).",
        "Pay attention to changes in:",
      ];
  return [
    ...grounding,
    "- `src/config.ts` — environment variables (names, defaults, behavior)",
    "- `docs/external-task-api.md`, `docs/sandbox-security.md`, `docs/token-usage-analysis.md` — the",
    "  repo-root prose sources (you may edit these directly)",
    "- the `src/` public surface and operator-facing behavior",
    "",
    "## Edit ONLY these existing pages (the in-scope set)",
    ...IN_SCOPE_PATHS.map((p) => `- \`${p}\``),
    "",
    "## Hard rules",
    "- Make a change ONLY where a doc is demonstrably stale versus the current source. For every",
    "  change, know the source (file / commit) that justifies it.",
    "- If you are UNSURE whether something is stale or how to phrase it, DO NOT guess — leave the doc",
    "  as is and flag it in the summary's uncertainty section instead.",
    "- DO NOT create new files. New pages are out of scope and will not be shipped.",
    "- DO NOT edit generated docs: `docs-site/src/content/docs/reference/cli/*` (generated from",
    "  `herdr --help`), the TypeDoc `api/*` output, or the Astro app config. They are off-limits.",
    "- DO NOT run any git command except read-only inspection (`git log/show/diff/status`). DO NOT",
    "  stage, commit, push, or open a PR — Shepherd does all of that for you after you finish.",
    "- Use only the `Edit` and `Write` tools to change the in-scope files.",
    "",
    "## Finish by writing the summary",
    `When done, write your summary to \`${SENTINEL}\` at the repository root (do NOT edit any other`,
    "file afterward). Shape it as Markdown with two sections:",
    "1. **Changes** — one bullet per edited file: what you changed and the source that grounds it.",
    "2. **Uncertain / needs human judgment** — anything you suspected was stale but did not change.",
    "",
    "If the docs are already current, change nothing and write a summary saying so. Writing the",
    `\`${SENTINEL}\` file is the last thing you do — it signals you are finished.`,
  ].join("\n");
}
