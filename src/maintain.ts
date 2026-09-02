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
import type { GitForge } from "./forge/types";
import type { BandReading, MaintainOutcome, MaintainRun, SignalKind } from "./types";
import type { RoleEnvironment } from "./default-model";
import { buildTransientAgentArgv } from "./transient-agent-argv";
import { resolveAuxSpawn, type MembraneSeams } from "./spawn-membrane";
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
  DEFAULT_BAND_THRESHOLDS,
  DEFAULT_COOLDOWN_MS,
  INCIDENT_WINDOW_MS,
  MAINTAIN_DRAFT_FILE,
  MAX_DIAGNOSES_PER_SWEEP,
  breaches,
  buildDiagnosisPrompt,
  describeReading,
  evaluateBands,
  readMaintainDraft,
  renderIssueBody,
  type BandInput,
  type BandThresholds,
  type EvidenceLine,
  type MaintainDraft,
} from "./maintain-core";

/** Herdr agent-name prefix. Unique per run (`__maintain__<8hex>`) so an orphaned pane from a prior
 *  lifetime can never squat the name a fresh spawn wants — the recurring `agent_name_taken` class. */
const MAINTAIN_AGENT_LABEL = "__maintain__";

/** The label put on a filed issue, so the operator can filter the backlog for machine-opened work. */
export const MAINTAIN_ISSUE_LABEL = "shepherd:maintain";

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
  herdr: Pick<HerdrDriver, "start" | "stop" | "list" | "paneForegroundProcs">;
  worktree: Pick<WorktreeMgr, "createDetached" | "remove" | "ensureBaseRef" | "gitCommonDir">;
  store: MaintainStore;
  /** Shepherd's OWN checkout — the repo the diagnosis reads and the issue is filed against. */
  selfRepoPath: string;
  resolveForge: (repoPath: string) => GitForge | null;
  /** Per-repo delivery rows over the 30d range, for the `first_pass_collapse` band. Injected as a
   *  thunk so this service never imports the metrics builder's store wiring. */
  repoDelivery: () => BandInput["repos"];
  /** Phase-1 escalation. false (the default) ⇒ a parsed draft is logged, never filed. */
  act?: boolean;
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

const SWEEP_DAY_KEY = "maintain:last-sweep-day";

const execFileP = promisify(execFile);

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
  /** Claimed synchronously before `beginDiagnosis`'s awaits so a manual trigger racing the daily
   *  sweep cannot double-spawn the same band. */
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
    return [...this.inflight.values()].map((f) => f.run.worktreePath);
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

    const readings = evaluateBands(this.gather(now), this.thresholds, now);
    for (const r of readings) this.deps.store.upsertMaintainReading(r);

    // Tier 1 IS this log line plus the persisted reading — deliberately not a `signals` row.
    const breached = breaches(readings);
    for (const r of breached) this.log(`[maintain] ${describeReading(r)}`);

    await this.diagnoseTop(breached, now);
  }

  /** The daily cadence gate: hour, presence, and a once-per-local-day claim. Returns false when
   *  today's evaluation must not run. The day key is stamped BEFORE any work, so every outcome —
   *  breach, skip, spawn failure — counts as today's evaluation. */
  private claimToday(now: number): boolean {
    if (new Date(now).getHours() < this.sweepHour) return false;
    // Presence-gated like the Herd Rundown: a spawn nobody is around to triage can wait a day.
    if (this.deps.isPresent && !this.deps.isPresent()) return false;
    const today = this.dayKey(now);
    if (this.deps.store.getSetting(SWEEP_DAY_KEY) === today) return false;
    this.deps.store.setSetting(SWEEP_DAY_KEY, today);
    return true;
  }

  /** Spawn a diagnosis for the most severe suppression-clear Tier-2 breach, up to the per-sweep
   *  cap. Bands are already ordered most-severe-first, so this takes the head of the list. */
  private async diagnoseTop(breached: BandReading[], now: number): Promise<void> {
    let spawned = 0;
    for (const reading of breached) {
      if (spawned >= MAX_DIAGNOSES_PER_SWEEP) break;
      if (reading.tier < 2) continue;
      // Claim the band SYNCHRONOUSLY, before the first await. `suppressionFor` awaits a forge
      // round-trip, so without the claim a manual `force` sweep racing the daily tick could pass
      // the in-flight check in both calls and spawn the same band twice.
      if (this.starting.has(reading.key) || this.inflight.has(reading.key)) {
        this.log(`[maintain] ${reading.key} tier 2 suppressed: a run is already in flight`);
        continue;
      }
      this.starting.add(reading.key);
      try {
        const suppression = await this.suppressionFor(reading.key, now);
        if (suppression) {
          this.log(`[maintain] ${reading.key} tier 2 suppressed: ${suppression}`);
          continue;
        }
        if (await this.beginDiagnosis(reading)) spawned += 1;
      } finally {
        this.starting.delete(reading.key);
      }
    }
  }

  /** Assemble the three bands' inputs. */
  private gather(now: number): BandInput {
    return {
      reviewOutcomes: this.deps.store.countReviewOutcomes(now - CRITIC_WINDOW_MS),
      incidents: this.deps.store.countSignalsByKind(now - INCIDENT_WINDOW_MS),
      repos: this.deps.repoDelivery(),
    };
  }

  /**
   * Why this band may not diagnose right now, or null when it may. Three rules, checked cheapest
   * first; rule 2 is the one that holds in observe mode.
   */
  private async suppressionFor(bandKey: string, now: number): Promise<string | null> {
    if (this.inflight.has(bandKey)) return "a run is already in flight";
    const last = this.deps.store.lastCompletedMaintainRun(bandKey);
    if (last?.completedAt != null && now - last.completedAt < this.cooldownMs) {
      const days = Math.ceil((this.cooldownMs - (now - last.completedAt)) / 86_400_000);
      return `cooling down for ${days} more day(s)`;
    }
    // Only ever EXTENDS suppression past the cooldown; it can never shorten it. A forge failure
    // here must not block a diagnosis, so it degrades to the cooldown alone.
    if (last?.issueNumber != null && (await this.issueStillOpen(last.issueNumber))) {
      return `issue #${last.issueNumber} is still open`;
    }
    return null;
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
    for (const run of this.deps.store.listInflightMaintainRuns()) {
      if (this.inflight.has(run.bandKey)) continue;
      this.deps.store.finishMaintainRun(run.id, { outcome: "error", completedAt: this.now() });
      this.deps.store.completeReviewerSpawn(run.spawnSessionId, ZEROED_USAGE, this.now());
      try {
        this.deps.worktree.remove(run.worktreePath);
      } catch {
        /* best-effort: already gone */
      }
      this.log(`[maintain] reaped orphaned diagnosis run for ${run.bandKey}`);
    }
  }
}
