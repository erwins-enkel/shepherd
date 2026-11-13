/**
 * The machine that RAN an epic child settles it once the epic's leading machine has merged it
 * (#3016, `POST /api/sessions/:id/settle-integrated`). The leading drain sends the child here as a
 * remote dispatch (src/drain-remote.ts), which creates an ordinary — not auto — session, so this
 * machine's drain never reaps it when its PR merges; the leader merges it into the epic branch,
 * records the integration and asks here. Nothing is taken on its word: this machine checks its own
 * session, reads the PR fresh from its forge (its poller's cache may be behind), and archives only a
 * session at rest, through `SessionService.archiveIfSettled`, which starts the archive in the same
 * tick as its last checks and holds every resume off while it runs.
 *
 * Settled like a drain-retired epic child here (#1037): archived `merged`, the issue's claim kept
 * and the issue left open — it closes only when the epic lands. Its manual steps are frozen into the
 * Owed lens first (idempotent with the merged event's own materialization).
 */
import { isEpicIntegrationBranch } from "./epic-branch";
import type { GitForge, GitState } from "./forge/types";
import { isUsagePaused } from "./schedule-pause";
import type { SessionService } from "./service";
import { isShelved } from "./shelve";
import type { SessionStore } from "./store";
import type { Session } from "./types";

/** Why a settle request is refused (409). `settling`: an archive of the session already runs. */
export type SettleRefusalCode = "settling" | "not_merged" | "not_epic_child" | "held" | "busy";

export type SettleOutcome =
  | { kind: "settled" }
  | { kind: "already" }
  | { kind: "not_found" }
  | { kind: "refused"; code: SettleRefusalCode };

export interface IntegratedChildSettlerDeps {
  store: Pick<SessionStore, "get">;
  service: Pick<SessionService, "archiveIfSettled">;
  /** The session's PR as this server's poller last saw it (`prCache.get`). */
  prOf: (id: string) => GitState | undefined;
  resolveForge: (repoPath: string) => GitForge | null;
  materializeManualSteps?: (s: Session, prNumber: number, prTitle: string) => void;
  /** `drain.retainClaim`: the archive keeps the issue's claim. */
  retainClaim: (id: string) => void;
  dropPrCache: (id: string) => void;
  emitArchived: (id: string) => void;
}

const REFUSALS: ReadonlySet<string> = new Set<SettleRefusalCode>([
  "settling",
  "not_merged",
  "not_epic_child",
  "held",
  "busy",
]);

/** What speaks against archiving the session as it is now: shelved or paused, or not at rest. */
export function restRefusal(s: Session): SettleRefusalCode | null {
  if (isShelved(s) || isUsagePaused(s)) return "held";
  return s.status === "idle" || s.status === "done" ? null : "busy";
}

export class IntegratedChildSettler {
  /** One settle per session at a time: a repeated request shares the running one's answer. */
  private readonly inFlight = new Map<string, Promise<SettleOutcome>>();

  constructor(private readonly deps: IntegratedChildSettlerDeps) {}

  /** Settle session `id`, whose PR `prNumber` (when given) the leading machine integrated. */
  settle(id: string, prNumber?: number): Promise<SettleOutcome> {
    const running = this.inFlight.get(id);
    if (running) return running;
    const p = this.settleNow(id, prNumber).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, p);
    return p;
  }

  private async settleNow(id: string, prNumber: number | undefined): Promise<SettleOutcome> {
    const s = this.deps.store.get(id);
    if (!s) return { kind: "not_found" };
    if (s.status === "archived") return { kind: "already" };
    if (s.issueNumber == null || s.misroutedTarget) return refused("not_epic_child");
    const git = this.deps.prOf(id);
    const own = git?.number ?? null;
    if (own == null || (prNumber !== undefined && prNumber !== own)) return refused("not_merged");
    const forge = this.deps.resolveForge(s.repoPath);
    const meta = await forge?.prReviewMeta?.(own).catch(() => null);
    if (meta?.state !== "merged") return refused("not_merged");
    if (!isEpicIntegrationBranch(meta.baseRefName)) return refused("not_epic_child");
    const r = await this.deps.service.archiveIfSettled(id, "merged", restRefusal, () =>
      this.deps.retainClaim(id),
    );
    if ("refused" in r) {
      if (r.refused === "already") return { kind: "already" };
      if (r.refused === "gone") return { kind: "not_found" };
      return refused(REFUSALS.has(r.refused) ? (r.refused as SettleRefusalCode) : "busy");
    }
    try {
      this.deps.materializeManualSteps?.(s, own, git?.title ?? "");
    } catch (err) {
      console.warn(`[settle] manual steps of ${id} not materialized:`, err);
    }
    this.deps.dropPrCache(id);
    this.deps.emitArchived(id);
    return { kind: "settled" };
  }
}

function refused(code: SettleRefusalCode): SettleOutcome {
  return { kind: "refused", code };
}
