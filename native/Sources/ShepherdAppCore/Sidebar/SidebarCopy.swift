import Foundation
import ShepherdKit

/// The empty-state line `SidebarView` shows in place of the session list. Pulled out of the view so
/// it is unit-testable without hosting SwiftUI — the pattern `SessionStatusStyle`/`SessionBadges`
/// already use.
public enum SidebarCopy {
    /// Shared heading and handoff naming used by the Mac and iOS lifecycle groups.
    public static func heading(_ group: HerdGroup, git: [String: GitState]) -> String? {
        let names = group.sessions.map { git[$0.id]?.handoffWho }.map { name in
            name?.isEmpty == false ? name : nil
        }
        let unique = Set(names)
        let who = unique.count == 1 ? names.first.flatMap { $0 } : nil
        let count = String(group.sessions.count)
        if who == nil, names.allSatisfy({ $0 == nil }) {
            if group.stage == .waitingOnReviewer { return L.t("herd_waiting_reviewer_group_maintainers", count) }
            if group.stage == .waitingOnMerger { return L.t("herd_waiting_merger_group_maintainers", count) }
        }
        guard let key = group.stage.headingKey(who: who) else { return nil }
        if let who { return L.t(key, who, count) }
        return L.t(key, count)
    }


    /// The web has a distinct empty line per lens, and one for an empty single-repo filter.
    public static func empty(lens: HerdLens, repos: Set<String>) -> String {
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
