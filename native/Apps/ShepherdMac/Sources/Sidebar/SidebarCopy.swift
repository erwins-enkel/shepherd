import Foundation

/// The empty-state line `SidebarView` shows in place of the session list. Pulled out of the view so
/// it is unit-testable without hosting SwiftUI — the pattern `SessionStatusStyle`/`SessionBadges`
/// already use.
enum SidebarCopy {
    /// The web has a distinct empty line per lens, and one for an empty single-repo filter.
    static func empty(lens: HerdLens, repos: Set<String>) -> String {
        if repos.count == 1, let repo = repos.first {
            return L.t("herd_repo_filter_empty", (repo as NSString).lastPathComponent)
        }
        switch lens {
        case .ready: return L.t("herd_ready_empty")
        case .done: return L.t("herd_done_empty")
        default: return L.t("native_sidebar_empty")
        }
    }
}
