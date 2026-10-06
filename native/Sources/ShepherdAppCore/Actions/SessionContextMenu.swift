import Foundation
import ShepherdKit

/// One entry of the right-click menu on a session card — the macOS counterpart of the web's
/// `CardMenu.svelte`. Merge PR and Bring back are not offered here: they have their own surfaces.
public enum SessionContextAction: String, Identifiable, CaseIterable, Sendable {
    case stop
    case resume
    case rename
    case amend
    case relaunch
    case relaunchElsewhere
    case variant
    case replace
    case cleanTerminal
    case decommission

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .stop: L.t("cardmenu_stop")
        case .resume: L.t("cardmenu_resume")
        case .rename: L.t("cardmenu_rename")
        case .amend: L.t("cardmenu_amend")
        case .relaunch: L.t("cardmenu_relaunch")
        case .relaunchElsewhere: L.t("cardmenu_relaunch_elsewhere")
        case .variant: L.t("cardmenu_start_variant")
        case .replace: L.t("cardmenu_replace_with")
        case .cleanTerminal: L.t("cardmenu_clean_terminal")
        case .decommission: L.t("cardmenu_decommission")
        }
    }

    public var systemImage: String {
        switch self {
        case .stop: "stop.circle"
        case .resume: "play.circle"
        case .rename: "pencil"
        case .amend: "plus.bubble"
        case .relaunch: "arrow.triangle.2.circlepath"
        case .relaunchElsewhere: "arrow.left.arrow.right"
        case .variant: "arrow.triangle.branch"
        case .replace: "arrow.left.arrow.right.circle"
        case .cleanTerminal: "terminal"
        case .decommission: "xmark.circle"
        }
    }

    /// Rendered with the destructive role; the action behind it still asks before it runs.
    public var isDestructive: Bool { self == .decommission }
}

extension ActionRules {
    /// The entries a session's menu offers right now, in the web menu's order. Reuses the action
    /// bar's predicates (`allows`) so the two surfaces never disagree, and ports the rest of
    /// `UnitRow.svelte`: variant/replace skip an experiment's comparison run, relaunch-elsewhere
    /// shares Relaunch's eligibility, and a clean terminal is hidden on a terminal row.
    static func contextMenu(
        for session: Session,
        workingBlocked: [String: Bool] = [:],
        gitMerged: Bool = false,
        now: Int
    ) -> [SessionContextAction] {
        guard session.status.known != .archived else { return [] }
        func ok(_ action: SessionAction) -> Bool {
            allows(action, session: session, workingBlocked: workingBlocked, gitMerged: gitMerged, now: now)
        }
        let relaunchable = ok(.relaunch)
        let comparison = session.experimentRole?.known == .comparison
        return SessionContextAction.allCases.filter {
            switch $0 {
            case .stop: ok(.stop)
            case .resume: ok(.resume)
            case .rename: ok(.rename)
            case .amend: ok(.amend)
            case .relaunch, .relaunchElsewhere: relaunchable
            case .variant, .replace: relaunchable && !comparison
            case .cleanTerminal: session.terminal != true
            case .decommission: true
            }
        }
    }
}
