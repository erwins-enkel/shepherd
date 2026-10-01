import SwiftUI
import ShepherdAppCore

struct IOSPlanButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.sessionFont(weight: .semibold)
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .foregroundStyle(enabled ? SessionListStyle.amber : SessionListStyle.muted)
            .background(configuration.isPressed ? SessionListStyle.selected : SessionListStyle.panel)
            .overlay { RoundedRectangle(cornerRadius: 2).stroke(enabled ? SessionListStyle.amber : SessionListStyle.line) }
    }
}

extension PlanGateChip {
    var iosLabel: String? {
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
    var iosTint: Color {
        SessionListStyle.badgeTint(iosBadgeTint)
    }
    var iosBadgeTint: Color {
        switch self {
        case .ready: .green
        case .edited, .changes: .orange
        case .error: .red
        case .reviewing: .blue
        default: .secondary
        }
    }
    func iosStatus(stalled: Bool) -> String? {
        switch self {
        case .none: nil
        case .view: L.t("planpanel_status_view")
        case .edited: L.t("planpanel_status_edited")
        case .reviewing: L.t("planpanel_status_reviewing")
        case .changes: L.t(stalled ? "planpanel_status_changes_stalled" : "planpanel_status_changes")
        case .ready: L.t("planpanel_status_ready")
        case .error: L.t("planpanel_status_error")
        case .planning: L.t("planpanel_status_planning")
        }
    }
}
