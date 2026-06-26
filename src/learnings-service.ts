import type { SessionStore } from "./store";
import type { EventHub } from "./events";
import type { EvidenceItem, Learning, SignalKind } from "./types";
import { planHouseRulesInjection, prioritize } from "./house-rules";

/** Flatten + clip a signal payload to a one-line evidence excerpt for the drawer. */
function evidenceExcerpt(payload: string, max = 140): string {
  const flat = payload.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return [...flat].slice(0, max - 1).join("") + "…";
}

export type ApplyMergeResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "already-resolved" | "stale" };

/** A pending learning with its evidence resolved — both provenance fields (optional on
 *  Learning, since they're only attached here) are always present on this projection. */
export type PendingLearningRow = Learning & {
  evidenceKinds: Partial<Record<SignalKind, number>>;
  evidenceDetail: EvidenceItem[];
};

/** Narrow store interface this service needs — the seam, kept small. */
type LearningsStore = Pick<
  SessionStore,
  | "getMergeSuggestion"
  | "getLearning"
  | "mergeLearning"
  | "retireLearningMerged"
  | "setMergeSuggestionStatus"
  | "pendingLearningCount"
  | "listPendingLearnings"
  | "getSignalsByIds"
  | "get"
  | "listMergeSuggestions"
  | "setLearningStatus"
  | "setLearningScope"
  | "revertTrial"
  | "restoreLearning"
  | "listRepoPathsWithInjectableLearnings"
  | "listRepoPathsWithRetiredLearnings"
  | "listActiveLearnings"
  | "listRetiredLearnings"
  | "getRetiredSeenAt"
  | "getRepoConfig"
>;

/**
 * Deep module owning the learnings cluster (#1092) — every learnings mutation
 * plus the cluster's read projections. It absorbs the multi-call store sequences
 * that previously lived inline in `src/server.ts` route handlers, so the handlers
 * shrink to validate-and-delegate and the store stops leaking row ordering.
 *
 * The single most-repeated sequence — `events.emit("learnings:update", { pending:
 * store.pendingLearningCount() })` — lived in ~10 routes; it now has exactly one
 * home (`emitPending`), and every mutation method emits through it on (and only
 * on) a real store change, preserving the original conditional-emit semantics.
 *
 * HTTP-agnostic: methods return domain values / shaped DTO rows, never a Response
 * or status code — so the service is testable directly, without booting makeApp.
 *
 * DEVIATION (flagged per house rules): issue #1092 says "give `src/service.ts` deep
 * methods". This is a NEW module instead — `SessionService` (service.ts) is session-
 * centric and ~2.9k lines; the repo's idiom is one domain-service per file (review.ts,
 * plan-gate.ts, promote.ts, house-rules.ts). Same service seam, focused home.
 */
export class LearningsService {
  constructor(
    private store: LearningsStore,
    private events: Pick<EventHub, "emit">,
  ) {}

  /** The single emit site: refresh the drawer/badge with the live pending count. */
  emitPending(): void {
    this.events.emit("learnings:update", { pending: this.store.pendingLearningCount() });
  }

  /**
   * Apply an intra-repo merge suggestion: consolidate the group into the survivor
   * (counters preserved) and soft-retire the other members with a citation, after
   * re-validating every member is still active (a member promoted/retired/edited
   * since the pass invalidates the merge → the suggestion is dismissed as stale).
   * Emits on success AND on the stale-dismiss (both mutate the store); silent on
   * the not-found / already-resolved branches (no mutation).
   */
  applyMergeSuggestion(id: string): ApplyMergeResult {
    const s = this.store.getMergeSuggestion(id);
    if (!s || s.kind !== "intra" || !s.targetId) return { ok: false, reason: "not-found" };
    if (s.status !== "pending") return { ok: false, reason: "already-resolved" };
    const members = [s.targetId, ...s.sourceIds].map((mid) => this.store.getLearning(mid));
    if (members.some((m) => !m || m.status !== "active")) {
      // A member changed since the pass — the merge no longer applies.
      this.store.setMergeSuggestionStatus(id, "dismissed");
      this.emitPending();
      return { ok: false, reason: "stale" };
    }
    this.store.mergeLearning(s.targetId, s.mergedRule, s.mergedRationale || undefined);
    for (const sid of s.sourceIds) this.store.retireLearningMerged(sid, s.targetId);
    this.store.setMergeSuggestionStatus(id, "applied");
    this.emitPending();
    return { ok: true };
  }

  /** Dismiss a merge suggestion (intra or cross). Returns false (no emit) when not found. */
  dismissMergeSuggestion(id: string): boolean {
    const updated = this.store.setMergeSuggestionStatus(id, "dismissed");
    if (!updated) return false;
    this.emitPending();
    return true;
  }

  /**
   * Approve (→active) or dismiss a proposed rule. On approve, an edited rule is
   * normalized to addLearning's contract (trim + 240 cap); an empty edit falls
   * back to the stored rule. Returns null (no emit) when the rule isn't found.
   */
  setStatus(id: string, action: "approve" | "dismiss", ruleEdit?: string): Learning | null {
    let rule: string | undefined;
    if (action === "approve" && typeof ruleEdit === "string") {
      const trimmed = ruleEdit.trim().slice(0, 240);
      if (trimmed) rule = trimmed;
    }
    const status = action === "approve" ? "active" : "dismissed";
    const updated = this.store.setLearningStatus(id, status, rule);
    if (!updated) return null;
    this.emitPending();
    return updated;
  }

  /** Replace a rule's glob scope (empty = Always-rule). Null (no emit) when not found. */
  setScope(id: string, globs: string[]): Learning | null {
    const updated = this.store.setLearningScope(id, globs);
    if (!updated) return null;
    this.emitPending();
    return updated;
  }

  /** Revert an auto-trial back to proposed/dismissed. Null (no emit) when not a revertable trial. */
  revertTrial(id: string, target: "proposed" | "dismissed"): Learning | null {
    const updated = this.store.revertTrial(id, target);
    if (!updated) return null;
    this.emitPending();
    return updated;
  }

  /** Restore a retired rule to its previous status. Null (no emit) when not found. */
  restore(id: string): Learning | null {
    const updated = this.store.restoreLearning(id);
    if (!updated) return null;
    this.emitPending();
    return updated;
  }

  /**
   * All proposed rules across repos, each with its cited signals resolved into
   * provenance (per-kind breakdown + source session designation + excerpt) — the
   * drawer's N+N+1 read projection.
   */
  pendingWithEvidence(): PendingLearningRow[] {
    return this.store.listPendingLearnings().map((l) => {
      const evidenceKinds: Partial<Record<SignalKind, number>> = {};
      const evidenceDetail = this.store.getSignalsByIds(l.evidence).map((s) => {
        evidenceKinds[s.kind] = (evidenceKinds[s.kind] ?? 0) + 1;
        return {
          id: s.id,
          kind: s.kind,
          desig: s.sessionId ? (this.store.get(s.sessionId)?.desig ?? null) : null,
          excerpt: evidenceExcerpt(s.payload),
          ts: s.ts,
        };
      });
      return { ...l, evidenceKinds, evidenceDetail };
    });
  }

  /**
   * Cross-repo injected/over-budget view: one entry per repo with ≥1
   * active/promoted or retired rule. Shares the planner (planHouseRulesInjection)
   * with the spawn-time injection so the budget math can't drift. `budgetChars`
   * is supplied by the caller (the route passes config.houseRulesBudgetChars) so
   * this service stays config-free.
   */
  injectableOverview(budgetChars: number) {
    // Union of repos with injectable (active/promoted) or retired rules — deduped,
    // injectable-first order (so a retired-only repo still appears for the banner).
    const injectableRepos = this.store.listRepoPathsWithInjectableLearnings();
    const retiredRepos = this.store.listRepoPathsWithRetiredLearnings();
    const seen = new Set(injectableRepos);
    const allRepos = [...injectableRepos, ...retiredRepos.filter((r) => !seen.has(r))];
    return allRepos.map((repoPath) => {
      const rules = this.store.listActiveLearnings(repoPath);
      const retired = this.store.listRetiredLearnings(repoPath);
      const seenAt = this.store.getRetiredSeenAt(repoPath);
      const unseenRetired = retired.filter((r) => (r.retiredAt ?? 0) > seenAt).length;
      const enabled = this.store.getRepoConfig(repoPath).learningsEnabled;
      if (!enabled) {
        // Injection disabled: skip the planner; every rule uninjected, used 0.
        return {
          repoPath,
          enabled,
          budgetChars,
          usedChars: 0,
          rules: prioritize(rules).map((r) => ({
            ...r,
            injected: false,
            scoped: r.scopeGlobs.length > 0,
          })),
          retired,
          unseenRetired,
        };
      }
      // No session here, so no target files: planHouseRulesInjection gates every scoped
      // rule into `scoped` (its globs decide injection only at spawn). usedChars therefore
      // reflects the Always-rules baseline only — scoped rules never count against budget.
      const plan = planHouseRulesInjection(rules, budgetChars);
      const injectedIds = new Set(plan.injected.map((r) => r.id));
      // injected (priority order), then dropped (over budget), then scope-gated — same
      // ordering the drawer renders; `scoped` marks the glob-conditional rules.
      return {
        repoPath,
        enabled,
        budgetChars,
        usedChars: plan.usedChars,
        rules: [...plan.injected, ...plan.dropped, ...plan.scoped].map((r) => ({
          ...r,
          injected: injectedIds.has(r.id),
          scoped: r.scopeGlobs.length > 0,
        })),
        retired,
        unseenRetired,
      };
    });
  }

  /**
   * Pending Phase-4 merge suggestions (intra + cross), each with its member rules
   * hydrated for the drawer. Stale members (no longer present) are dropped here;
   * the daily pass sweeps fully-broken suggestions.
   */
  mergeSuggestionsWithMembers() {
    return this.store.listMergeSuggestions({ status: "pending" }).map((s) => {
      const memberIds = [...(s.targetId ? [s.targetId] : []), ...s.sourceIds];
      const members = memberIds
        .map((mid) => this.store.getLearning(mid))
        .filter((l): l is Learning => l !== null)
        .map((l) => ({ id: l.id, repoPath: l.repoPath, rule: l.rule, status: l.status }));
      return { ...s, members };
    });
  }
}
