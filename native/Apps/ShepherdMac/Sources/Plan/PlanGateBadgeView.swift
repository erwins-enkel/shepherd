import ShepherdKit
import SwiftUI

/// S7/integration hosts this view; clicking it exposes the existing open-plan seam.
struct PlanGateBadgeView: View {
    let session: Session
    let model: PlanModel
    var allowView = true

    private var chip: PlanGateChip {
        var effective = session
        if model.releasedGates.contains(session.id) { effective.planPhase = .init(known: .executing) }
        return .chip(session: effective, gate: model.gates[session.id],
                     reviewing: model.reviewing.contains(session.id), allowView: allowView)
    }

    var body: some View {
        if let label = chip.label {
            Button { model.openPlan(session.id) } label: {
                Text(verbatim: label)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .foregroundStyle(chip.tint)
                    .background(chip.tint.opacity(0.12), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L.t("plangate_menu_open_plan") + ": " + label)
            .accessibilityIdentifier("plan-gate-badge-\(session.id)")
        }
    }
}

extension PlanGateChip {
    var label: String? {
        switch self {
        case .none: nil
        case .view: L.t("plangate_view")
        case .edited: L.t("plangate_edited")
        case .reviewing: L.t("plangate_reviewing")
        case .changes(let round, let cap): L.t("plangate_changes", String(round), String(cap))
        case .ready: L.t("plangate_ready")
        case .error: L.t("plangate_error")
        case .planning: L.t("plangate_planning")
        }
    }

    var tint: Color {
        switch self {
        case .ready: .green
        case .edited, .changes: .orange
        case .error: .red
        case .reviewing: .blue
        default: .secondary
        }
    }

    func statusNote(stalled: Bool) -> String? {
        switch self {
        case .none: nil
        case .view: L.t("planpanel_status_view")
        case .edited: L.t("planpanel_status_edited")
        case .reviewing: L.t("planpanel_status_reviewing")
        case .changes: stalled ? L.t("planpanel_status_changes_stalled") : L.t("planpanel_status_changes")
        case .ready: L.t("planpanel_status_ready")
        case .error: L.t("planpanel_status_error")
        case .planning: L.t("planpanel_status_planning")
        }
    }
}
