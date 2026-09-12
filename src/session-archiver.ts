// src/session-archiver.ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { SESSION_AUTO_ARCHIVE_MS, config } from "./config";
import { maintenance } from "./maintenance";
import type { GitForge } from "./forge/types";
import type { SessionStore } from "./store";
import type { LivenessState, Session } from "./types";

const execFileAsync = promisify(execFile);

/** Why a candidate was passed over, for the per-tick log line. Ordered as the gates run. */
type SkipReason =
  "liveness" | "inflight" | "unrestorable" | "unsynced" | "pr-open" | "pr-unknown" | "failed";

/**
 * How recently a reviewer must have been SPAWNED for its unfinished row to count as work in
 * flight. Unbounded, this gate never reopens: several spawn kinds have no completion sweep at all
 * (`classifier`, `recap`, `maintain`) and `plan_gate` rows stay NULL whenever the boot reconcile's
 * disposition is `skip` — which is exactly the arm a settled session lands in — so one row orphaned
 * by a crash would bar its session from ever being archived.
 *
 * Six hours is far past any real reviewer (the critic's own wait caps at 1800 s) while still
 * expiring an orphan. The risk it trades away is negligible in context: a candidate here has been
 * settled for a week, so a reviewer spawned in the last six hours is the only one that could
 * plausibly still be running.
 */
const INFLIGHT_REVIEWER_WINDOW_MS = 6 * 60 * 60 * 1000;

/** How stale the liveness sweep may be and still authorize an archive: a minute, or three sweep
 *  cadences, whichever is longer. A minute is ~15 cadences at the 4 s default — enough slack to
 *  ride out a few failed scans, short enough that a wedged or stopped poller stops authorizing
 *  teardown instead of handing out arbitrarily old verdicts. The cadence term matters because
 *  `SHEPHERD_PREVIEW_SWEEP_MS` is operator-tunable: a fixed minute would silently block every
 *  archive forever on a host that had slowed the sweep past it. */
function livenessMaxAgeMs(): number {
  return Math.max(60_000, 3 * config.previewSweepMs);
}

/** Statuses a settled session can hold. `blocked` is excluded — a blocked agent is alive and
 *  waiting on the operator, which is the one queue a janitor must never quietly empty. */
function isSettled(s: Session): boolean {
  return s.status === "idle" || s.status === "done";
}

export interface SessionArchiverDeps {
  store: Pick<SessionStore, "list" | "hasInflightReviewerSpawn">;
  resolveForge: (repoPath: string) => GitForge | null;
  /** `PollerService.livenessOf` — `undefined` means "no verdict", never "no claude". */
  livenessOf: (id: string) => LivenessState | undefined;
  /** `PollerService.livenessFreshAt` — epoch ms of the last sweep that produced verdicts. */
  livenessFreshAt: () => number;
  /**
   * `DrainService.retainClaim`. MUST be called after a SUCCESSFUL archive and before
   * `emitArchived` — see {@link SessionArchiver.archiveOne}, which owns that ordering and the
   * reasoning for both ends of it.
   *
   * Why it is called at all: without it `DrainService.onArchived` reads this teardown as an
   * ABANDON and releases the issue's `shepherd:active` label, re-queueing it for the drain. That
   * release is justified in its own comment only as "a manual archive is a deliberate 'drop this'
   * signal" — which an hourly janitor is not. Retaining means the issue keeps its claim and is not
   * re-spawned; a human merge still retires it via `Closes #N`.
   */
  retainClaim: (id: string) => void;
  /**
   * `SessionService.hasConversation` — the SAME predicate `restore()` gates on, not a local
   * re-derivation of it. Restorability is the difference between an archive the operator can undo
   * and a one-way teardown, and its definition moves: it is currently "a pinned `claudeSessionId`"
   * for Claude and "`codexLaunchId` plus a matching `providerSessionId`" for Codex, having last
   * changed under this file's feet. Calling the real thing is the only way this gate cannot drift
   * out of agreement with what `restore()` will actually accept.
   */
  hasConversation: (s: Session) => boolean;
  /** `SessionService.archive`. */
  archive: (id: string, reason: "stale") => Promise<unknown>;
  /** `prCache.drop` — the archived row must not keep serving a cached PR state. */
  dropPrCache: (id: string) => void;
  /** `events.emit("session:archived", {id})` — the fan-out every archive consumer keys on. */
  emitArchived: (id: string) => void;
  now?: () => number;
  intervalMs?: number;
  /** Archives per tick. Each one runs the `beforeArchive` recap hook, which spawns an agent, so an
   *  accumulated backlog must drain across ticks rather than spawn a recap per row at once. */
  maxArchivesPerTick?: number;
}

/**
 * Hourly janitor that archives SETTLED task sessions (#1156).
 *
 * Nothing else does. `settleMergedSession` archives a merged PR's session, drain retire archives a
 * retired one, and the operator's own close archives the rest — so a session whose PR was closed,
 * never opened, or simply abandoned stays live forever, holding a DB row, a worktree and a herdr
 * tab (a PTY thread plus a 10 MB scrollback buffer apiece). The field report on #1156 measured
 * 31 such rows and a herdr daemon that had died of thread exhaustion.
 *
 * **Status is not the signal; liveness is.** A session that settles in place stays `idle`: when
 * claude exits it leaves the pane alive as a bare shell and herdr keeps listing it as an idle
 * agent (#721). `done` means something stronger and rarer — the agent was absent from `agent list`,
 * i.e. the pane or tab is gone (a herdr restart, then boot `reconcile()`). Both are settled, and a
 * `done`-only sweep would have archived none of the population the issue was filed about. So
 * eligibility spans both, and the discriminator is the poller's folded `husk` verdict: positive
 * `/proc` evidence that no claude lives in the session's worktree. `stranded` is NOT eligible —
 * that is the auto-revive population (#1630), and the two sweeps must not fight over a session.
 *
 * `stranded` also covers a session that never recorded a verified spawn (`spawnTerminalId === null`
 * satisfies `isStranded`'s fingerprint), which is a narrow, deliberate blind spot: such a session
 * is revivable by the operator on request, and quietly archiving what a human may still resume is
 * the one outcome worth forfeiting some cleanup for. It stays eligible again the moment its pane
 * goes away entirely — then there is no agent to fingerprint and the verdict folds to `husk`.
 *
 * Every gate fails closed: absence of evidence spares the session. It costs an hour, and the next
 * tick asks again.
 */
export class SessionArchiver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly maxArchivesPerTick: number;

  constructor(private deps: SessionArchiverDeps) {
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? 60 * 60 * 1000;
    this.maxArchivesPerTick = deps.maxArchivesPerTick ?? 5;
  }

  /** Default ON; `config.sessionAutoArchiveEnabled` folds the env seed and the persisted
   *  `sessionAutoArchiveEnabled` setting (resolved at boot in index.ts). Read per tick so a
   *  runtime flip takes effect without a restart. */
  private enabled(): boolean {
    return config.sessionAutoArchiveEnabled;
  }

  /**
   * Sessions settled long enough to consider, oldest settle first so an accumulated backlog
   * drains in a deterministic order rather than by whatever `list()` happens to return.
   *
   * A null `settledAt` is never eligible: it means the clock was never stamped (a legacy row the
   * migration could not seed), and guessing an age from `updatedAt` here is exactly the mistake
   * the column exists to avoid — boot reconcile rewrites settled rows and bumps it.
   */
  private candidates(): Session[] {
    const cutoff = this.now() - SESSION_AUTO_ARCHIVE_MS;
    return this.deps.store
      .list({ activeOnly: true })
      .filter((s) => !s.terminal && isSettled(s) && s.settledAt != null && s.settledAt <= cutoff)
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
  }

  /**
   * Is there current, positive evidence that no claude process lives in this session's worktree?
   *
   * Two ways to answer no, both fail-closed: the verdict is not `husk` (`alive`, `stranded`, or
   * none at all — an unswept session, or one whose liveness the backend cannot determine), or the
   * verdict is older than {@link livenessMaxAgeMs}. Freshness is a property of the sweep, not of
   * the entry, so it is checked once per tick's worth of reads against the poller's last
   * SUCCESSFUL sweep — a scan that keeps throwing leaves stale verdicts in place, and without this
   * they would authorize teardown forever.
   *
   * Non-isolated sessions share a worktree with their repo's other agents, so their verdict
   * answers "is any claude in this directory". That errs toward `alive` — it spares such a session
   * while a sibling runs, and never manufactures a false `husk`.
   */
  private isSettledHusk(s: Session, livenessFresh: boolean): boolean {
    return livenessFresh && this.deps.livenessOf(s.id) === "husk";
  }

  /** Server-side work that would be stranded by tearing the worktree down now. */
  private hasWorkInFlight(s: Session): boolean {
    return (
      s.mergingSince != null || // the merge train is carrying this session's PR
      s.planPhase === "planning" || // a plan-gate round is open
      this.deps.store.hasInflightReviewerSpawn(s.id, this.now() - INFLIGHT_REVIEWER_WINDOW_MS)
    );
  }

  /** `git` in the session's worktree; `null` on any failure (missing binary, torn-down path,
   *  not a repo), which every caller reads as "cannot tell" and therefore as a reason to skip. */
  private async git(cwd: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
      return stdout;
    } catch {
      return null;
    }
  }

  /**
   * True when the worktree holds work that is not safely elsewhere — uncommitted edits (which
   * `worktree.remove` would destroy outright, and which `restore()` cannot bring back) or commits
   * the remote has never seen (recoverable, since the branch survives an unmerged archive, but a
   * clear sign the work was never handed off).
   *
   * Only isolated sessions have a worktree of their own to lose; a non-isolated session runs in
   * the main checkout, which archiving never removes. A worktree that is already gone has nothing
   * left to lose either. Anything git refuses to answer counts as unsynced.
   */
  private async hasUnsyncedWork(s: Session): Promise<boolean> {
    if (!s.isolated || !s.branch || !existsSync(s.worktreePath)) return false;
    const dirty = await this.git(s.worktreePath, ["status", "--porcelain"]);
    if (dirty === null || dirty.trim() !== "") return true;
    // `@{upstream}` rather than a guessed `origin/<branch>`: it follows the branch's real tracking
    // ref. No upstream at all (never pushed) is itself unsynced — unless the branch has no commits
    // beyond its base, in which case there is nothing to push and nothing to lose.
    const ahead = await this.git(s.worktreePath, ["rev-list", "--count", "@{upstream}..HEAD"]);
    if (ahead !== null) return Number(ahead.trim()) > 0;
    // No upstream and no base to measure against — no evidence either way, so: unsynced.
    if (!s.baseBranch) return true;
    const unpushed = await this.git(s.worktreePath, [
      "rev-list",
      "--count",
      `${s.baseBranch}..HEAD`,
    ]);
    return unpushed === null || Number(unpushed.trim()) > 0;
  }

  /**
   * "merged" / "closed" / "none" → the PR is settled and this session is free to go. An OPEN PR is
   * not: archiving drops the session from the poller, the critic, autopilot and the merge train,
   * all of which filter to active sessions, so its PR would silently stop being carried anywhere.
   * A forge that errors or is absent answers "unknown", which spares the session.
   */
  private async prSettled(s: Session): Promise<"settled" | "open" | "unknown"> {
    if (!s.branch) return "settled"; // no branch ⇒ no PR was ever opened from this session
    const forge = this.deps.resolveForge(s.repoPath);
    if (!forge) return "unknown";
    try {
      return (await forge.prStatus(s.branch)).state === "open" ? "open" : "settled";
    } catch {
      return "unknown";
    }
  }

  /** Every gate, in cheapest-first order. `null` ⇒ archive it. */
  private async blockedBy(s: Session, livenessFresh: boolean): Promise<SkipReason | null> {
    if (!this.isSettledHusk(s, livenessFresh)) return "liveness";
    if (this.hasWorkInFlight(s)) return "inflight";
    if (!this.deps.hasConversation(s)) return "unrestorable";
    if (await this.hasUnsyncedWork(s)) return "unsynced";
    const pr = await this.prSettled(s);
    if (pr === "open") return "pr-open";
    if (pr === "unknown") return "pr-unknown";
    return null;
  }

  /**
   * Retire one session. The ordering is load-bearing at BOTH ends, and the claim stamp has to sit
   * between them:
   *
   *  - AFTER the archive resolves, because `retainClaimOnArchive` is a one-shot flag consumed by
   *    the next `session:archived` for that id. Stamping first and then throwing would leave it
   *    set on a still-live session, and the operator's own later close — a genuine ABANDON — would
   *    be silently converted into a retire: the issue keeps `shepherd:active` and is never
   *    re-queued. `DrainService.doRetire` returns from its catch before stamping for this reason,
   *    and the relaunch route in `server.ts` names the hazard outright.
   *  - BEFORE `emitArchived`, because `DrainService.onArchived` consumes the flag synchronously.
   *
   * `dropPrCache` + `emitArchived` mirror what the operator's own close route does, so every
   * `session:archived` consumer stays correct.
   */
  private async archiveOne(s: Session): Promise<void> {
    await this.deps.archive(s.id, "stale");
    this.deps.retainClaim(s.id);
    this.deps.dropPrCache(s.id);
    this.deps.emitArchived(s.id);
  }

  async tick(): Promise<void> {
    // `service.archive` closes the session's herdr tab, and the driver fails fast while herdr is
    // mid-update — so a sweep here would spend its whole budget on throws. Every periodic loop
    // that shells out to herdr pauses the same way.
    if (this.running || !this.enabled() || maintenance.active) return;
    this.running = true;
    try {
      const candidates = this.candidates();
      if (candidates.length === 0) return;
      // One freshness reading for the whole tick: the gate is about the age of the SWEEP that
      // produced the verdicts, and re-reading it per session would only let it drift mid-loop.
      const livenessFresh = this.now() - this.deps.livenessFreshAt() <= livenessMaxAgeMs();
      const skips = new Map<SkipReason, number>();
      const archived: string[] = [];
      for (const s of candidates) {
        if (archived.length >= this.maxArchivesPerTick) break;
        const blocked = await this.blockedBy(s, livenessFresh);
        if (blocked) {
          skips.set(blocked, (skips.get(blocked) ?? 0) + 1);
          continue;
        }
        try {
          await this.archiveOne(s);
          archived.push(s.id);
        } catch (err) {
          // One session's teardown failing must not abort the sweep; its row stays live and the
          // next tick retries it.
          skips.set("failed", (skips.get("failed") ?? 0) + 1);
          console.warn(`[auto-archive] archiving ${s.id} failed:`, err);
        }
      }
      // Report the SCOPE, not just the action (the #2029 lesson): a sweep whose gates have
      // silently collapsed to "skip everything" must not look identical in the journal to one
      // with nothing to do.
      const detail = [...skips].map(([r, n]) => `${r}=${n}`).join(" ");
      console.log(
        `[auto-archive] ${candidates.length} settled candidate(s) — archived ${archived.length}` +
          (detail ? `, skipped ${detail}` : ""),
      );
    } finally {
      this.running = false;
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
