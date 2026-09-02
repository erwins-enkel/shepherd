/**
 * MaintainService — the maintain loop's spawning half (#2157, from #2151 R5).
 *
 * Once per local day it evaluates the bands in {@link import("./maintain-core")} over Shepherd's own
 * health data, persists every reading, logs the breaches, and — for at most ONE band per sweep —
 * spawns a read-only diagnosis agent whose drafted issue the trusted server files against
 * Shepherd's OWN repo. The agent never reaches a forge: it writes a JSON draft and nothing else.
 *
 * Lifecycle mirrors DocAgentService (`sweep` / `tick` / `reapOrphans`), the repo's proven
 * restart-safe transient-spawn shape.
 *
 * ── TWO INVARIANTS THAT ARE EASY TO BREAK ────────────────────────────────────────────────────────
 *
 * 1. **Never write a reading into `signals`.** The `incident_spike` band counts `signals` BY KIND,
 *    so a breach recorded there would feed the band that emitted it and amplify itself every sweep.
 *    Readings go to `maintain_readings`; this service calls `addSignal` nowhere, and
 *    `MaintainStore` deliberately does not include it so a future edit cannot reach it.
 *
 * 2. **The cooldown anchors on `maintain_runs`, not on a filed issue.** The default armed
 *    configuration (`SHEPHERD_MAINTAIN_LOOP=1`, `SHEPHERD_MAINTAIN_ACT` off) is expected to run for
 *    weeks and files NOTHING. An issue-anchored cooldown would therefore leave a persistent breach
 *    with no anchor at all and re-spawn a diagnosis every single day. Every run writes a row,
 *    including the ones that file nothing and the ones that error, and that row is the anchor.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import { HerdrUnavailableError } from "./herdr";
import type { WorktreeMgr } from "./worktree";
import { EmptyDiffError, type GitForge } from "./forge/types";
import type { BandReading, MaintainOutcome, MaintainRun, SignalKind } from "./types";
import type { RoleEnvironment } from "./default-model";
import { buildTransientAgentArgv } from "./transient-agent-argv";
import { resolveAuxSpawn, type MembraneSeams } from "./spawn-membrane";
import { reapTransientByLabel } from "./transient-tab-reaper";
import {
  STARTUP_GRACE_MS,
  decideVerdictAction,
  isSpawnAlive,
  type VerdictAction,
  type VerdictRead,
} from "./json-tolerant";
import { readSessionUsage, type SessionUsage } from "./usage";
import {
  CRITIC_WINDOW_MS,
  DEAD_CODE_COMMIT_MSG,
  DEFAULT_BAND_THRESHOLDS,
  DEFAULT_COOLDOWN_MS,
  FALLOW_VERSION,
  INCIDENT_WINDOW_MS,
  MAINTAIN_DRAFT_FILE,
  MAX_ACTIONS_PER_SWEEP,
  breaches,
  buildDiagnosisPrompt,
  describeDeadCode,
  describeReading,
  evaluateBands,
  parseDeadCodeReport,
  readMaintainDraft,
  renderFixPrBody,
  renderIssueBody,
  type BandInput,
  type BandThresholds,
  type DeadCodeReading,
  type EvidenceLine,
  type MaintainDraft,
} from "./maintain-core";

/** Herdr agent-name prefix. Unique per run (`__maintain__<8hex>`) so an orphaned pane from a prior
 *  lifetime can never squat the name a fresh spawn wants — the recurring `agent_name_taken` class. */
export const MAINTAIN_AGENT_LABEL = "__maintain__";

/** The label put on a filed issue, so the operator can filter the backlog for machine-opened work. */
export const MAINTAIN_ISSUE_LABEL = "shepherd:maintain";

/** Worktree/branch name stem for a Tier-3 fix. `worktree.create()` prepends `shepherd/`, so the
 *  branch is `shepherd/maintain-fix-<8hex>`; `reapOrphans` matches the same prefix. */
const FIX_BRANCH_PREFIX = "maintain-fix-";
const FIX_BRANCH_FULL_PREFIX = `shepherd/${FIX_BRANCH_PREFIX}`;

/**
 * The packages whose dependencies must be installed before fallow is trusted (#2171).
 *
 * LOAD-BEARING, not a nicety. Measured on this repo: `fallow dead-code` in a fresh worktree with no
 * `node_modules` reports 14 findings (6 unused files, 6 unused exports) where the same tree with
 * these three installed reports 3. Without imports it can resolve, fallow calls live code dead —
 * and `fallow fix` would then delete it. Mirrors what CI installs before its own `fallow audit`.
 */
const FIX_INSTALL_DIRS = [".", "ui", "extension"] as const;

/** Files whose modification by `fallow fix` aborts the run. It also removes unused DEPENDENCIES,
 *  and a manifest edit without a matching lockfile regen lands the PR CI-red — that needs a human,
 *  not a background loop. Matched against `git status --porcelain` paths in any package. */
const MANIFEST_RE = /(^|\/)(package\.json|bun\.lock|bun\.lockb|package-lock\.json)$/;

/** Every Tier-3 subprocess is bounded: a cold `bunx fallow@…` download that hangs must not hold a
 *  worktree (and the band's in-flight claim) forever. Same posture as the pre-push fallow lane. */
const FIX_SUBPROCESS_TIMEOUT_MS = 5 * 60_000;

/**
 * The subprocess surface of a Tier-3 fix, behind one seam so the whole path is testable without
 * running bun, fallow or tsc. Everything here is deliberately dumb: it runs a command and either
 * resolves or throws, leaving every decision to {@link MaintainService.runFix}.
 */
export interface FixRunner {
  /** `bun install --frozen-lockfile` in each of {@link FIX_INSTALL_DIRS}. Throws on failure —
   *  `--frozen-lockfile` also means a lockfile that does not match its manifest fails here rather
   *  than silently rewriting itself into the diff we are about to commit. */
  install(worktreePath: string): Promise<void>;
  /** `fallow dead-code --format json`; raw stdout, or null when the run failed. Null is NOT an
   *  empty report — see `parseDeadCodeReport`. */
  deadCode(worktreePath: string): Promise<string | null>;
  /** `fallow fix --yes --no-create-config`. Throws on failure. */
  fix(worktreePath: string): Promise<void>;
  /** `bun run typecheck`. Throws when it does not pass. */
  typecheck(worktreePath: string): Promise<void>;
}

const execFileP = promisify(execFile);

/**
 * Recover a fallow report from a NON-ZERO exit, or null when the output cannot be trusted.
 *
 * `fallow dead-code` exits **1 whenever it finds anything** — which is every single time the band
 * has something to say. Treating that rejection as "could not measure" would make `dead_code_drift`
 * read "no data" exactly when it matters, leave tier 3 permanently unreachable, and fail every
 * post-fix verification. The report is on stdout either way, so the exit code is not the signal.
 *
 * A KILLED process is different: a timeout or a `maxBuffer` overflow leaves stdout truncated
 * mid-document, and `tolerantParseJson` would happily repair that into a shape-valid report with a
 * SMALLER finding count — which the verify gate could read as a clean tree. So a killed run yields
 * null, and null fails the gate.
 */
export function reportFromFailedExit(err: unknown): string | null {
  const e = err as { stdout?: unknown; killed?: boolean };
  if (e.killed) return null;
  return typeof e.stdout === "string" && e.stdout.length > 0 ? e.stdout : null;
}

/** The real runner. Every call is async — a synchronous subprocess here would freeze the web
 *  terminal for the length of an install (house rule: no blocking subprocess on the Bun loop). */
const defaultFixRunner: FixRunner = {
  async install(worktreePath) {
    for (const dir of FIX_INSTALL_DIRS) {
      await execFileP("bun", ["install", "--frozen-lockfile"], {
        cwd: join(worktreePath, dir),
        timeout: FIX_SUBPROCESS_TIMEOUT_MS,
      });
    }
  },
  async deadCode(worktreePath) {
    try {
      const { stdout } = await execFileP(
        "bunx",
        [`fallow@${FALLOW_VERSION}`, "dead-code", "--format", "json"],
        {
          cwd: worktreePath,
          timeout: FIX_SUBPROCESS_TIMEOUT_MS,
          // A findings-bearing report is large; the default 1MB cap would truncate it into
          // unparseable JSON, which reads as "could not measure" rather than as a false zero.
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      return stdout;
    } catch (err) {
      return reportFromFailedExit(err);
    }
  },
  async fix(worktreePath) {
    await execFileP("bunx", [`fallow@${FALLOW_VERSION}`, "fix", "--yes", "--no-create-config"], {
      cwd: worktreePath,
      timeout: FIX_SUBPROCESS_TIMEOUT_MS,
    });
  },
  async typecheck(worktreePath) {
    await execFileP("bun", ["run", "typecheck"], {
      cwd: worktreePath,
      timeout: FIX_SUBPROCESS_TIMEOUT_MS,
    });
  },
};

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Signal payloads offered to the diagnosis agent as evidence: the band's own window, and a read
 *  bound well above what the prompt builder embeds (it caps the block itself). */
const EVIDENCE_LOOKBACK_MS = INCIDENT_WINDOW_MS;
const EVIDENCE_LIMIT = 50;
const RECENT_RUNS_LIMIT = 20;

/** Written when a finalize completes a spawn row but the transcript is unreadable, so the cost row
 *  is never left dangling. Same shape as doc-agent.ts / review.ts. */
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

/** The store surface this service touches. Narrowed so a test can seed a real SessionStore (or a
 *  stub) without standing up the server — and so `addSignal` is structurally out of reach. */
export type MaintainStore = Pick<
  SessionStore,
  | "getSetting"
  | "setSetting"
  | "countReviewOutcomes"
  | "countSignalsByKind"
  | "listSignalsByKind"
  | "upsertMaintainReading"
  | "listMaintainReadings"
  | "insertMaintainRun"
  | "finishMaintainRun"
  | "listInflightMaintainRuns"
  | "lastCompletedMaintainRun"
  | "listMaintainRuns"
  | "recordReviewerSpawn"
  | "completeReviewerSpawn"
>;

export interface MaintainDeps extends MembraneSeams {
  herdr: Pick<
    HerdrDriver,
    "start" | "stop" | "list" | "paneForegroundProcs" | "tabsAsync" | "closeTab"
  >;
  worktree: Pick<
    WorktreeMgr,
    "create" | "createDetached" | "remove" | "ensureBaseRef" | "gitCommonDir"
  >;
  store: MaintainStore;
  /** Shepherd's OWN checkout — the repo the diagnosis reads and the issue is filed against. */
  selfRepoPath: string;
  resolveForge: (repoPath: string) => GitForge | null;
  /** Per-repo delivery rows over the 30d range, for the `first_pass_collapse` band. Injected as a
   *  thunk so this service never imports the metrics builder's store wiring. */
  repoDelivery: () => BandInput["repos"];
  /** Phase-1 escalation. false (the default) ⇒ a parsed draft is logged, never filed. */
  act?: boolean;
  /** Tier-3 escalation (#2171). false (the default) ⇒ a fix run does all its work and logs the PR
   *  it WOULD open, then throws the branch away. Deliberately INDEPENDENT of `act`: arming
   *  issue-filing must never implicitly arm PR-opening. */
  pr?: boolean;
  /** The Tier-3 subprocess seam (default {@link defaultFixRunner}). */
  fixRunner?: FixRunner;
  /** Local hour (0–23) at/after which a sweep may run. */
  sweepHour?: number;
  /** Operator presence — a daily sweep that spawns an agent waits for someone to be around. */
  isPresent?: () => boolean;
  env?: () => RoleEnvironment;
  thresholds?: BandThresholds;
  cooldownMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Local `YYYY-MM-DD` for `now` — the once/day key. */
  dayKey?: (now: number) => string;
  /** Read the agent's draft from its worktree (tests inject). */
  readDraft?: (worktreePath: string) => string | null;
  /** Git runner (tests inject). Used only to resolve `origin/<base>` to a real sha. */
  git?: (cwd: string, args: string[]) => Promise<string>;
  readUsage?: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;
  log?: (msg: string) => void;
}

/** A live diagnosis run this process owns. */
interface InFlight {
  run: MaintainRun;
  terminalId: string;
  finalizing: boolean;
}

/** Why a Tier-3 fix stopped before opening a PR. Every one of these is a deliberate, logged exit —
 *  none of them opens anything. */
type FixAbort = { outcome: "skipped"; why: string } | { outcome: "error"; why: string };

const SWEEP_DAY_KEY = "maintain:last-sweep-day";

async function defaultGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout;
}

function defaultDayKey(now: number): string {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * The local branch a Tier-3 worktree path belongs to, or null when the path is not one.
 *
 * Derived rather than stored: `worktree.create` names the checkout `<repo>-<name>` and the branch
 * `shepherd/<name>`, so the path already carries the branch. The hex-only match doubles as the
 * argv guard — a branch name reaching `git branch -D` can never start with `-`.
 */
function fixBranchOf(worktreePath: string): string | null {
  const m = /maintain-fix-([0-9a-f]{8})$/.exec(basename(worktreePath));
  return m ? `${FIX_BRANCH_FULL_PREFIX}${m[1]}` : null;
}

function defaultReadDraft(worktreePath: string): string | null {
  const p = join(worktreePath, MAINTAIN_DRAFT_FILE);
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

/** Human-readable threshold summary for the diagnosis prompt's header. */
function thresholdNote(reading: BandReading, t: BandThresholds): string {
  if (reading.bandId === "incident_spike") {
    const { tier1, tier2 } = t.incident_spike;
    return `tier 1 at ≥${tier1.occurrences} occurrences across ≥${tier1.sessions} sessions; tier 2 at ≥${tier2.occurrences}/≥${tier2.sessions}`;
  }
  const cfg = reading.bandId === "critic_error_rate" ? t.critic_error_rate : t.first_pass_collapse;
  const dir = reading.bandId === "first_pass_collapse" ? "at or below" : "at or above";
  return `tier 1 ${dir} ${(cfg.tier1 * 100).toFixed(0)}%, tier 2 ${dir} ${(cfg.tier2 * 100).toFixed(0)}% (min sample ${cfg.minSample})`;
}

export class MaintainService {
  private inflight = new Map<string, InFlight>();
  /** Live Tier-3 fix runs, bandKey → worktree path. Kept apart from `inflight` on purpose: a fix
   *  run finalizes itself inside one awaited call and has no draft, no pane and nothing for
   *  `tick()` to do, so putting it in the map `tick()` walks would only invite a poll that
   *  finalizes it twice. */
  private fixInflight = new Map<string, string>();
  /** Claimed synchronously before `beginDiagnosis`'s / `beginFix`'s awaits so a manual trigger
   *  racing the daily sweep cannot double-start the same band. */
  private starting = new Set<string>();
  private readonly now: () => number;
  private readonly dayKey: (now: number) => string;
  private readonly readDraft: (worktreePath: string) => string | null;
  private readonly git: (cwd: string, args: string[]) => Promise<string>;
  private readonly readUsage: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;
  private readonly thresholds: BandThresholds;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly sweepHour: number;
  private readonly fixRunner: FixRunner;
  private readonly log: (msg: string) => void;

  constructor(private deps: MaintainDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.dayKey = deps.dayKey ?? defaultDayKey;
    this.readDraft = deps.readDraft ?? defaultReadDraft;
    this.git = deps.git ?? defaultGit;
    this.readUsage = deps.readUsage ?? ((cwd, id) => readSessionUsage(cwd, id));
    this.thresholds = deps.thresholds ?? DEFAULT_BAND_THRESHOLDS;
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sweepHour = deps.sweepHour ?? 4;
    this.fixRunner = deps.fixRunner ?? defaultFixRunner;
    this.log = deps.log ?? ((msg) => console.log(msg));
  }

  /** Worktree paths this service currently owns.
   *
   *  LOAD-BEARING: `createDetached` puts `-review-` in the path, so a diagnosis checkout lands in
   *  the namespace `sweepStaleReviewWorktrees` reaps hourly at a REVIEW_WORKTREE_GRACE_MS
   *  (15-minute) grace. `launch()` does record a `reviewer_spawns` row, so that sweeper's
   *  recent-uncompleted-spawn spare covers the run's first 15 minutes — but this role's hard
   *  timeout is 15 minutes too, so a diagnosis that runs to its deadline outlives the grace by
   *  design, and `scanClaudeAliveByWorktree` cannot see a Codex spawn holding it. index.ts MUST
   *  therefore union this into that sweep's `protectedPaths`, exactly as it does for the plan gate
   *  and the two critics; without it a long run has its checkout deleted underneath it. */
  inflightWorktrees(): string[] {
    return [
      ...[...this.inflight.values()].map((f) => f.run.worktreePath),
      // A Tier-3 checkout is `shepherd/maintain-fix-…`-shaped, so the `-review-` sweeper never
      // sees it — but it IS one of this service's live worktrees, and any future sweeper reading
      // this list must be told about it.
      ...this.fixInflight.values(),
    ];
  }

  /** Latest reading per band + the recent run log — the Delivery lens's band card. */
  snapshot(): { readings: BandReading[]; recentRuns: MaintainRun[] } {
    return {
      readings: this.deps.store.listMaintainReadings(),
      recentRuns: this.deps.store.listMaintainRuns(RECENT_RUNS_LIMIT),
    };
  }

  /**
   * Daily band evaluation. `force` (the manual trigger) skips the hour/presence/day gates so the
   * path is exercisable without waiting for the cadence; it does NOT skip suppression, which is the
   * spend bound.
   */
  async sweep(opts?: { force?: boolean }): Promise<void> {
    const now = this.now();
    if (!opts?.force && !this.claimToday(now)) return;

    const readings = evaluateBands(await this.gather(now), this.thresholds, now);
    for (const r of readings) this.deps.store.upsertMaintainReading(r);

    // Tier 1 IS this log line plus the persisted reading — deliberately not a `signals` row.
    const breached = breaches(readings);
    for (const r of breached) this.log(`[maintain] ${describeReading(r)}`);

    await this.actOnTop(breached, now);
  }

  /** The daily cadence gate: hour, presence, and a once-per-local-day claim. Returns false when
   *  today's evaluation must not run. The day key is stamped BEFORE any work, so every outcome —
   *  breach, skip, spawn failure — counts as today's evaluation. */
  private claimToday(now: number): boolean {
    if (new Date(now).getHours() < this.sweepHour) return false;
    // Presence-gated: a diagnosis spawn nobody is around to triage can wait a day.
    if (this.deps.isPresent && !this.deps.isPresent()) return false;
    const today = this.dayKey(now);
    if (this.deps.store.getSetting(SWEEP_DAY_KEY) === today) return false;
    this.deps.store.setSetting(SWEEP_DAY_KEY, today);
    return true;
  }

  /**
   * Act on the most severe suppression-clear breach, up to the per-sweep cap. Bands arrive ordered
   * most-severe-first, so tier 3 is considered before tier 2 and this takes the head of the list.
   *
   * The cap counts BOTH kinds of action. A Tier-3 fix is cheap (no agent, no tokens) but it still
   * pushes a branch and opens a PR, and one of those per sweep is the point.
   */
  private async actOnTop(breached: BandReading[], now: number): Promise<void> {
    let acted = 0;
    for (const reading of breached) {
      if (acted >= MAX_ACTIONS_PER_SWEEP) break;
      if (reading.tier < 2) continue;
      // Claim the band SYNCHRONOUSLY, before the first await. `suppressionFor` awaits a forge
      // round-trip, so without the claim a manual `force` sweep racing the daily tick could pass
      // the in-flight check in both calls and spawn the same band twice.
      if (this.isRunning(reading.key)) {
        this.log(
          `[maintain] ${reading.key} tier ${reading.tier} suppressed: a run is already in flight`,
        );
        continue;
      }
      this.starting.add(reading.key);
      try {
        const suppression = await this.suppressionFor(reading.key, now);
        if (suppression) {
          this.log(`[maintain] ${reading.key} tier ${reading.tier} suppressed: ${suppression}`);
          continue;
        }
        const started =
          reading.tier === 3 ? await this.beginFix(reading) : await this.beginDiagnosis(reading);
        if (started) acted += 1;
      } finally {
        this.starting.delete(reading.key);
      }
    }
  }

  /** True when this band has a STARTED run of either tier under way in this process. Deliberately
   *  excludes the `starting` claim: {@link suppressionFor} runs while its own caller holds that
   *  claim, so folding it in here would make every band suppress itself. */
  private hasLiveRun(bandKey: string): boolean {
    return this.inflight.has(bandKey) || this.fixInflight.has(bandKey);
  }

  /** {@link hasLiveRun} plus the pre-await claim — the check a would-be starter makes. */
  private isRunning(bandKey: string): boolean {
    return this.starting.has(bandKey) || this.hasLiveRun(bandKey);
  }

  /**
   * Assemble every band's input.
   *
   * `deadCode` is measured in the LIVE checkout, not in a pristine worktree: the sweep needs a
   * reading for the lens on every band whether or not it breaches, and standing up a worktree per
   * sweep to get one would be absurd. The cost is that uncommitted local edits can colour the
   * reading — which is fine, because {@link runFix} re-measures in a clean checkout of
   * `origin/<base>` and stands down when that says there is nothing to fix.
   */
  private async gather(now: number): Promise<BandInput> {
    return {
      reviewOutcomes: this.deps.store.countReviewOutcomes(now - CRITIC_WINDOW_MS),
      incidents: this.deps.store.countSignalsByKind(now - INCIDENT_WINDOW_MS),
      repos: this.deps.repoDelivery(),
      deadCode: parseDeadCodeReport(
        await this.fixRunner.deadCode(this.deps.selfRepoPath).catch(() => null),
      ),
    };
  }

  /**
   * Why this band may not act right now, or null when it may. Three rules, checked cheapest
   * first; rule 2 is the one that holds in observe mode.
   */
  private async suppressionFor(bandKey: string, now: number): Promise<string | null> {
    if (this.hasLiveRun(bandKey)) return "a run is already in flight";
    const last = this.deps.store.lastCompletedMaintainRun(bandKey);
    if (last?.completedAt != null && now - last.completedAt < this.cooldownMs) {
      const days = Math.ceil((this.cooldownMs - (now - last.completedAt)) / 86_400_000);
      return `cooling down for ${days} more day(s)`;
    }
    // Only ever EXTENDS suppression past the cooldown; it can never shorten it. A forge failure
    // here must not block a run, so it degrades to the cooldown alone.
    if (last?.issueNumber != null && (await this.publishedStillOpen(last))) {
      const what = last.outcome === "opened" ? "PR" : "issue";
      return `${what} #${last.issueNumber} is still open`;
    }
    return null;
  }

  /** Whether the artifact the band's last run published is still open — an issue for a `filed`
   *  Tier-2 run, a PR for an `opened` Tier-3 one. Re-opening a second PR for dead code the operator
   *  has not merged yet is the exact pile-up this prevents. */
  private async publishedStillOpen(last: MaintainRun): Promise<boolean> {
    if (last.issueNumber == null) return false;
    return last.outcome === "opened"
      ? this.prStillOpen(last.issueNumber)
      : this.issueStillOpen(last.issueNumber);
  }

  /** Fail-open like {@link issueStillOpen}: a forge blip degrades to the plain cooldown, never to
   *  a daily re-push. */
  private async prStillOpen(prNumber: number): Promise<boolean> {
    const forge = this.deps.resolveForge(this.deps.selfRepoPath);
    if (!forge) return false;
    try {
      return (await forge.listPullRequests()).some((p) => p.number === prNumber);
    } catch (err) {
      this.log(`[maintain] could not check PR #${prNumber}: ${String(err)}`);
      return false;
    }
  }

  private async issueStillOpen(issueNumber: number): Promise<boolean> {
    const forge = this.deps.resolveForge(this.deps.selfRepoPath);
    if (!forge) return false;
    try {
      // `listIssues()` is open-only. It is capped (200 on GitHub), so a still-open issue in a very
      // busy backlog can be missed — that degrades to the plain cooldown, never to a daily re-file.
      return (await forge.listIssues()).some((i) => i.number === issueNumber);
    } catch (err) {
      this.log(`[maintain] could not check issue #${issueNumber}: ${String(err)}`);
      return false;
    }
  }

  /** Recent signal payloads relevant to the band, as diagnosis evidence.
   *
   *  Read ACROSS every repo, matching how the band is scored: `countSignalsByKind` has no repo
   *  dimension, so scoping evidence to the self repo would leave a band breached by another repo's
   *  signals with an empty evidence block. Each line carries its own `repo` so the agent can see
   *  whether the class is concentrated or spread. */
  private evidenceFor(reading: BandReading, now: number): EvidenceLine[] {
    // Only `incident_spike` names a signal kind; the rate bands have no signal stream of their own,
    // so they diagnose from the code plus the measurement in the prompt header.
    if (reading.bandId !== "incident_spike" || !reading.subject) return [];
    return this.deps.store
      .listSignalsByKind(reading.subject as SignalKind, now - EVIDENCE_LOOKBACK_MS, EVIDENCE_LIMIT)
      .map((s) => ({ kind: s.kind, repo: basename(s.repoPath), ts: s.ts, payload: s.payload }));
  }

  /** Spawn the read-only diagnosis agent. Returns true when a run is now in flight. */
  private async beginDiagnosis(reading: BandReading): Promise<boolean> {
    const forge = this.deps.resolveForge(this.deps.selfRepoPath);
    if (!forge || forge.isLightweight) {
      // Fail closed: with no PR/issue surface there is nowhere for the deliverable to go.
      this.log(
        `[maintain] ${reading.key}: no forge for ${this.deps.selfRepoPath} — tier 2 skipped`,
      );
      return false;
    }
    try {
      return await this.launch(reading, forge);
    } catch (err) {
      this.log(`[maintain] ${reading.key}: diagnosis failed to start: ${String(err)}`);
      return false;
    }
  }

  // ── tier 3: the pre-approved fix (#2171) ───────────────────────────────────

  /**
   * Run the band's pre-approved fix and, when armed, open a PR for it.
   *
   * Structurally unlike Tier 2: no agent, so no herdr pane, no membrane, no draft file, no
   * `reviewer_spawns` cost row and no `tick()` participation. The whole run lives inside this one
   * awaited call. That is the point of a pre-approved class — the remediation is mechanical enough
   * that nothing has to be reasoned about, so nothing has to be spawned.
   *
   * Returns true when a run happened (the band consumed its per-sweep action), false when it could
   * not be started at all.
   */
  private async beginFix(reading: BandReading): Promise<boolean> {
    const repoPath = this.deps.selfRepoPath;
    const forge = this.deps.resolveForge(repoPath);
    if (!forge || forge.isLightweight) {
      // Fail closed, same as Tier 2: with no PR surface there is nowhere for the fix to go.
      this.log(`[maintain] ${reading.key}: no forge for ${repoPath} — tier 3 skipped`);
      return false;
    }
    let base: string;
    try {
      base = await forge.defaultBranch();
    } catch {
      this.log(`[maintain] ${reading.key}: could not resolve the default branch`);
      return false;
    }
    // Freshen origin/<base> so the fix is computed against current main, not a stale local ref.
    const resolved = await this.deps.worktree.ensureBaseRef(repoPath, base);

    const name = FIX_BRANCH_PREFIX + randomUUID().slice(0, 8);
    let wt;
    try {
      wt = this.deps.worktree.create(repoPath, resolved.baseRef, name);
    } catch (err) {
      this.log(`[maintain] ${reading.key}: worktree creation failed: ${String(err)}`);
      return false;
    }
    if (!wt.isolated || !wt.branch) {
      // A non-isolated result means the repo is not a git checkout — there is nothing to commit to.
      this.log(`[maintain] ${reading.key}: ${repoPath} is not isolatable — tier 3 skipped`);
      if (wt.worktreePath !== repoPath) this.deps.worktree.remove(wt.worktreePath);
      return false;
    }

    const run: MaintainRun = {
      id: randomUUID(),
      bandKey: reading.key,
      bandId: reading.bandId,
      tier: reading.tier,
      value: reading.value,
      worktreePath: wt.worktreePath,
      // No agent and no spawn: both ids are empty, and `completeReviewerSpawn` no-ops on an
      // unknown id so the orphan reaper stays correct without a special case.
      agentName: "",
      spawnSessionId: "",
      spawnedAt: this.now(),
      completedAt: null,
      outcome: null,
      issueNumber: null,
      issueUrl: null,
    };
    // Claim + durable row BEFORE any work, so a crash mid-run leaves an in-flight row for
    // `reapOrphans` and a cooldown anchor either way.
    this.fixInflight.set(reading.key, wt.worktreePath);
    this.deps.store.insertMaintainRun(run);

    let outcome: MaintainOutcome = "error";
    let pr: { number: number; url: string } | null = null;
    try {
      const result = await this.runFix(reading, wt.worktreePath, wt.branch, base, forge);
      outcome = result.outcome;
      pr = "pr" in result ? result.pr : null;
      this.log(`[maintain] ${reading.key} tier 3: ${result.why}`);
    } catch (err) {
      this.log(`[maintain] ${reading.key} tier 3 failed: ${String(err)}`);
    } finally {
      // Every teardown step is best-effort so the run row below ALWAYS settles. A throw escaping
      // here would strand the band with an in-flight row until the next boot reconcile.
      try {
        this.deps.worktree.remove(wt.worktreePath);
      } catch (err) {
        this.log(`[maintain] ${reading.key}: could not remove ${wt.worktreePath}: ${String(err)}`);
      }
      // The pushed REMOTE branch backs any opened PR; only the local one is disposable.
      await this.git(repoPath, ["branch", "-D", wt.branch]).catch(() => {
        /* best-effort: a never-committed branch may already be gone */
      });
      this.deps.store.finishMaintainRun(run.id, {
        outcome,
        completedAt: this.now(),
        issueNumber: pr?.number,
        issueUrl: pr?.url,
      });
      // Dropped LAST: until it is, `inflightWorktrees()` still protects the path.
      this.fixInflight.delete(reading.key);
    }
    return true;
  }

  /**
   * The fix itself, in a clean checkout of `origin/<base>`. Three stages, each of which can stand
   * the run down on its own; only the last one publishes anything.
   */
  private async runFix(
    reading: BandReading,
    worktreePath: string,
    branch: string,
    base: string,
    forge: GitForge,
  ): Promise<FixAbort | { outcome: "opened"; why: string; pr: { number: number; url: string } }> {
    const prepared = await this.prepareFix(worktreePath);
    if ("outcome" in prepared) return prepared;
    const failed = await this.verifyFix(worktreePath);
    if (failed) return failed;
    return this.publishFix({ reading, worktreePath, branch, base, forge, ...prepared });
  }

  /**
   * Install, measure, fix, and inspect the resulting diff. Returns what was removed and which
   * files moved, or the reason the run stops here.
   *
   * Ordered so the cheap disqualifiers run before the expensive checks — measure before fixing,
   * inspect the diff before typechecking it.
   */
  private async prepareFix(
    worktreePath: string,
  ): Promise<FixAbort | { before: DeadCodeReading; changed: string[] }> {
    // Dependencies first — see FIX_INSTALL_DIRS. Without them fallow calls live code dead.
    try {
      await this.fixRunner.install(worktreePath);
    } catch (err) {
      return { outcome: "error", why: `bun install failed: ${String(err)}` };
    }

    // Re-measure in the pristine tree. The sweep's reading came from the live checkout, which can
    // carry uncommitted edits; this is the number the fix is actually accountable to.
    const before = parseDeadCodeReport(await this.fixRunner.deadCode(worktreePath));
    if (before === null) return { outcome: "error", why: "could not measure dead code" };
    if (before.autoFixable === 0) {
      return { outcome: "skipped", why: "nothing auto-fixable on the base branch" };
    }

    try {
      await this.fixRunner.fix(worktreePath);
    } catch (err) {
      return { outcome: "error", why: `fallow fix failed: ${String(err)}` };
    }
    const changed = await this.changedPaths(worktreePath);
    if (changed.length === 0) return { outcome: "skipped", why: "fallow fix changed nothing" };
    // Fail-closed on a manifest edit: `fallow fix` also removes unused DEPENDENCIES, and a
    // package.json change without a matching lockfile regen lands the PR CI-red. That regen is a
    // human's call, not a background loop's.
    const manifests = changed.filter((f) => MANIFEST_RE.test(f));
    if (manifests.length > 0) {
      return {
        outcome: "error",
        why: `refusing to commit a manifest change without a lockfile regen: ${manifests.join(", ")}`,
      };
    }
    return { before, changed };
  }

  /** The fail-closed gate, or null when the result is publishable. A red typecheck or a leftover
   *  finding means the fix is not the clean mechanical removal this tier is licensed for. */
  private async verifyFix(worktreePath: string): Promise<FixAbort | null> {
    try {
      await this.fixRunner.typecheck(worktreePath);
    } catch (err) {
      return { outcome: "error", why: `typecheck failed on the result: ${String(err)}` };
    }
    const after = parseDeadCodeReport(await this.fixRunner.deadCode(worktreePath));
    if (after === null) {
      return { outcome: "error", why: "could not re-measure dead code after the fix" };
    }
    if (after.autoFixable !== 0) {
      return {
        outcome: "error",
        why: `${after.autoFixable} auto-fixable finding(s) survived the fix`,
      };
    }
    return null;
  }

  /** Commit, push and open the PR — or, unarmed, say what that would have been. */
  private async publishFix(o: {
    reading: BandReading;
    worktreePath: string;
    branch: string;
    base: string;
    forge: GitForge;
    before: DeadCodeReading;
    changed: string[];
  }): Promise<FixAbort | { outcome: "opened"; why: string; pr: { number: number; url: string } }> {
    const { worktreePath, branch, before } = o;
    if (!this.deps.pr) {
      return {
        outcome: "skipped",
        why: `would open a PR removing ${describeDeadCode(before)} (${o.changed.length} file(s)) — SHEPHERD_MAINTAIN_PR is off`,
      };
    }
    await this.git(worktreePath, ["add", "-A"]);
    // `--no-verify` for the same reason the doc agent uses it: a server-side commit must not run
    // this repo's pre-commit hooks against a checkout nobody is sitting in front of. The change is
    // mechanical and human-reviewed via the PR.
    await this.git(worktreePath, ["commit", "--no-verify", "-m", DEAD_CODE_COMMIT_MSG]);
    await this.git(worktreePath, ["push", "-u", "origin", branch]);
    let created;
    try {
      created = await o.forge.openPr({
        head: branch,
        base: o.base,
        title: DEAD_CODE_COMMIT_MSG,
        body: renderFixPrBody(before, o.reading),
      });
    } catch (err) {
      // The branch is pushed but has no PR. Take it back down rather than leave an orphan on the
      // remote; `EmptyDiffError` lands here too and is not an error, just nothing to open.
      await this.git(worktreePath, ["push", "origin", "--delete", branch]).catch(() => {
        /* best-effort: the remote may already have dropped it */
      });
      if (err instanceof EmptyDiffError) {
        return { outcome: "skipped", why: "no net diff vs the base branch" };
      }
      return { outcome: "error", why: `openPr failed: ${String(err)}` };
    }
    if (created.number == null || !created.url) {
      return { outcome: "error", why: "forge opened a PR without a number or url" };
    }
    return {
      outcome: "opened",
      why: `opened ${created.url} removing ${describeDeadCode(before)}`,
      pr: { number: created.number, url: created.url },
    };
  }

  /** Paths `git status --porcelain` reports as changed, ignoring the status columns. Renames are
   *  reported as `old -> new`; only the destination matters here. */
  private async changedPaths(worktreePath: string): Promise<string[]> {
    const out = await this.git(worktreePath, ["status", "--porcelain"]);
    return (
      out
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const path = line.slice(3).trim();
          const arrow = path.lastIndexOf(" -> ");
          return arrow === -1 ? path : path.slice(arrow + 4);
        })
        // Porcelain quotes paths containing unusual characters; strip so MANIFEST_RE still matches.
        .map((path) => (path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path))
    );
  }

  private async launch(reading: BandReading, forge: GitForge): Promise<boolean> {
    const repoPath = this.deps.selfRepoPath;
    let base: string;
    try {
      base = await forge.defaultBranch();
    } catch {
      this.log(`[maintain] ${reading.key}: could not resolve the default branch`);
      return false;
    }
    // Freshen origin/<base> so the diagnosis reads current code, not whatever was last fetched.
    await this.deps.worktree.ensureBaseRef(repoPath, base);
    // Resolve to a REAL sha rather than reusing ensureBaseRef's `baseRef`: that falls back to the
    // BRANCH NAME for a diverged or upstream-less base, and `createDetached` hard-rejects anything
    // that is not 7-40 hex chars. Mirrors DocAgentService.originSha.
    const sha = await this.originSha(repoPath, base);
    if (sha === null) {
      this.log(`[maintain] ${reading.key}: cannot resolve origin/${base} — skipped`);
      return false;
    }

    const id8 = randomUUID().slice(0, 8);
    const agentName = MAINTAIN_AGENT_LABEL + id8;
    const now = this.now();
    const prompt = buildDiagnosisPrompt({
      reading,
      evidence: this.evidenceFor(reading, now),
      thresholdNote: thresholdNote(reading, this.thresholds),
    });
    const env = this.deps.env?.() ?? { provider: "claude" as const, model: null };
    const { argv, sessionId } = buildTransientAgentArgv("reviewer", {
      provider: env.provider,
      model: env.model,
      effort: env.effort,
      prompt,
      // The diagnosis reads its own draft FILE, never the Codex `-o` fallback.
      captureLastMessage: false,
    });

    let wt;
    try {
      // `slug` = the spawn session id, so two runs can never collide on a path (mirrors the plan
      // gate). The resulting `…-review-<uuid>-<sha8>` path is why inflightWorktrees() must be
      // unioned into sweepStaleReviewWorktrees' protectedPaths.
      wt = await this.deps.worktree.createDetached(repoPath, base, sha, sessionId);
    } catch (err) {
      this.log(`[maintain] ${reading.key}: worktree creation failed: ${String(err)}`);
      return false;
    }

    const aux = await resolveAuxSpawn({
      argv,
      worktreePath: wt.worktreePath,
      repoPath,
      worktree: this.deps.worktree,
      seams: this.deps,
      descriptor: { sessionId, kind: "maintain", model: env.model ?? null },
    });
    if ("refused" in aux || "aborted" in aux) {
      const why = "refused" in aux ? aux.refused.reason : aux.aborted.reason;
      this.log(`[maintain] ${reading.key}: spawn not started (${why})`);
      this.deps.worktree.remove(wt.worktreePath);
      return false;
    }

    let terminalId: string;
    try {
      terminalId = (
        await this.deps.herdr.start(agentName, wt.worktreePath, aux.wrapped, aux.spawnEnv)
      ).terminalId;
    } catch (err) {
      if (err instanceof HerdrUnavailableError) this.log("[maintain] herdr unavailable");
      else this.log(`[maintain] ${reading.key}: spawn failed: ${String(err)}`);
      this.deps.worktree.remove(wt.worktreePath);
      return false;
    }

    const run: MaintainRun = {
      id: randomUUID(),
      bandKey: reading.key,
      bandId: reading.bandId,
      tier: reading.tier,
      value: reading.value,
      worktreePath: wt.worktreePath,
      agentName,
      spawnSessionId: sessionId,
      spawnedAt: now,
      completedAt: null,
      outcome: null,
      issueNumber: null,
      issueUrl: null,
    };
    // inflight BEFORE the durable row, so `inflightWorktrees()` covers the path from the first
    // moment it exists on disk with an agent in it.
    this.inflight.set(reading.key, { run, terminalId, finalizing: false });
    this.deps.store.insertMaintainRun(run);
    // Cost attribution, same ledger every transient role uses. Session-less: the band key is the
    // correlation handle.
    this.deps.store.recordReviewerSpawn({
      reviewerSessionId: sessionId,
      taskSessionId: reading.key,
      kind: "maintain",
      worktreePath: wt.worktreePath,
      model: env.model ?? null,
      spawnedAt: now,
    });
    this.log(`[maintain] ${reading.key}: diagnosis spawned as ${agentName}`);
    return true;
  }

  /**
   * Finalize any run whose draft can be trusted, or that timed out.
   *
   * The read is gated exactly the way the recap and critic loops gate theirs. Finalizing on the
   * mere EXISTENCE of the draft file would be wrong: `readMaintainDraft` runs jsonrepair over a
   * malformed document, so a file caught halfway through being written comes back shape-valid.
   * Acting on it would kill the pane and delete the worktree mid-turn, and with `act` on would file
   * a truncated diagnosis as a real issue — which the 14-day cooldown then holds. So a REPAIRED
   * parse waits until the spawn is no longer alive (or the hard timeout fires); a strict parse is a
   * complete document and finalizes immediately.
   */
  async tick(): Promise<void> {
    for (const f of [...this.inflight.values()]) {
      if (f.finalizing) continue;
      f.finalizing = true;
      let read: VerdictRead<MaintainDraft>;
      let action: VerdictAction;
      try {
        const elapsed = this.now() - f.run.spawnedAt;
        read = readMaintainDraft(this.readDraft(f.run.worktreePath));
        // Ground-truth liveness via paneForegroundProcs (the tab-reaper's signal): a live-but-idle
        // agent between API turns reads "idle" in agentStatus but still owns non-shell procs.
        // isSpawnAlive never throws; a herdr blip fails closed to alive.
        const finished = !(await isSpawnAlive(this.deps.herdr, f.run.worktreePath));
        action = decideVerdictAction(
          read,
          finished,
          elapsed > this.timeoutMs,
          elapsed > STARTUP_GRACE_MS,
        );
      } catch (err) {
        // Release the claim so the next tick retries rather than wedging this run forever.
        f.finalizing = false;
        this.log(`[maintain] ${f.run.bandKey}: read/liveness failed, retrying: ${String(err)}`);
        continue;
      }
      if (action === "wait") {
        f.finalizing = false;
        continue;
      }
      const draft = action === "finalize-value" && read.status === "parsed" ? read.value : null;
      try {
        await this.finalize(f, draft, read.status);
      } catch (err) {
        this.log(`[maintain] ${f.run.bandKey}: finalize failed: ${String(err)}`);
      }
    }
  }

  private async finalize(
    f: InFlight,
    draft: MaintainDraft | null,
    readStatus: VerdictRead<MaintainDraft>["status"],
  ): Promise<void> {
    let outcome: MaintainOutcome = "error";
    let issue: { number: number; url: string } | null = null;
    try {
      if (draft === null) {
        this.log(
          `[maintain] ${f.run.bandKey}: no usable draft (${readStatus === "absent" ? "none written" : readStatus})`,
        );
      } else if (!this.deps.act) {
        // Phase-0 observe: say exactly what WOULD be filed, then file nothing.
        outcome = "skipped";
        this.log(`[maintain] ${f.run.bandKey}: would file issue "${draft.title}" (act is off)`);
      } else {
        issue = await this.fileIssue(
          f.run,
          draft.title,
          renderIssueBody(draft, this.readingFor(f)),
        );
        outcome = issue ? "filed" : "error";
      }
    } finally {
      // Teardown AND the run row settle on EVERY path — an exception escaping the block above must
      // still close the row out, or the band keeps a dangling in-flight row until the next boot
      // reconcile. `outcome` stays "error" unless the try reassigned it.
      const usage = await this.readUsage(f.run.worktreePath, f.run.spawnSessionId).catch(
        () => null,
      );
      this.deps.store.completeReviewerSpawn(
        f.run.spawnSessionId,
        usage ?? ZEROED_USAGE,
        this.now(),
      );
      await this.deps.herdr.stop(f.terminalId).catch(() => {
        /* best-effort: the pane may already be gone */
      });
      this.deps.worktree.remove(f.run.worktreePath);
      this.deps.store.finishMaintainRun(f.run.id, {
        outcome,
        completedAt: this.now(),
        issueNumber: issue?.number,
        issueUrl: issue?.url,
      });
      // Dropped from `inflight` LAST: until it is, `inflightWorktrees()` still protects the path.
      this.inflight.delete(f.run.bandKey);
    }
  }

  /** `refs/remotes/origin/<base>` sha, or null when the ref is not locally present (offline, or a
   *  fetch that never landed). Fail-closed: no sha, no diagnosis. */
  private async originSha(repoPath: string, base: string): Promise<string | null> {
    try {
      const sha = (await this.git(repoPath, ["rev-parse", `refs/remotes/origin/${base}`])).trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  /** The reading this run was spawned for, reconstructed from the run row for the issue footer. */
  private readingFor(f: InFlight): BandReading {
    const live = this.deps.store.listMaintainReadings().find((r) => r.key === f.run.bandKey);
    return (
      live ?? {
        key: f.run.bandKey,
        bandId: f.run.bandId,
        repoPath: null,
        subject: null,
        tier: f.run.tier,
        value: f.run.value,
        sampleN: 0,
        belowMinSample: false,
        evaluatedAt: f.run.spawnedAt,
      }
    );
  }

  /** File the drafted issue. The AGENT never does this — it has no `gh` and no network. */
  private async fileIssue(
    run: MaintainRun,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string } | null> {
    const forge = this.deps.resolveForge(this.deps.selfRepoPath);
    if (!forge?.createIssue) {
      this.log(`[maintain] ${run.bandKey}: forge cannot create issues`);
      return null;
    }
    let created: { number: number; url: string };
    try {
      created = await forge.createIssue({ title, body });
    } catch (err) {
      this.log(`[maintain] ${run.bandKey}: createIssue failed: ${String(err)}`);
      return null;
    }
    // Best-effort: the issue is the deliverable, the label is only a backlog filter. `addIssueLabel`
    // creates the label if the repo lacks it.
    try {
      await forge.addIssueLabel?.(created.number, MAINTAIN_ISSUE_LABEL);
    } catch (err) {
      this.log(`[maintain] ${run.bandKey}: labelling #${created.number} failed: ${String(err)}`);
    }
    this.log(`[maintain] ${run.bandKey}: filed ${created.url}`);
    return created;
  }

  /**
   * Boot reconcile. A run in flight when the process died has a durable row, a worktree on disk and
   * — since this process no longer owns its pane — no way to be finalized. Rather than adopt a pane
   * whose agent may or may not still be alive, settle the row and reclaim the worktree: the band's
   * cooldown then starts from now, so the breach is re-diagnosed on the next cadence rather than
   * immediately re-spawned.
   */
  async reapOrphans(): Promise<void> {
    // Close the panes FIRST, and before any worktree is removed. A run interrupted by a restart
    // still has a live `claude` in its tab: this process no longer owns its terminalId (MaintainRun
    // persists only the agent name), so nothing else can reach it — `reapTransientByLabel` finds it
    // by tab label instead. Removing the worktree first would leave that agent running with its cwd
    // deleted underneath it. The owned set is empty because this only ever runs at boot, from
    // `deferredStarts`, before this process has spawned anything.
    await reapTransientByLabel(this.deps.herdr, MAINTAIN_AGENT_LABEL, new Set(), "[maintain]");
    for (const run of this.deps.store.listInflightMaintainRuns()) {
      if (this.inflight.has(run.bandKey) || this.fixInflight.has(run.bandKey)) continue;
      this.deps.store.finishMaintainRun(run.id, { outcome: "error", completedAt: this.now() });
      // No-ops for a Tier-3 run, whose spawnSessionId is empty because it never spawned anything.
      this.deps.store.completeReviewerSpawn(run.spawnSessionId, ZEROED_USAGE, this.now());
      try {
        this.deps.worktree.remove(run.worktreePath);
      } catch {
        /* best-effort: already gone */
      }
      // A Tier-3 run also owns a local branch the removed worktree was holding. Left behind it
      // would collide with nothing (the name is per-run) but would accumulate one dead ref per
      // interrupted run forever.
      const fixBranch = fixBranchOf(run.worktreePath);
      if (fixBranch) {
        await this.git(this.deps.selfRepoPath, ["branch", "-D", fixBranch]).catch(() => {
          /* best-effort: a never-committed branch may already be gone */
        });
      }
      this.log(
        `[maintain] reaped orphaned ${fixBranch ? "fix" : "diagnosis"} run for ${run.bandKey}`,
      );
    }
  }
}
