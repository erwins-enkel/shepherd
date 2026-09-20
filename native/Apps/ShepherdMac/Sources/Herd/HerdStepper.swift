import ShepherdKit
import SwiftUI

/// Display-only values from Stepper.svelte; the lifecycle itself stays in HerdClassifier.
struct HerdStepperSegment: Identifiable {
    enum State { case done, active, pending, skipped }
    enum Tint { case ciSuccess, ciPending, ciFailure, reviewing, changes, approved }

    let stage: StepperStage
    let state: State
    let tint: Tint?
    var id: StepperStage { stage }

    var isHollow: Bool { state == .skipped }
    private var needsAttention: Bool { tint == .ciFailure || tint == .changes }
    // WCAG 1.4.1: failure/changes differ by thickness and outline, as well as colour.
    var height: CGFloat { needsAttention ? 5 : 3 }
    var outlineWidth: CGFloat { needsAttention || isHollow ? 1 : 0 }

    var color: Color {
        switch tint {
        case .ciSuccess, .approved: .green
        case .ciPending, .reviewing: .orange
        case .ciFailure, .changes: .red
        case nil:
            switch state {
            case .active: .primary
            case .done, .skipped: .secondary
            case .pending: .secondary.opacity(0.25)
            }
        }
    }

    var verdictLabel: String? {
        switch tint {
        case .ciSuccess: L.t("activity_ci_success")
        case .ciPending: L.t("activity_ci_pending")
        case .ciFailure: L.t("activity_ci_failure")
        case .reviewing: L.t("activity_review_reviewing")
        case .changes: L.t("activity_review_changes")
        case .approved: L.t("activity_review_approved")
        case nil: nil
        }
    }

    private var stateLabel: String {
        switch state {
        case .done: L.t("stepper_legend_done")
        case .active: L.t("stepper_legend_now")
        case .pending: L.t("stepper_legend_pending")
        case .skipped: L.t("stepper_legend_skipped")
        }
    }

    var accessibilityLabel: String {
        ([HerdStepper.label(stage), stateLabel] + [verdictLabel].compactMap { $0 }).joined(separator: " · ")
    }
}

/// Testable presentation shared by the visual bar and its accessible progress summary.
struct HerdStepper {
    let info: StepperInfo
    var terminal: StepperInfo.Terminal? { info.terminal }

    var segments: [HerdStepperSegment] {
        guard terminal == nil else { return [] }
        return StepperStage.allCases.map { stage in
            let state: HerdStepperSegment.State
            if stage == .planning && info.planningSkipped { state = .skipped }
            else if stage.index < info.index { state = .done }
            else if stage.index == info.index { state = .active }
            else { state = .pending }

            var tint: HerdStepperSegment.Tint?
            if stage == .pr && info.index >= stage.index {
                switch info.ci.known {
                case .success: tint = .ciSuccess
                case .pending: tint = .ciPending
                case .failure: tint = .ciFailure
                default: break
                }
            }
            if stage == .review && info.index >= stage.index {
                switch info.review {
                case .reviewing: tint = .reviewing
                case .changes: tint = .changes
                case .approved: tint = .approved
                case .none, .error: break
                }
            }
            return HerdStepperSegment(stage: stage, state: state, tint: tint)
        }
    }

    static func label(_ stage: StepperStage) -> String {
        switch stage {
        case .planning: L.t("activity_stage_planning")
        case .implementing: L.t("activity_stage_implementing")
        case .pr: L.t("activity_stage_pr")
        case .review: L.t("activity_stage_review")
        case .ready: L.t("activity_stage_ready")
        }
    }

    var accessibilityLabel: String {
        if let terminal {
            return terminal == .merged ? L.t("activity_merged") : L.t("activity_closed")
        }
        var parts = [L.t("activity_progress", Self.label(info.reached))]
        for segment in segments {
            guard let verdict = segment.verdictLabel else { continue }
            if segment.stage == .pr { parts.append(L.t("activity_ci_status", verdict)) }
            if segment.stage == .review { parts.append(L.t("activity_review_status", verdict)) }
        }
        return parts.joined(separator: " · ")
    }
}

/// A passive row accessory: selection remains the containing row's action.
struct HerdStepperView: View {
    let info: StepperInfo

    init(info: StepperInfo) { self.info = info }

    init(session: Session, git: GitState?, verdict: ReviewVerdict?, reviewing: Bool) {
        info = HerdClassifier.deriveStage(session: session, git: git, verdict: verdict, reviewing: reviewing)
    }

    var body: some View {
        let model = HerdStepper(info: info)
        if let terminal = model.terminal {
            let tint: Color = terminal == .merged ? .green : .orange
            Text(verbatim: model.accessibilityLabel)
                .textCase(.uppercase)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .foregroundStyle(tint)
                .background(tint.opacity(0.14), in: Capsule())
                .accessibilityLabel(Text(verbatim: model.accessibilityLabel))
        } else {
            HStack(spacing: 4) {
                ForEach(model.segments) { segment in
                    Capsule()
                        .fill(segment.isHollow ? .clear : segment.color)
                        .frame(height: segment.height)
                        .overlay {
                            Capsule().stroke(segment.color, lineWidth: segment.outlineWidth)
                                .padding(segment.isHollow ? 0 : -1)
                        }
                        .help(segment.accessibilityLabel)
                }
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: model.accessibilityLabel))
            .accessibilityValue(Text(verbatim: model.segments.map(\.accessibilityLabel).joined(separator: ", ")))
        }
    }
}
