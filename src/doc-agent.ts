import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config";
import { docAgentArgv } from "./doc-agent-argv";
import { EmptyDiffError } from "./forge/types";
import type { GitForge } from "./forge/types";
import type { HerdrDriver } from "./herdr";
import { HerdrUnavailableError } from "./herdr";
import type { SessionStore } from "./store";
import type { SessionUsage } from "./usage";
import { readSessionUsage } from "./usage";
import {
  apiKeyMembraneFields,
  apiKeyPassthroughEnv,
  isApiKeyConfigured,
  isApiKeyMode,
} from "./spawn-auth";
import {
  detectBackend as realDetectBackend,
  wrapArgv,
  safeRealpath,
  collectPassthroughEnv,
  type SandboxBackend,
  type MembraneInputs,
} from "./sandbox";
import type { WorktreeMgr } from "./worktree";

const execFileP = promisify(execFile);

/** Async git runner (returns stdout) — keeps the single-process event loop unblocked during the
 *  finalize stage/commit/push and the boot sweep (house rule: no blocking subprocess on the loop). */
async function defaultGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout;
}

/** Prefix for ephemeral doc-agent herdr names. Each run appends 8 hex of a fresh UUID so an
 *  orphaned husk (after a restart) can NEVER squat a stable name — a re-spawn always gets a new
 *  name, so `agent_name_taken` is impossible by construction (the distiller's fix; see
 *  DISTILL_LABEL). The underscores are load-bearing: prompt-derived session slugs are `[a-z0-9-]`
 *  only, so no real session collides, and sweepOrphans can match husks by this prefix safely. */
export const DOC_AGENT_LABEL = "__docagent__";

/** Worktree/branch name stem. worktree.create() prepends `shepherd/`, so the branch is
 *  `shepherd/docs-update-<8hex>`. sweepOrphans matches `shepherd/${DOC_BRANCH_PREFIX}`. */
const DOC_BRANCH_PREFIX = "docs-update-";

/** The agent writes this at the worktree root as its FINAL action: a per-change grounding bullet
 *  list + an "Uncertain / needs human judgment" section. Its presence is the completion signal; its
 *  content becomes the PR body. It lives OUTSIDE the staged in-scope list so it is never committed. */
const SENTINEL = ".shepherd-doc-update.md";

/** Layout guard marker: the partition/prompt/staging are Shepherd-doc-layout-specific, so a repo
 *  that lacks this tree is rejected before any spawn (it would have nothing to stage). */
const DOC_TREE_MARKER = "docs-site/src/content/docs";

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
}

export interface DocAgentDeps {
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
  >;
  model?: string | null;
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
  detectBackend?: () => SandboxBackend;
  membraneEnv?: () => {
    claudeDir: string;
    home: string;
    nodeBinReal: string;
    extraEnv?: Record<string, string>;
  };
  fileExists?: (p: string) => boolean;
  readSentinel?: (worktreePath: string) => string | null;
  buildPrompt?: (base: string) => string;
  /** Read a spawn's token usage from its transcript at finalize (cost attribution). Mirrors
   *  herd-digest.ts's identical dep + readSessionUsage default. */
  readUsage?: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;
}

/**
 * PR-gated AI doc agent (issue #882, epic #875 Phase 3).
 *
 * Manual-trigger, flag-gated (config.docAgentEnabled). On `consider(repoPath)` it spawns a scoped,
 * `dontAsk` Claude Code agent in a disposable worktree (see {@link docAgentArgv}); the agent EDITS
 * stale prose docs and writes a {@link SENTINEL} summary, but runs NO git. On the next `tick()` the
 * trusted server stages ONLY the in-scope file list, commits `--no-verify`, pushes, and opens a PR
 * via `forge.openPr()` — never an auto-merge. Mirrors the worktree+git tail of {@link
 * import("./promote").Promoter} and the spawn/membrane posture of ReviewService.
 *
 * Restart-safety: the unique-per-run herdr name (`__docagent__<8hex>`) makes name-squat impossible;
 * `sweepOrphans()` (boot) additionally clears husk tabs + orphan `shepherd/docs-update-*` worktrees,
 * working even when the herdr daemon also restarted (it parses `git worktree list`).
 */
export class DocAgentService {
  private inflight = new Map<string, InFlight>();
  private starting = new Set<string>();
  private git: (cwd: string, args: string[]) => Promise<string>;
  private now: () => number;
  private timeoutMs: number;
  private nightlyHour: number;
  private dayKey: (now: number) => string;
  private fileExists: (p: string) => boolean;
  private readSentinel: (worktreePath: string) => string | null;
  private buildPrompt: (base: string) => string;
  private act: boolean;
  private readUsage: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;

  constructor(private deps: DocAgentDeps) {
    this.git = deps.git ?? defaultGit;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 20 * 60 * 1000;
    this.nightlyHour = deps.nightlyHour ?? 3;
    this.dayKey = deps.dayKey ?? defaultDayKey;
    this.fileExists = deps.fileExists ?? existsSync;
    this.readSentinel = deps.readSentinel ?? defaultReadSentinel;
    this.buildPrompt = deps.buildPrompt ?? ((base) => docAgentPrompt(base));
    this.act = deps.act ?? false;
    this.readUsage = deps.readUsage ?? readSessionUsage;
  }

  private detectBackend(): SandboxBackend {
    if (this.deps.detectBackend) return this.deps.detectBackend();
    return realDetectBackend({
      home: homedir(),
      claudeDir: config.claudeDir,
      nodeBinReal: safeRealpath(config.nodeBin),
    });
  }

  private membraneEnv(): {
    claudeDir: string;
    home: string;
    nodeBinReal: string;
    extraEnv?: Record<string, string>;
  } {
    if (this.deps.membraneEnv) return this.deps.membraneEnv();
    return {
      claudeDir: config.claudeDir,
      home: homedir(),
      nodeBinReal: safeRealpath(config.nodeBin),
      extraEnv: collectPassthroughEnv(),
    };
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
    if (!forge || forge.kind === "local") return; // no PR surface; guardRepo would skip anyway
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
    const id8 = randomUUID().slice(0, 8);
    const wtName = DOC_BRANCH_PREFIX + id8;
    let wt;
    try {
      wt = this.deps.worktree.create(repoPath, resolved.baseRef, wtName);
    } catch (err) {
      console.warn(`[doc-agent] worktree creation failed for ${repoPath}:`, err);
      return { status: "error", reason: "worktree creation failed" };
    }
    if (!wt.isolated || !wt.branch) {
      if (wt.worktreePath !== repoPath) this.deps.worktree.remove(wt.worktreePath);
      return { status: "error", reason: "worktree creation failed" };
    }

    const spawned = this.spawnAgent(repoPath, wt.worktreePath, DOC_AGENT_LABEL + id8, base);
    if (!spawned) {
      this.deps.worktree.remove(wt.worktreePath);
      return { status: "error", reason: "spawn failed" };
    }
    const { terminalId, spawnSessionId } = spawned;
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
    });
    // AFTER inflight.set (the ordering mirrors plan-gate's documented invariant): persist a durable
    // reviewer_spawns row so this run's token burn is attributable even if it crashes before finalize.
    // Session-less — repoPath is the correlation key (herd-digest uses "" for its herd-wide spawn).
    this.deps.store.recordReviewerSpawn({
      reviewerSessionId: spawnSessionId,
      taskSessionId: repoPath,
      kind: "doc_agent",
      worktreePath: wt.worktreePath,
      model: this.deps.model ?? null,
      spawnedAt: startedAt,
    });
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
    if (isApiKeyMode() && !isApiKeyConfigured()) {
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
    if (forge.kind === "local") {
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
   *  the agent's forced --session-id (the reviewer_spawns PK), or null on a spawn failure (logged).
   *  profile "standard": the agent needs Anthropic egress (to run claude) but not GitHub — the
   *  server pushes/opens the PR — mirroring ReviewService's spawn. */
  private spawnAgent(
    repoPath: string,
    worktreePath: string,
    agentName: string,
    base: string,
  ): { terminalId: string; spawnSessionId: string } | null {
    const { argv, sessionId } = docAgentArgv(this.deps.model ?? null, this.buildPrompt(base));
    const backend = this.detectBackend();
    const env = this.membraneEnv();
    const membrane: MembraneInputs = {
      worktreePath,
      gitCommonDir: this.deps.worktree.gitCommonDir(worktreePath),
      isolated: true,
      repoPath,
      claudeDir: env.claudeDir,
      home: env.home,
      nodeBinReal: env.nodeBinReal,
      extraEnv: env.extraEnv,
      // api-key mode: a bwrap-wrapped agent masks the OAuth credential + binds the helper.
      ...apiKeyMembraneFields(),
    };
    const wrapped = wrapArgv(argv, { profile: "standard", backend, membrane });
    try {
      const terminalId = this.deps.herdr.start(
        agentName,
        worktreePath,
        wrapped,
        apiKeyPassthroughEnv(backend !== null),
      ).terminalId;
      return { terminalId, spawnSessionId: sessionId };
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

  private async finalize(f: InFlight, sentinel: string | null): Promise<void> {
    let url: string | null = null;
    try {
      const forge = this.deps.resolveForge(f.repoPath);
      // STRUCTURAL off-limits boundary: stage ONLY the in-scope list ∩ files that exist. An agent
      // edit to the Astro app, reference/cli/*, or a new file is never staged → can't reach the PR.
      const inScope = IN_SCOPE_PATHS.filter((p) => this.fileExists(join(f.worktreePath, p)));
      if (forge && inScope.length > 0) {
        await this.git(f.worktreePath, ["add", "--", ...inScope]);
        const stagedOut = (
          await this.git(f.worktreePath, ["diff", "--cached", "--name-only"])
        ).trim();
        if (stagedOut.length > 0) {
          if (!this.act) {
            // Phase-0 OBSERVE: the agent ran + edited, but we skip every publish side-effect (no
            // commit, no push, no openPr). Log exactly what we WOULD have opened, then fall through
            // to cleanup. url stays null → onChange fires the same {repoPath, url:null} shape as the
            // already-current path.
            const staged = stagedOut.split("\n").join(", ");
            const n = stagedOut.split("\n").length;
            console.warn(
              `[doc-agent] OBSERVE: ${f.repoPath} would open a doc-update PR on ${f.branch} (${n} files): ${staged}`,
            );
          } else {
            // --no-verify deliberately DIVERGES from promote.ts (which commits WITH hooks): a
            // server-side docs-only commit must not run the repo's pre-commit hooks (lint-staged
            // etc.) on unrelated state. The change is grounded + human-reviewed via the PR.
            await this.git(f.worktreePath, ["commit", "--no-verify", "-m", COMMIT_MSG]);
            await this.git(f.worktreePath, ["push", "-u", "origin", f.branch]);
            try {
              const status = await forge.openPr({
                head: f.branch,
                base: f.base,
                title: COMMIT_MSG,
                body: docPrBody(sentinel),
              });
              url = status.url ?? null;
            } catch (err) {
              // No net diff vs base → nothing to land; not an error.
              if (!(err instanceof EmptyDiffError)) throw err;
            }
          }
        }
      }
    } finally {
      // Complete the durable cost row with real usage (best-effort) on EVERY finalize path (observe
      // and act) BEFORE the worktree is removed — mirrors herd-digest.ts / review.ts.
      // completeReviewerSpawn no-ops on an unknown id, so an empty/missing id is safe.
      const usage = await this.readUsage(f.worktreePath, f.spawnSessionId).catch(() => null);
      this.deps.store.completeReviewerSpawn(f.spawnSessionId, usage ?? ZEROED_USAGE, this.now());
      // Cleanup mirrors Promoter.cleanup: stop the agent (closes its tab), remove the worktree, and
      // force-delete the local branch (the pushed remote branch backs any opened PR).
      this.deps.herdr.stop(f.terminalId);
      this.deps.worktree.remove(f.worktreePath);
      try {
        await this.git(f.repoPath, ["branch", "-D", f.branch]);
      } catch {
        /* best-effort: a never-committed branch may already be gone */
      }
    }
    this.deps.onChange?.({ repoPath: f.repoPath, url });
  }

  /** Drop a repo's in-flight tracking (e.g. on shutdown); does not touch the worktree. */
  forget(repoPath: string): void {
    this.inflight.delete(repoPath);
    this.starting.delete(repoPath);
  }

  /**
   * Boot reconcile. Two independent passes so it works even when the herdr daemon ALSO restarted:
   *  1. Close any live herdr tab whose name starts with the doc-agent prefix (herdr survived).
   *  2. herdr-independent: parse `git worktree list` per known repo and remove every
   *     `shepherd/docs-update-*` worktree + force-delete its branch (the authoritative orphan
   *     signal when there's no tab to read a cwd from, and no persisted run rows).
   * Scoped strictly to the doc-agent namespace, so it never collides with the reviewer's `review *`
   * reaper or the tmpfs sweeper.
   */
  async sweepOrphans(): Promise<void> {
    this.closeHuskTabs();
    for (const repo of this.deps.repos()) {
      if (this.inflight.has(repo)) continue; // never reap a live run
      await this.pruneRepoOrphanWorktrees(repo);
    }
  }

  /** Pass 1: close any live herdr tab whose name starts with the doc-agent prefix. */
  private closeHuskTabs(): void {
    try {
      for (const a of this.deps.herdr.list()) {
        if (a.name.startsWith(DOC_AGENT_LABEL)) this.deps.herdr.closeTab(a.tabId);
      }
    } catch (err) {
      console.warn("[doc-agent] sweepOrphans tab pass:", err);
    }
  }

  /** Pass 2 (per repo): remove every `shepherd/docs-update-*` worktree + force-delete its branch. */
  private async pruneRepoOrphanWorktrees(repo: string): Promise<void> {
    const orphanPrefix = `shepherd/${DOC_BRANCH_PREFIX}`;
    let entries: { path: string; branch: string }[];
    try {
      entries = await this.listWorktreeBranches(repo);
    } catch {
      return;
    }
    for (const { path, branch } of entries) {
      if (!branch.startsWith(orphanPrefix)) continue;
      this.deps.worktree.remove(path);
      try {
        await this.git(repo, ["branch", "-D", branch]);
      } catch {
        /* best-effort */
      }
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
function docAgentPrompt(base: string): string {
  return [
    "You are Shepherd's documentation-maintenance agent. Your working directory is a fresh checkout",
    `of the \`${base}\` branch. Your job: find where the documentation has gone stale relative to`,
    "recent source changes, and update ONLY the existing prose pages listed below.",
    "",
    "## Ground yourself in recent changes",
    `Use read-only git to understand what changed recently: \`git log -n ${COMMIT_WINDOW} --stat\`,`,
    "`git show <sha>`, `git diff <ref>..<ref>` (these forms are what you are permitted to run).",
    "Pay attention to changes in:",
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
