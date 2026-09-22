import Foundation
import Testing
import ShepherdKit

@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
/// `SidebarView` itself renders nothing decidable without hosting SwiftUI, but everything it reads
/// to decide *what* to render — the empty-state copy, the repo-rail gate, the collapse wiring, and
/// the selection binding it hands to `List` — is plain state on `SidebarCopy`/`SidebarModel`/
/// `AppModel`, and is tested here without a single view in sight.
@MainActor
struct SidebarViewTests {
    @Test func panelLensesEnableOnlyWhenTheirSidebarFactoryExists() {
        resetStreamSeams()
        defer { resetStreamSeams() }
        for lens in [HerdLens.next, .owed, .done] {
            #expect(!lens.isAvailable)
            #expect(QueuesPanels.panel(for: lens) == nil)
        }
        StreamRegistrations.installScene()
        for lens in [HerdLens.next, .owed, .done] {
            #expect(lens.isAvailable)
            #expect(QueuesPanels.panel(for: lens) != nil)
        }
        for lens in [HerdLens.all, .ready] {
            #expect(lens.isAvailable)
            #expect(QueuesPanels.panel(for: lens) == nil)
        }
    }

    @Test func handoffHeadingsDistinguishNamedAnonymousAndMixedGroups() {
        let a = session("a"), b = session("b")
        let group = HerdGroup(stage: .waitingOnReviewer, sessions: [a, b])
        #expect(HerdGroupView.heading(group, git: [:]) == L.t("herd_waiting_reviewer_group_maintainers", "2"))
        var git = GitState(state: .init(known: .open), checks: .init(known: .success), deployConfigured: false)
        git.handoffWho = "Ada"
        #expect(HerdGroupView.heading(group, git: ["a": git, "b": git]) == L.t("herd_waiting_reviewer_group", "Ada", "2"))
        #expect(HerdGroupView.heading(group, git: ["a": git]) == L.t("herd_waiting_reviewer_group_multi", "2"))
    }

    private func session(_ id: String, repo: String = "/repos/a") -> Session {
        var s = PreviewData.session(id: id)
        s.repoPath = repo
        return s
    }

    private func makeApp() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
    }

    // MARK: - SidebarCopy.empty (the view's `emptyCopy`, pulled out for exactly this)

    // MARK: - The repo-rail gate (`SidebarView` shows it only once `chips.count >= 2`)

    // MARK: - Collapse wiring (`HerdGroupView(isCollapsed: model.collapsedStages.contains(...))`)

    // MARK: - The selection binding (`list(selection: $app.selectedSessionID)`)

}
}
