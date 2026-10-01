import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct IOSPlanView: View {
    let session: Session
    let model: PlanModel
    let store: SessionStore
    let app: AppModel
    var body: some View {
        if let controller = app.extension(IOSPlanController.self) {
            IOSPlanInstance(session: session, presentation: controller.presentation(for: session, model: model))
                .id("\(session.id)-\(app.activationGeneration)")
        }
    }
}

private struct IOSPlanInstance: View {
    let session: Session
    @Environment(\.scenePhase) private var scenePhase
    let presentation: IOSPlanPresentation

    var body: some View {
        ScrollView { IOSPlanBody(presentation: presentation) }
            .accessibilityIdentifier("detail-tab-plan")
            .onAppear { presentation.update(session: session, visible: true, active: scenePhase == .active) }
            .onChange(of: scenePhase) { _, phase in presentation.update(active: phase == .active) }
            .onChange(of: session) { _, value in presentation.update(session: value) }
            .onChange(of: presentation.actions.gate) { _, _ in presentation.update() }
            .onChange(of: presentation.actions.reviewing) { _, _ in presentation.update() }
            .onChange(of: presentation.actions.inFlight) { _, _ in presentation.update() }
            .onChange(of: presentation.actions.quotaBusy) { _, _ in presentation.update() }
            .onChange(of: presentation.access.allowed) { _, _ in presentation.update() }
            .onDisappear { presentation.disappear() }
    }
}

/// Also used by ImageRenderer; only UIKit input/selection is replaced in fixtures.
struct IOSPlanBody: View {
    let presentation: IOSPlanPresentation
    var fixture = false
    private var actions: PlanTabActions { presentation.actions }
    var body: some View {
        @Bindable var actions = presentation.actions
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                Text(verbatim: L.t("planpanel_title")).sessionFont(weight: .semibold)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                if let label = actions.chip.iosLabel {
                    Text(verbatim: label).sessionFont(label: true).foregroundStyle(actions.chip.iosTint)
                }
            }
            if let note = actions.chip.iosStatus(stalled: actions.stalled) {
                Text(verbatim: note).foregroundStyle(SessionListStyle.muted)
            }
            if !presentation.access.allowed {
                Text(verbatim: L.t("native_ios_plan_readonly")).foregroundStyle(SessionListStyle.muted)
                    .accessibilityIdentifier("plan-readonly")
            }
            environments
            if PlanGateChip.edited(actions.gate) {
                Text(verbatim: L.t("planpanel_edited_note")).foregroundStyle(SessionListStyle.amber)
            }
            if let blocks = actions.gate?.blocks, !blocks.isEmpty {
                Text(verbatim: L.t("planpanel_proposed_caption")).sessionFont(label: true)
                    .foregroundStyle(SessionListStyle.muted)
                IOSVisualBlocksView(blocks: blocks, presentation: presentation, fixture: fixture)
            }
            if let source = actions.gate?.plan, !source.isEmpty {
                IOSPlanMarkdownView(source: source, fixture: fixture)
            } else {
                Text(verbatim: actions.canReview && actions.gate == nil
                    ? L.t("planpanel_plan_unavailable") : L.t("planpanel_empty"))
                    .foregroundStyle(SessionListStyle.muted)
            }
            if let gate = actions.gate { verdict(gate) }
            if actions.heldAtCap {
                Text(verbatim: L.t(actions.stalled ? "planpanel_review_at_cap" : "planpanel_review_at_cap_no_resume"))
            }
            if actions.planUnavailable { Text(verbatim: L.t("planpanel_review_plan_unavailable")) }
            if let key = actions.outcome { Text(verbatim: L.t(key)).accessibilityIdentifier("plan-review-outcome") }
            if actions.stalled {
                VStack(spacing: 8) {
                    Button(actions.quotaBusy == true ? L.t("planpanel_quota_resuming") : L.t("planpanel_quota_resume")) {
                        Task { await actions.quota(resume: true) }
                    }.accessibilityIdentifier("plan-quota-resume")
                    Button(actions.quotaBusy == false ? L.t("planpanel_quota_dismissing") : L.t("planpanel_quota_dismiss")) {
                        Task { await actions.quota(resume: false) }
                    }.accessibilityIdentifier("plan-quota-dismiss")
                    Button(L.t("plangate_menu_send_changes")) { presentation.prepareSteer() }
                        .accessibilityIdentifier("plan-prepare-steer")
                }.disabled(!presentation.allowsActions || actions.quotaBusy != nil || actions.inFlight)
            }
            if let steer = presentation.steer { IOSPlanSteerView(model: steer, fixture: fixture) }
            if let key = actions.quotaOutcome { Text(verbatim: L.t(key)).foregroundStyle(SessionListStyle.amber) }
            footer
            if let key = actions.releaseNote {
                Text(verbatim: L.t(key)).foregroundStyle(SessionListStyle.amber).accessibilityIdentifier("plan-release-note")
            }
        }
        .sessionFont().foregroundStyle(SessionListStyle.ink).padding(16)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading).background(SessionListStyle.background)
        .buttonStyle(IOSPlanButtonStyle()).tint(SessionListStyle.amber)
        .confirmationDialog(L.t("planpanel_go"), isPresented: $actions.confirming, titleVisibility: .visible) {
            Button(L.t("planpanel_go")) { Task { await actions.release() } }
            Button(L.t("common_cancel"), role: .cancel) { actions.cancelConfirmation() }
        } message: { Text(verbatim: actions.confirmationMessage) }
    }

    private var environments: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: L.t("planpanel_env_plan") + ": " + PlanEnvironment.label(
                provider: actions.session.agentProvider?.rawValue ?? "claude", model: actions.session.model, effort: actions.session.effort))
            Text(verbatim: L.t("planpanel_env_review") + ": " + PlanEnvironment.reviewer(
                live: actions.model.reviewerEnv[actions.session.id], gate: actions.gate))
        }.sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
    }

    private func verdict(_ gate: PlanGate) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: L.t("planpanel_verdict")).sessionFont(weight: .semibold).accessibilityAddTraits(.isHeader)
            if let code = gate.summaryCode {
                Text(verbatim: L.t(code.known == .membraneLaunch ? "planpanel_membrane_launch" : "planpanel_no_verdict"))
            } else if !gate.summary.isEmpty { Text(verbatim: gate.summary) }
            if !gate.body.isEmpty { IOSPlanMarkdownView(source: gate.body, fixture: fixture) }
            if !gate.findings.isEmpty {
                Text(verbatim: L.t("planpanel_findings")).sessionFont(weight: .semibold).accessibilityAddTraits(.isHeader)
                ForEach(Array(gate.findings.enumerated()), id: \.offset) { _, finding in
                    Text(verbatim: "• " + finding)
                }
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(SessionListStyle.panel)
            .overlay { Rectangle().stroke(SessionListStyle.line) }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if actions.canReview {
                Button { Task { await actions.review() } } label: {
                    HStack {
                        if actions.inFlight {
                            if fixture { Image(systemName: "arrow.triangle.2.circlepath") }
                            else { ProgressView() }
                        }
                        Text(verbatim: actions.inFlight ? L.t("planpanel_reviewing") : L.t("planpanel_review_now"))
                    }
                }
                .disabled(!presentation.allowsActions || actions.reviewBlock != nil || actions.inFlight || actions.quotaBusy != nil)
                .accessibilityIdentifier("plan-review")
            }
            if actions.canRelease {
                Button(L.t("planpanel_go")) { actions.requestConfirmation() }
                    .disabled(!presentation.allowsActions || actions.inFlight || actions.quotaBusy != nil)
                    .accessibilityIdentifier("plan-go")
            }
            if actions.reviewBlock == .approved { Text(verbatim: L.t("planpanel_review_already_approved")).foregroundStyle(SessionListStyle.muted) }
            if let gate = actions.gate, !gate.approved, gate.decision.known == .changesRequested, gate.round < gate.cap {
                Text(verbatim: L.t("plangate_review_spends_round", String(gate.round), String(gate.cap))).sessionFont(label: true)
            }
        }
    }
}
