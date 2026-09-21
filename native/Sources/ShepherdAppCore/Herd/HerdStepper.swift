import ShepherdKit
import SwiftUI

/// Display-only values from Stepper.svelte; the lifecycle itself stays in HerdClassifier.
public struct HerdStepperSegment: Identifiable {
    enum State { case done, active, pending, skipped }
    enum Tint { case ciSuccess, ciPending, ciFailure, reviewing, changes, approved }

    let stage: StepperStage
    let state: State
    let tint: Tint?
    public var id: StepperStage { stage }

    public var isHollow: Bool { state == .skipped }
    private var needsAttention: Bool { tint == .ciFailure || tint == .changes }
    // WCAG 1.4.1: failure/changes differ by thickness and outline, as well as colour.
    public var height: CGFloat { needsAttention ? 5 : 3 }
    public var outlineWidth: CGFloat { needsAttention || isHollow ? 1 : 0 }

    public var color: Color {
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

    public var accessibilityLabel: String {
        ([HerdStepper.label(stage), stateLabel] + [verdictLabel].compactMap { $0 }).joined(separator: " · ")
    }
}

/// Testable presentation shared by the visual bar and its accessible progress summary.
public struct HerdStepper {
    public init(info: StepperInfo) { self.info = info }
    let info: StepperInfo
    public var terminal: StepperInfo.Terminal? { info.terminal }

    public var segments: [HerdStepperSegment] {
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

    public var accessibilityLabel: String {
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
