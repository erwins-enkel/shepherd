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
        // Only `ready` gets a line of its own: it is the only lens besides `all` this build lets
        // the operator select (`HerdLens.isAvailable`). `done` is panel-only in the web and ships
        // disabled here, so `herd_done_empty` — the web's Done-panel line — has no reachable call
        // site and is deliberately not in `KEYS_SIDEBAR`.
        switch lens {
        case .ready: return L.t("herd_ready_empty")
        default: return L.t("native_sidebar_empty")
        }
    }
}
