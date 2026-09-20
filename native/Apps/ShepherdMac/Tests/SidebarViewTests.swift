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

    /// `herd_done_empty` is the web's Done-PANEL line, and the Done lens is panel-only in the web
    /// too — this build ships no panel and disables the button, so the line has no reachable call
    /// site and the lens falls back with the other panel-only ones.
    @Test func emptyCopyFallsBackForTheDoneLensWhichIsPanelOnly() {
        #expect(SidebarCopy.empty(lens: .done, repos: []) == L.t("native_sidebar_empty"))
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
        #expect(model.showsRepoRail(model.chips))
    }

    /// The stranded-filter case: with A and B on the rail and A selected, archiving A's last
    /// session drops A's chip. The rail used to disappear with it — one chip is below the gate —
    /// while `selectedRepos` still held A, leaving a permanently empty list and no control to clear
    /// it. The filter is now inert the moment its chip is gone, and the rail stays up whenever a
    /// filter is actually applied.
    @Test func aVanishedRepoChipCannotStrandTheFilter() {
        let model = SidebarModel(reads: .stub, now: { 0 })
        model.install(sessions: [session("a", repo: "/repos/one"), session("b", repo: "/repos/two")])
        model.toggleRepo("/repos/one", additive: false)
        #expect(model.activeRepos == ["/repos/one"])
        #expect(model.sessions.map(\.id) == ["a"])
        #expect(model.showsRepoRail(model.chips))

        // `/repos/one`'s last session is archived: its chip is gone, the selection is not.
        model.install(sessions: [session("b", repo: "/repos/two")])
        #expect(model.chips.map(\.path) == ["/repos/two"])
        #expect(model.selectedRepos == ["/repos/one"], "the raw selection is untouched")
        #expect(model.activeRepos.isEmpty, "a filter with no chip left to clear it must be inert")
        #expect(model.sessions.map(\.id) == ["b"], "the list must not be stranded empty")
        #expect(
            model.tallies == HerdTallies(active: 1, idle: 0, blocked: 0, total: 1),
            "the tallies follow the same effective filter as the list")
    }

    /// The other half of the same gesture: a filter on the one repo that DOES still have a chip
    /// keeps the rail up even though a single chip is below the web's two-chip gate, so the click
    /// that clears it is always reachable.
    @Test func aLiveFilterKeepsTheRailUpBelowTheTwoChipGate() {
        let model = SidebarModel(reads: .stub, now: { 0 })
        model.install(sessions: [session("a", repo: "/repos/one")])
        #expect(!model.showsRepoRail(model.chips), "one chip and no filter stays below the gate")
        model.toggleRepo("/repos/one", additive: false)
        #expect(model.showsRepoRail(model.chips))
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
