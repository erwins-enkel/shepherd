import Foundation
import Observation
import ShepherdKit
import SwiftUI

public struct PlanTabWriter: Sendable {
    var review: @MainActor @Sendable (String) async throws -> PlanReviewResult
    var release: @MainActor @Sendable (String) async throws -> Bool
    var quota: @MainActor @Sendable (String, Bool) async throws -> PlanQuotaResult

    public static func live(_ client: ShepherdClient) -> Self {
        Self(review: { try await client.reviewPlan(sessionID: $0) },
             release: { try await client.releasePlanGate(sessionID: $0) },
             quota: { id, resume in
                 if resume { return try await client.resumePlanQuota(sessionID: id) }
                 return try await client.dismissPlanQuota(sessionID: id)
             })
    }
}

/// UI request state, scoped to one session and activation. Timers are cancellable;
/// generations also reject a late HTTP result after the tab disappears.
@Observable @MainActor
public final class PlanTabActions {
    public var session: Session {
        didSet { if session != oldValue { cancelConfirmation() } }
    }
    public let model: PlanModel
    private(set) var busy = false
    private(set) var awaitingReview = false
    public private(set) var outcome: StaticString?
    public private(set) var planUnavailable = false
    public private(set) var heldAtCap = false
    public private(set) var quotaBusy: Bool?
    public private(set) var quotaOutcome: StaticString?
    public private(set) var releaseNote: StaticString?
    public var confirming = false
    private var pendingGate: PlanGate?
    private let writer: PlanTabWriter
    private let isCurrent: @MainActor () -> Bool
    private let sleep: @MainActor (Duration) async throws -> Void
    private var generation = 0
    private var bridgeTask: Task<Void, Never>?
    private var outcomeTask: Task<Void, Never>?

    public init(session: Session, model: PlanModel, writer: PlanTabWriter,
         isCurrent: @escaping @MainActor () -> Bool = { true },
         sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.session = session
        self.model = model
        self.writer = writer
        self.isCurrent = isCurrent
        self.sleep = sleep
    }

    public var gate: PlanGate? { model.gates[session.id] }
    public var reviewing: Bool { model.reviewing.contains(session.id) }
    var effectiveSession: Session {
        var value = session
        if model.releasedGates.contains(session.id) { value.planPhase = .init(known: .executing) }
        return value
    }
    public var inFlight: Bool { busy || reviewing || awaitingReview }
    public var chip: PlanGateChip { .chip(session: effectiveSession, gate: gate, reviewing: reviewing) }
    public var canReview: Bool { PlanGateChip.canOfferPlanReview(session: effectiveSession, gate: gate) }
    public var reviewBlock: PlanReviewBlockReason? {
        PlanGateChip.canTriggerPlanReview(session: effectiveSession, gate: gate, reviewing: inFlight)
    }
    public var canRelease: Bool { model.canRelease(session) }
    public var stalled: Bool {
        PlanGateChip.canShowPlanStallActions(session: effectiveSession, gate: gate, reviewing: inFlight)
    }
    public var answerContext: QuestionAnswerContext? {
        effectiveSession.planPhase?.known == .planning
            ? .init(sessionID: session.id, locked: inFlight || quotaBusy != nil) : nil
    }
    public var confirmationMessage: String { L.t("planpanel_native_go_confirm", session.name) }

    public func reconcile() {
        if reviewing {
            bridgeTask?.cancel()
            awaitingReview = false
            setOutcome(nil)
            planUnavailable = false
            quotaOutcome = nil
        }
        if gate != nil || !canReview { planUnavailable = false }
        if gate?.approved != false || (gate?.round ?? 0) < (gate?.cap ?? 0) { heldAtCap = false }
        if !canRelease || pendingGate != gate { cancelConfirmation() }
    }

    public func review() async {
        guard isCurrent(), canReview, reviewBlock == nil, !inFlight, quotaBusy == nil else { return }
        let mine = generation
        busy = true
        setOutcome(nil)
        planUnavailable = false
        defer { if mine == generation { busy = false } }
        do {
            let result = try await writer.review(session.id)
            guard valid(mine) else { return }
            switch result.status.known {
            case .started, .startedAtCap:
                heldAtCap = result.status.known == .startedAtCap
                if !reviewing { startBridge() }
            case .planUnavailable: if !reviewing { planUnavailable = true }
            case .skipped: if !reviewing { setOutcome("planpanel_review_nothing_to_review") }
            case .errorWorktree: setOutcome("planpanel_review_failed_worktree")
            case .errorAuth: setOutcome("planpanel_review_failed_auth")
            case .errorSpawn, nil: setOutcome("planpanel_review_failed_spawn")
            }
            reconcile()
        } catch {
            guard valid(mine) else { return }
            setOutcome("planpanel_review_failed_spawn")
            reconcile()
        }
    }

    public func requestConfirmation() {
        guard isCurrent(), canRelease, !inFlight, quotaBusy == nil else { return }
        pendingGate = gate
        confirming = true
    }

    public func cancelConfirmation() { confirming = false; pendingGate = nil }

    public func release() async {
        let consent = pendingGate
        cancelConfirmation()
        guard isCurrent(), let consent, consent == gate, canRelease,
              !inFlight, quotaBusy == nil else { return }
        let mine = generation
        busy = true
        releaseNote = nil
        defer { if mine == generation { busy = false } }
        do {
            let released = try await writer.release(session.id)
            guard valid(mine) else { return }
            if released { model.markReleased(session.id) }
            else { releaseNote = "planpanel_native_not_releasable" }
        } catch {
            guard valid(mine) else { return }
            releaseNote = "planpanel_native_go_failed"
        }
    }

    public func quota(resume: Bool) async {
        guard isCurrent(), stalled, !inFlight, quotaBusy == nil else { return }
        let mine = generation
        quotaBusy = resume
        quotaOutcome = nil
        defer { if mine == generation { quotaBusy = nil } }
        do {
            let result = try await writer.quota(session.id, resume)
            guard valid(mine) else { return }
            switch result.status.known {
            case .resumed where resume, .dismissed where !resume:
                model.requestRefresh()
            case .unreachable: quotaOutcome = "planpanel_quota_unreachable"
            case .notStalled: quotaOutcome = "planpanel_quota_not_stalled"
            default: quotaOutcome = "planpanel_quota_failed"
            }
            reconcile()
        } catch {
            guard valid(mine) else { return }
            quotaOutcome = "planpanel_quota_failed"
            reconcile()
        }
    }

    public func teardown() {
        generation &+= 1
        bridgeTask?.cancel()
        outcomeTask?.cancel()
        bridgeTask = nil
        outcomeTask = nil
        outcome = nil
        awaitingReview = false
        busy = false
        quotaBusy = nil
        cancelConfirmation()
    }

    private func valid(_ mine: Int) -> Bool { mine == generation && isCurrent() && !Task.isCancelled }

    private func startBridge() {
        bridgeTask?.cancel()
        awaitingReview = true
        let mine = generation
        bridgeTask = Task { [weak self, sleep] in
            do { try await sleep(.milliseconds(4_000)) } catch { return }
            guard let self, self.valid(mine) else { return }
            self.awaitingReview = false
        }
    }

    private func setOutcome(_ key: StaticString?) {
        outcomeTask?.cancel()
        outcome = key
        guard key != nil else { return }
        let mine = generation
        outcomeTask = Task { [weak self, sleep] in
            do { try await sleep(.milliseconds(6_000)) } catch { return }
            guard let self, self.valid(mine) else { return }
            self.outcome = nil
        }
    }
}

/// A live triple is authoritative only when its provider resolved to a CLI.
public enum PlanEnvironment {
    public static func reviewer(live: ReviewerEnv?, gate: PlanGate?) -> String {
        if let provider = live?.provider {
            return label(provider: provider.rawValue, model: live?.model, effort: live?.effort)
        }
        return label(provider: gate?.reviewerProvider?.rawValue, model: gate?.reviewerModel, effort: gate?.reviewerEffort)
    }

    public static func label(provider: String?, model: String?, effort: String?) -> String {
        guard let provider else {
            return [L.t("planpanel_env_unavailable"), model, effort].compactMap { $0 }.joined(separator: " · ")
        }
        let cli: String
        switch provider {
        case "claude": cli = L.t("agent_provider_claude")
        case "codex": cli = L.t("agent_provider_codex")
        default: cli = provider
        }
        return [cli, model ?? L.t("newtask_model_default"), effort ?? L.t("effort_default")].joined(separator: " · ")
    }
}
