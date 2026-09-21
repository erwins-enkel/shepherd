import ShepherdAppCore
import Foundation
import Observation
import ShepherdKit
import SwiftUI

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
