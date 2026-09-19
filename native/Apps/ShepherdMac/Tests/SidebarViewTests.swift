import Foundation
import Testing
import ShepherdKit

@testable import Shepherd

/// `SidebarView` itself renders nothing decidable without hosting SwiftUI, but everything it reads
/// to decide *what* to render — the empty-state copy, the repo-rail gate, the collapse wiring, and
/// the selection binding it hands to `List` — is plain state on `SidebarCopy`/`SidebarModel`/
/// `AppModel`, and is tested here without a single view in sight.
@MainActor
struct SidebarViewTests {
    private func session(_ id: String, repo: String = "/repos/a") -> Session {
        var s = PreviewData.session(id: id)
        s.repoPath = repo
        return s
    }

    private func makeApp() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    // MARK: - SidebarCopy.empty (the view's `emptyCopy`, pulled out for exactly this)

    @Test func emptyCopyPrefersTheSingleRepoFilterOverTheLens() {
        #expect(
            SidebarCopy.empty(lens: .ready, repos: ["/repos/widgets"])
                == L.t("herd_repo_filter_empty", "widgets"))
    }

    @Test func emptyCopyIsTheReadyLensLineWithNoRepoFilter() {
        #expect(SidebarCopy.empty(lens: .ready, repos: []) == L.t("herd_ready_empty"))
    }

    @Test func emptyCopyIsTheDoneLensLineWithNoRepoFilter() {
        #expect(SidebarCopy.empty(lens: .done, repos: []) == L.t("herd_done_empty"))
    }

    /// Every other lens — and a filter on more than one repo, which is not the single-repo case
    /// above — falls back to the generic empty line.
    @Test func emptyCopyFallsBackForEveryOtherLensAndAWiderFilter() {
        #expect(SidebarCopy.empty(lens: .all, repos: []) == L.t("native_sidebar_empty"))
        #expect(SidebarCopy.empty(lens: .next, repos: []) == L.t("native_sidebar_empty"))
        #expect(SidebarCopy.empty(lens: .owed, repos: []) == L.t("native_sidebar_empty"))
        #expect(
            SidebarCopy.empty(lens: .ready, repos: ["/repos/a", "/repos/b"])
                == L.t("herd_ready_empty"))
    }

    // MARK: - The repo-rail gate (`SidebarView` shows it only once `chips.count >= 2`)

    @Test func oneRepoStaysBelowTheRailGate() {
        let model = SidebarModel(reads: .stub, now: { 0 })
        model.install(sessions: [session("a", repo: "/repos/one"), session("b", repo: "/repos/one")])
        #expect(model.chips.count == 1)
    }

    @Test func twoDistinctReposClearTheRailGate() {
        let model = SidebarModel(reads: .stub, now: { 0 })
        model.install(sessions: [session("a", repo: "/repos/one"), session("b", repo: "/repos/two")])
        #expect(model.chips.count == 2)
    }

    // MARK: - Collapse wiring (`HerdGroupView(isCollapsed: model.collapsedStages.contains(...))`)

    @Test func eachStageCollapsesIndependently() {
        let model = SidebarModel(reads: .stub, now: { 0 })
        model.toggleCollapsed(.ready)
        #expect(model.collapsedStages.contains(.ready))
        #expect(!model.collapsedStages.contains(.active), "toggling one stage must not affect another")

        model.toggleCollapsed(.active)
        #expect(model.collapsedStages.contains(.active))
        #expect(model.collapsedStages.contains(.ready), "still collapsed from the first toggle")

        model.toggleCollapsed(.ready)
        #expect(!model.collapsedStages.contains(.ready))
        #expect(model.collapsedStages.contains(.active), "unaffected by re-expanding the other stage")
    }

    // MARK: - The selection binding (`list(selection: $app.selectedSessionID)`)

    @Test func selectingARowSetsTheAppModelSelection() {
        let app = makeApp()
        app.selectedSessionID = "s-1"
        #expect(app.selectedSessionID == "s-1")
    }

    /// `activate(_:)` — every profile switch — starts with exactly what `teardown()` does, which
    /// clears `selectedSessionID` along with the rest of the outgoing activation's state. The
    /// binding `SidebarView` hands `List` is a plain `var`, not something that reset disables: a
    /// row selected in the *new* activation's list must set it exactly as before.
    @Test func aProfileSwitchClearsSelectionAndTheBindingStillWorksAfterwards() {
        let app = makeApp()
        app.selectedSessionID = "s-1"
        app.teardown()
        #expect(app.selectedSessionID == nil)

        app.selectedSessionID = "s-2"
        #expect(app.selectedSessionID == "s-2")
    }
}
