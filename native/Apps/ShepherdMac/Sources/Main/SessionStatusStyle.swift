import SwiftUI
import ShepherdKit

/// Status badge copy and tint. Copy is mirrored from the web catalog: the
/// contract's `running` is the web UI's "BUSY" (status_working) — there is no
/// status_running key.
///
/// `SessionStatus` is an open enum, so `known` is optional: `nil` means the server
/// sent a value this build has never heard of. That is not an error — show the raw
/// wire value so the operator can at least read it.
enum SessionStatusStyle {
    static func label(_ status: SessionStatus) -> String {
        guard let known = status.known else { return status.rawValue.uppercased() }
        switch known {
        case .running: return L.t("status_working")
        case .idle: return L.t("status_idle")
        case .blocked: return L.t("status_blocked")
        case .done: return L.t("status_done")
        case .archived: return L.t("status_archived")
        }
    }

    static func tint(_ status: SessionStatus) -> Color {
        guard let known = status.known else { return .secondary }
        switch known {
        case .running: return .green
        case .idle: return .secondary
        case .blocked: return .orange
        case .done: return .blue
        case .archived: return .gray
        }
    }

    static func providerLabel(_ provider: AgentProvider?) -> String? {
        switch provider {
        case .claude: L.t("agent_provider_claude")
        case .codex: L.t("agent_provider_codex")
        case nil: nil
        }
    }
}
