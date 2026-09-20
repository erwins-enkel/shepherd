import Foundation
import ShepherdKit

/// Per-session signals for the pure cascade; `now` is a millisecond timestamp.
struct HerdContext: Sendable {
    /// S3's display-only working-while-blocked upgrade.
    var workingBlocked: [String: Bool] = [:]
    /// Critic OR plan review in flight (Herd.svelte); S8 supplies the plan half.
    var reviewing: Bool = false
    var verdict: ReviewVerdict? = nil
    /// S8 injects the planning-phase, non-dismissed, non-stalled plan rework predicate.
    var planRework: Bool = false
    var now: Int = 0

    static let idle = HerdContext()
}

/// stage.ts:6 — the five pipeline segments, independent of HerdStage's fourteen groups.
enum StepperStage: String, CaseIterable, Sendable {
    case planning, implementing, pr, review, ready

    var index: Int {
        switch self {
        case .planning: 0
        case .implementing: 1
        case .pr: 2
        case .review: 3
        case .ready: 4
        }
    }
}

enum StepperReviewTint: String, Sendable {
    case none, reviewing, changes, approved, error
}

enum PrReadinessBlock: String, Sendable {
    case draft, conflict, behind, blocked
}

enum AddressStallStatus: String, Sendable {
    case round, final, stalled
}

/// stage.ts:14-28. These are derived display values, never server payloads.
struct StepperInfo: Equatable, Sendable {
    enum Terminal: String, Sendable { case merged, closed }

    let reached: StepperStage
    var index: Int { reached.index }
    let ci: Components.Schemas.ChecksState
    let terminal: Terminal?
    let review: StepperReviewTint
    let planningSkipped: Bool
}

/// Candidate producer for HerdPartition's existing precedence ranking. Every rule mirrors
/// ui/src/lib/components/herd-partition.ts:116-183; no store reads or UI dependencies.
enum HerdClassifier {
    /// checks-cleared.ts:7-9: success OR (none AND noCi). Unknown/pending/failure never clear.
    static func checksCleared(_ checks: Components.Schemas.ChecksState, noCi: Bool) -> Bool {
        if checks.known == .success { return true }
        return noCi && checks.known == ChecksStateKnown.none
    }

    /// herd-partition.ts:137-151: open AND cleared AND not running AND not blocked
    /// AND not reviewing AND not reworking. Raw status keeps live work out of handoff groups.
    static func isIdleOpenCleared(_ session: Session, git: GitState?, ctx: HerdContext) -> Bool {
        guard let git, git.state.known == .open,
            checksCleared(git.checks, noCi: git.noCi ?? false),
            session.status.known != .running, session.status.known != .blocked,
            !ctx.reviewing
        else { return false }
        return !isReworkRunning(session, verdict: ctx.verdict, now: ctx.now,
            planRework: ctx.planRework, workingBlocked: ctx.workingBlocked)
    }

    /// herd-partition.ts:116-134, first match wins. The git-free checks are interleaved:
    /// merged > merging > rework block > protection > ready > review > rework > CI.
    static func terminalStage(_ session: Session, git: GitState?, ctx: HerdContext) -> HerdStage? {
        if git?.state.known == .merged { return .merged }
        if HerdPartition.isMerging(session, now: ctx.now) { return .merging }
        let idle = isIdleOpenCleared(session, git: git, ctx: ctx)
        if idle, git?.reviewBlock != nil { return .needsRework }
        if idle, git?.reviewBlock == nil, git?.mergeStateStatus?.known == .blocked {
            return .branchProtectionBlocked
        }
        // Ready needs no PR; it outranks an in-flight review and either CI state.
        if session.readyToMerge { return .ready }
        if ctx.reviewing { return .reviewerRunning }
        if isReworkRunning(session, verdict: ctx.verdict, now: ctx.now,
            planRework: ctx.planRework, workingBlocked: ctx.workingBlocked) {
            return .reworkRunning
        }
        if git?.state.known == .open, git?.checks.known == .pending { return .ciRunning }
        if git?.state.known == .open, git?.checks.known == .failure { return .ciFailed }
        return nil
    }

    /// herd-partition.ts:156-161: draft > reviewer > merger > operator's turn.
    static func handoffStage(_ git: GitState) -> HerdStage {
        if git.isDraft == true { return .draftAwaitingSignoff }
        switch git.handoff?.known {
        case .reviewer: return .waitingOnReviewer
        case .merger: return .waitingOnMerger
        default: return .awaitingMerge
        }
    }

    /// Entry point used by HerdSignals and the stream's integration checks.
    static func stage(_ session: Session, git: GitState?, ctx: HerdContext) -> HerdStage {
        stageOf(session, git: git, ctx: ctx)
    }

    /// herd-partition.ts:165-183: terminal cascade, then green-idle handoff, then active.
    /// The raw status check is intentional (:174-176); displayStatus must not drive handoff.
    static func stageOf(_ session: Session, git: GitState?, ctx: HerdContext) -> HerdStage {
        if let terminal = terminalStage(session, git: git, ctx: ctx) { return terminal }
        guard let git, git.state.known == .open,
            checksCleared(git.checks, noCi: git.noCi ?? false),
            session.status.known != .running, session.status.known != .blocked
        else { return .active }
        return handoffStage(git)
    }

    /// rework-running.ts:16-33: display-running AND (plan rework OR live critic rework).
    /// Unlike handoff, this uses displayStatus: a working-while-blocked session IS working.
    /// Critic head freshness is not part of this web predicate; its loop stall status is.
    static func isReworkRunning(
        _ session: Session, verdict: ReviewVerdict?, now: Int, planRework: Bool = false,
        workingBlocked: [String: Bool] = [:]
    ) -> Bool {
        guard HerdPartition.displayStatus(session, workingBlocked: workingBlocked).known == .running
        else { return false }
        if planRework { return true }
        guard let verdict, verdict.decision.known == .changesRequested, verdict.dismissed != true
        else { return false }
        return addressStallStatus(verdict, now: now) != .stalled
    }

    /// review-status.ts:17-23: below cap OR empty findings → round; no pending final round
    /// OR elapsed > timeout → stalled; otherwise final (including exactly at the timeout).
    static func addressStallStatus(_ verdict: ReviewVerdict, now: Int) -> AddressStallStatus {
        let round = min(verdict.addressRound, verdict.addressCap)
        if round < verdict.addressCap || verdict.findings.isEmpty { return .round }
        if !verdict.finalRoundPending { return .stalled }
        if now - verdict.updatedAt > verdict.finalRoundTimeoutMs { return .stalled }
        return .final
    }

    /// verdict-freshness.ts:23-33: only two nonempty, different heads on an OPEN PR prove
    /// staleness. Unknown/empty heads and non-open PRs retain the blocking verdict.
    static func verdictStale(_ verdict: ReviewVerdict?, git: GitState?) -> Bool {
        guard let verdict, let git, git.state.known == .open,
            !verdict.headSha.isEmpty, let currentHead = git.headSha, !currentHead.isEmpty
        else { return false }
        return verdict.headSha != currentHead
    }

    /// pr-ready.ts:26-33 and pr-conflict.ts:24-26: not open → none, then draft, conflict,
    /// behind, blocked. A draft masks mergeable:false; dirty is itself a definite conflict.
    static func prReadinessBlock(_ git: GitState?) -> PrReadinessBlock? {
        guard let git, git.state.known == .open else { return nil }
        if git.isDraft == true { return .draft }
        if git.mergeStateStatus?.known == .dirty || git.mergeable == false { return .conflict }
        if git.mergeStateStatus?.known == .behind { return .behind }
        if git.mergeStateStatus?.known == .blocked { return .blocked }
        return nil
    }

    /// stage.ts:36-44: forge approval OR commented critic verdict at the known current head.
    private static func isReviewOK(_ git: GitState?, verdict: ReviewVerdict?) -> Bool {
        if git?.latestReview?.state.known == .approved { return true }
        guard let head = git?.headSha else { return false }
        return verdict?.decision.known == .commented && verdict?.headSha == head
    }

    /// stage.ts:50-59: open, success, explicitly mergeable, non-draft, no readiness block,
    /// approved. Unlike herd handoff, this web rule deliberately does not use noCi.
    private static func isDerivedReady(_ git: GitState?, reviewOK: Bool) -> Bool {
        guard let git else { return false }
        return git.state.known == .open && git.checks.known == .success && git.mergeable == true
            && git.isDraft != true && prReadinessBlock(git) == nil && reviewOK
    }

    /// stage.ts:63-81: reviewing > fresh critic/human changes > approval > fresh error > none.
    /// A stale critic verdict never clears a separate human forge review.
    private static func reviewTint(
        reviewing: Bool, reviewOK: Bool, verdict: ReviewVerdict?, git: GitState?
    ) -> StepperReviewTint {
        if reviewing { return .reviewing }
        let stale = verdictStale(verdict, git: git)
        if (verdict?.decision.known == .changesRequested && !stale)
            || git?.latestReview?.state.known == .changesRequested { return .changes }
        if reviewOK { return .approved }
        if verdict?.decision.known == .error && !stale { return .error }
        return .none
    }

    /// stage.ts:83-117: furthest pipeline stage reached, independent of herd group. Even a
    /// stale verdict proves review was reached; merged/manual ready wins over every segment.
    static func deriveStage(
        session: Session, git: GitState?, verdict: ReviewVerdict?, reviewing: Bool
    ) -> StepperInfo {
        var reached: StepperStage = session.planPhase?.known == .planning ? .planning : .implementing
        if git?.state.known == .open { reached = .pr }
        if reviewing || verdict != nil || git?.latestReview != nil { reached = .review }
        let reviewOK = isReviewOK(git, verdict: verdict)
        if session.readyToMerge || git?.state.known == .merged || isDerivedReady(git, reviewOK: reviewOK) {
            reached = .ready
        }
        let terminal: StepperInfo.Terminal?
        switch git?.state.known {
        case .merged: terminal = .merged
        case .closed: terminal = .closed
        default: terminal = nil
        }
        return StepperInfo(reached: reached, ci: git?.checks ?? .init(known: .none),
            terminal: terminal,
            review: reviewTint(reviewing: reviewing, reviewOK: reviewOK, verdict: verdict, git: git),
            planningSkipped: session.planPhase == nil)
    }
}
