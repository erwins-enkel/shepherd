/** Base-moved notice (#2589): tell a live agent when its base branch gained commits it doesn't
 *  have, so it stops building on a stale base without anyone looking.
 *
 *  A sweep (index.ts, every 2 min) fetches each (repo, base) once, then steers every eligible
 *  IDLE session — never mid-turn — with the new commits. At most one notice per session per
 *  THROTTLE_MS; commits that land in between are batched into the next one. The last tip a
 *  session was told about (or already contains) is persisted in `base_notices`, so a restart
 *  neither repeats a notice nor loses the anchor; with no row the anchor is the session's
 *  `baseCommit`.
 *
 *  Skipped: anything but idle, clean terminals, non-isolated sessions, sessions still planning,
 *  sessions whose PR already merged or closed (a manual session isn't reaped on merge, and its own
 *  squash commit on the base is never in HEAD — it would be told to rebase work that landed), and
 *  sessions whose open PR a rebase actor already owns (merge train / autopilot rebase steer) —
 *  those get their own rebase steer, so this would only double it. The fetch and log take a while
 *  and the PR cache lags a merge, so right before steering the PR is re-polled and the session
 *  re-read: one that merged, started a turn or was archived meanwhile is left alone. */
import type { SessionStore } from "./store";
import type { Session } from "./types";
import { fenceUntrusted } from "./untrusted";

export const BASE_DRIFT_INTERVAL_MS = 2 * 60_000;
export const THROTTLE_MS = 30 * 60_000;
/** Commit lines shown per notice; the rest are counted. */
export const MAX_LISTED = 20;

export interface BaseDriftDeps {
  store: Pick<SessionStore, "get" | "list" | "getBaseNotice" | "setBaseNotice">;
  git: {
    /** Fetched `origin/<base>` tip, or null when unknown. */
    baseTip(repoPath: string, baseBranch: string): Promise<string | null>;
    /** Commits on `tip` not in the session's HEAD nor in `exclude`; null when git can't answer. */
    missing(
      s: Session,
      tip: string,
      exclude: string | null,
      max: number,
    ): Promise<{ total: number; lines: string[] } | null>;
  };
  /** Deliver an automatic steer; false when it didn't land (dead pane, no capacity). */
  steer(id: string, text: string): Promise<boolean>;
  /** True when a rebase actor owns this session's open PR. */
  rebaseOwned(s: Session): boolean;
  /** The session's cached PR state; undefined when unknown. */
  prState(id: string): "none" | "open" | "merged" | "closed" | undefined;
  /** Awaited, undebounced PR re-poll (PrPoller.pollNow): the cache lags a merge by minutes. */
  refreshPr(id: string): Promise<void>;
  now?: () => number;
}

export function baseMovedSteer(baseBranch: string, total: number, lines: string[]): string {
  const more = total > lines.length ? `\n…and ${total - lines.length} more` : "";
  return [
    `Heads-up: your base branch moved. origin/${baseBranch} has ${total} new commit(s) your branch`,
    "does not have yet:",
    fenceUntrusted("base commits", lines.join("\n") + more),
    "Check whether they affect your work. If they do, fetch origin and rebase onto",
    `origin/${baseBranch} (never merge it in), resolve any conflicts and re-run the relevant`,
    "checks; if your branch is already pushed, push with --force-with-lease. If they don't, carry",
    "on as before — if you were waiting for the operator, keep waiting.",
  ].join("\n");
}

function eligible(s: Session): boolean {
  return (
    s.status === "idle" &&
    s.terminal !== true &&
    s.shelved !== true &&
    s.isolated &&
    !!s.branch &&
    !!s.baseCommit &&
    s.planPhase !== "planning"
  );
}

export class BaseDriftService {
  #running = false;

  constructor(private readonly deps: BaseDriftDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** One pass. Re-entrant calls while a pass is still running are dropped. */
  async sweep(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const tips = new Map<string, Promise<string | null>>();
      for (const s of this.deps.store.list({ activeOnly: true })) {
        if (!eligible(s) || this.settled(s.id) || this.throttled(s.id)) continue;
        if (this.deps.rebaseOwned(s)) continue;
        const key = `${s.repoPath}\0${s.baseBranch}`;
        if (!tips.has(key)) tips.set(key, this.deps.git.baseTip(s.repoPath, s.baseBranch));
        const tip = await tips.get(key)!;
        if (tip) await this.consider(s, tip);
      }
    } finally {
      this.#running = false;
    }
  }

  /** Fresh re-check right before a steer: the PR re-polled, the session re-read. */
  private async stillDue(id: string): Promise<boolean> {
    if (!this.settled(id)) await this.deps.refreshPr(id).catch(() => undefined);
    const s = this.deps.store.get(id);
    return !!s && eligible(s) && !this.settled(id) && !this.deps.rebaseOwned(s);
  }

  private settled(id: string): boolean {
    const state = this.deps.prState(id);
    return state === "merged" || state === "closed";
  }

  private throttled(id: string): boolean {
    const at = this.deps.store.getBaseNotice(id)?.notifiedAt;
    return at != null && this.now() - at < THROTTLE_MS;
  }

  private async consider(s: Session, tip: string): Promise<void> {
    const anchor = this.deps.store.getBaseNotice(s.id)?.sha ?? s.baseCommit ?? null;
    if (tip === anchor) return;
    const missing = await this.deps.git.missing(s, tip, anchor, MAX_LISTED);
    if (!missing) return;
    // Nothing new for this session (it already rebased, or was told): advance silently.
    if (missing.total === 0) return this.deps.store.setBaseNotice(s.id, tip, null);
    if (!(await this.stillDue(s.id))) return;
    const text = baseMovedSteer(s.baseBranch, missing.total, missing.lines);
    if (!(await this.deps.steer(s.id, text))) return;
    console.log(`[base-drift] notice ${s.desig} ${s.baseBranch} +${missing.total}`);
    this.deps.store.setBaseNotice(s.id, tip, this.now());
  }
}
