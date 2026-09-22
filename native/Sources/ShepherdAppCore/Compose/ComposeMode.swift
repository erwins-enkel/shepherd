import SwiftUI

public enum ComposeMode: String, CaseIterable, Sendable {
    case code, research, epic, plain

    public var title: String {
        switch self {
        case .code: L.t("newtask_mode_code")
        case .research: L.t("newtask_mode_research")
        case .epic: L.t("newtask_mode_epic")
        case .plain: L.t("newtask_mode_plain")
        }
    }
}
