import Foundation
import Observation
import ShepherdKit
import SwiftUI

struct PlanTabWriter: Sendable {
    var review: @MainActor @Sendable (String) async throws -> PlanReviewResult
    var release: @MainActor @Sendable (String) async throws -> Bool
    var quota: @MainActor @Sendable (String, Bool) async throws -> PlanQuotaResult

    static func live(_ client: ShepherdClient) -> Self {
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
final class PlanTabActions {
    var session: Session {
        didSet { if session != oldValue { cancelConfirmation() } }
    }
    let model: PlanModel
    private(set) var busy = false
    private(set) var awaitingReview = false
    private(set) var outcome: StaticString?
    private(set) var planUnavailable = false
    private(set) var heldAtCap = false
    private(set) var quotaBusy: Bool?
    private(set) var quotaOutcome: StaticString?
    private(set) var releaseNote: StaticString?
    var confirming = false
    private var pendingGate: PlanGate?
    private let writer: PlanTabWriter
    private let isCurrent: @MainActor () -> Bool
    private let sleep: @MainActor (Duration) async throws -> Void
    private var generation = 0
    private var bridgeTask: Task<Void, Never>?
    private var outcomeTask: Task<Void, Never>?

    init(session: Session, model: PlanModel, writer: PlanTabWriter,
         isCurrent: @escaping @MainActor () -> Bool = { true },
         sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.session = session
        self.model = model
        self.writer = writer
        self.isCurrent = isCurrent
        self.sleep = sleep
    }

    var gate: PlanGate? { model.gates[session.id] }
    var reviewing: Bool { model.reviewing.contains(session.id) }
    var effectiveSession: Session {
        var value = session
        if model.releasedGates.contains(session.id) { value.planPhase = .init(known: .executing) }
        return value
    }
    var inFlight: Bool { busy || reviewing || awaitingReview }
    var chip: PlanGateChip { .chip(session: effectiveSession, gate: gate, reviewing: reviewing) }
    var canReview: Bool { PlanGateChip.canOfferPlanReview(session: effectiveSession, gate: gate) }
    var reviewBlock: PlanReviewBlockReason? {
        PlanGateChip.canTriggerPlanReview(session: effectiveSession, gate: gate, reviewing: inFlight)
    }
    var canRelease: Bool { model.canRelease(session) }
    var stalled: Bool {
        PlanGateChip.canShowPlanStallActions(session: effectiveSession, gate: gate, reviewing: inFlight)
    }
    var answerContext: QuestionAnswerContext? {
        effectiveSession.planPhase?.known == .planning
            ? .init(sessionID: session.id, locked: inFlight || quotaBusy != nil) : nil
    }
    var confirmationMessage: String { L.t("planpanel_native_go_confirm", session.name) }

    func reconcile() {
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

    func review() async {
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

    func requestConfirmation() {
        guard isCurrent(), canRelease, !inFlight, quotaBusy == nil else { return }
        pendingGate = gate
        confirming = true
    }

    func cancelConfirmation() { confirming = false; pendingGate = nil }

    func release() async {
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

    func quota(resume: Bool) async {
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

    func teardown() {
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

struct PlanTabView: View {
    let session: Session
    let model: PlanModel
    let writer: PlanTabWriter
    let answerWriter: QuestionFormWriter?
    var isCurrent: @MainActor () -> Bool = { true }

    var body: some View {
        PlanTabInstance(session: session, model: model, writer: writer,
                        answerWriter: answerWriter, isCurrent: isCurrent)
            .id(Identity(session: session.id, model: ObjectIdentifier(model)))
    }

    private struct Identity: Hashable {
        let session: String
        let model: ObjectIdentifier
    }
}

private struct PlanTabInstance: View {
    let session: Session
    let answerWriter: QuestionFormWriter?
    @State private var actions: PlanTabActions

    init(session: Session, model: PlanModel, writer: PlanTabWriter,
         answerWriter: QuestionFormWriter?, isCurrent: @escaping @MainActor () -> Bool) {
        self.session = session
        self.answerWriter = answerWriter
        _actions = State(initialValue: PlanTabActions(session: session, model: model,
                                                     writer: writer, isCurrent: isCurrent))
    }

    var body: some View {
        PlanTabBody(actions: actions, answerWriter: answerWriter)
            .onChange(of: session) { _, value in actions.session = value; actions.reconcile() }
            .onChange(of: actions.reviewing, initial: true) { _, _ in actions.reconcile() }
            .onChange(of: actions.gate) { _, _ in actions.reconcile() }
            .onChange(of: actions.model.releasedGates) { _, _ in actions.reconcile() }
            .onDisappear { actions.teardown() }
    }
}

struct PlanTabBody: View {
    @Bindable var actions: PlanTabActions
    var answerWriter: QuestionFormWriter?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                environments
                if PlanGateChip.edited(actions.gate) {
                    Text(L.t("planpanel_edited_note")).foregroundStyle(.orange)
                }
                plan
                if let gate = actions.gate { verdict(gate) }
                if let note = actions.chip.statusNote(stalled: actions.stalled) { Text(verbatim: note) }
                if actions.heldAtCap {
                    Text(actions.stalled ? L.t("planpanel_review_at_cap") : L.t("planpanel_review_at_cap_no_resume"))
                }
                if actions.planUnavailable { Text(L.t("planpanel_review_plan_unavailable")) }
                if let key = actions.outcome { Text(verbatim: L.t(key)).accessibilityIdentifier("plan-review-outcome") }
                if actions.stalled { stallActions }
                if let key = actions.quotaOutcome { Text(verbatim: L.t(key)) }
                footer
                if let key = actions.releaseNote {
                    Text(verbatim: L.t(key)).foregroundStyle(.orange)
                        .accessibilityIdentifier("plan-release-note")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .accessibilityIdentifier("detail-tab-plan")
        .confirmationDialog(L.t("planpanel_go"), isPresented: $actions.confirming, titleVisibility: .visible) {
            Button(L.t("planpanel_go")) { Task { await actions.release() } }
            Button(L.t("common_cancel"), role: .cancel) { actions.cancelConfirmation() }
        } message: {
            Text(verbatim: actions.confirmationMessage)
        }
    }

    private var environments: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: L.t("planpanel_env_plan") + ": " + PlanEnvironment.label(
                provider: actions.session.agentProvider?.rawValue ?? "claude",
                model: actions.session.model, effort: actions.session.effort))
            Text(verbatim: L.t("planpanel_env_review") + ": " + PlanEnvironment.reviewer(
                live: actions.model.reviewerEnv[actions.session.id], gate: actions.gate))
        }
        .font(.caption).foregroundStyle(.secondary)
        .accessibilityLabel(L.t("planpanel_env_aria"))
    }

    @ViewBuilder private var plan: some View {
        if let blocks = actions.gate?.blocks, !blocks.isEmpty {
            Text(L.t("planpanel_proposed_caption")).font(.caption)
            VisualBlocksView(blocks: blocks, answerContext: actions.answerContext, answerWriter: answerWriter)
        }
        // Blocks supplement the reviewed plan (often with questions); they do not replace
        // its full text. Match PlanPanel so Go never hides the plan it will release.
        if let markdown = actions.gate?.plan, !markdown.isEmpty {
            PlanMarkdownView(source: markdown)
        } else {
            Text(actions.canReview && actions.gate == nil ? L.t("planpanel_plan_unavailable") : L.t("planpanel_empty"))
                .foregroundStyle(.secondary)
        }
    }

    private func verdict(_ gate: PlanGate) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L.t("planpanel_verdict")).font(.headline)
            if let code = gate.summaryCode {
                Text(code.known == .membraneLaunch ? L.t("planpanel_membrane_launch") : L.t("planpanel_no_verdict"))
            } else if !gate.summary.isEmpty { Text(verbatim: gate.summary) }
            if !gate.body.isEmpty { PlanMarkdownView(source: gate.body) }
            if !gate.findings.isEmpty {
                Text(L.t("planpanel_findings")).font(.headline)
                ForEach(Array(gate.findings.enumerated()), id: \.offset) { _, finding in
                    HStack(alignment: .firstTextBaseline) {
                        Text(verbatim: "•").accessibilityHidden(true)
                        Text(verbatim: finding)
                    }
                }
            }
        }
        .textSelection(.enabled)
    }

    private var stallActions: some View {
        HStack {
            Button(actions.quotaBusy == true ? L.t("planpanel_quota_resuming") : L.t("planpanel_quota_resume")) {
                Task { await actions.quota(resume: true) }
            }.accessibilityIdentifier("plan-quota-resume")
            Button(actions.quotaBusy == false ? L.t("planpanel_quota_dismissing") : L.t("planpanel_quota_dismiss")) {
                Task { await actions.quota(resume: false) }
            }.accessibilityIdentifier("plan-quota-dismiss")
        }.disabled(actions.quotaBusy != nil || actions.inFlight)
    }

    private var reviewLabel: String {
        guard actions.inFlight else { return L.t("planpanel_review_now") }
        let live = actions.model.reviewerEnv[actions.session.id]
        guard live?.provider != nil || actions.gate?.reviewerProvider != nil else { return L.t("planpanel_reviewing") }
        return L.t("planpanel_reviewing_env", PlanEnvironment.reviewer(live: live, gate: actions.gate))
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                if actions.canReview {
                    Button {
                        Task { await actions.review() }
                    } label: {
                        HStack {
                            if actions.inFlight { ProgressView().controlSize(.small) }
                            Text(verbatim: reviewLabel)
                        }
                    }
                    .disabled(actions.inFlight || actions.quotaBusy != nil)
                    .help(actions.reviewBlock == .approved ? L.t("planpanel_review_already_approved") : reviewLabel)
                    .accessibilityIdentifier("plan-review")
                }
                if actions.canRelease {
                    Button(L.t("planpanel_go")) { actions.requestConfirmation() }
                        .disabled(actions.inFlight || actions.quotaBusy != nil)
                        .accessibilityIdentifier("plan-go")
                }
            }
            if actions.reviewBlock == .approved { Text(L.t("planpanel_review_already_approved")) }
            if let gate = actions.gate, !gate.approved, gate.decision.known == .changesRequested, gate.round < gate.cap {
                Text(verbatim: L.t("plangate_review_spends_round", String(gate.round), String(gate.cap)))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// A live triple is authoritative only when its provider resolved to a CLI.
enum PlanEnvironment {
    static func reviewer(live: ReviewerEnv?, gate: PlanGate?) -> String {
        if let provider = live?.provider {
            return label(provider: provider.rawValue, model: live?.model, effort: live?.effort)
        }
        return label(provider: gate?.reviewerProvider?.rawValue, model: gate?.reviewerModel, effort: gate?.reviewerEffort)
    }

    static func label(provider: String?, model: String?, effort: String?) -> String {
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
