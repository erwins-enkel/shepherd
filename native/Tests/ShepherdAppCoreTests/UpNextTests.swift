import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
struct UpNextTests {
    private func item(_ number: Int, repo: String = "/a", label: String = "A",
                      title: String = "Task", age: Int = 1, priority: Bool = false,
                      kind: String = "feature", labels: [String] = []) -> UpNextItem {
        .init(repoPath: repo, repoSlug: nil, repoLabel: label, number: number, title: title,
              url: "https://example.test/\(number)", kind: .init(known: kind == "epic" ? .epic : .feature),
              priority: priority, createdAt: age, labels: labels,
              issueRef: .init(number: number, url: "https://example.test/\(number)",
                              title: title, body: "Full issue body"))
    }

    private func section(_ items: [UpNextItem], priority: Bool = false,
                         repo: String = "/a") -> UpNextSection {
        .init(kind: .init(known: priority ? .priority : .repo),
              repoPath: priority ? nil : repo, repoSlug: nil, repoLabel: priority ? nil : repo,
              items: items, totalCount: items.count)
    }

    private func snapshot(_ sections: [UpNextSection], failed: Int = 0) -> UpNextSnapshot {
        .init(generatedAt: 1, sections: sections, repoCount: 2, fallback: nil, failedRepoCount: failed)
    }

    @Test func acceptedBootstrapComputesUntilFrameAndRefreshKeepsCachedWork() async throws {
        let suite = "UpNextBootstrapTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        let store = try SessionStore(profile: ServerProfile(name: "queues",
            baseURL: URL(string: "https://queues.invalid")!, mode: .remote),
            credentials: InMemoryCredentialStore())
        let model = QueuesModel(store: store, app: app)
        let probe = UpNextRefreshProbe()
        model.reads = QueuesReads(held: { [] }, done: { [] }, recaps: { [:] }, stranded: { [] },
                                 refreshUpNext: { await probe.accept() })
        defer {
            model.teardown()
            store.stop()
            app.teardown()
            defaults.removePersistentDomain(forName: suite)
        }
        var deadline = ContinuousClock.now + .seconds(10)
        while model.isRefreshing, ContinuousClock.now < deadline { await Task.yield() }
        #expect(!model.isRefreshing && !model.upNextLoadFailed)
        #expect(await probe.calls == 1)
        #expect(UpNextPresentation.phase(model.upNext, failed: false, groups: []) == .computing)
        let snap = snapshot([section([item(1)]), section([item(2, repo: "/b")], repo: "/b")])
        store.apply(.unknown(name: "upnext:snapshot", payload: try JSONEncoder().encode(
            Components.Schemas.UpNextSnapshotEvent(snapshot: snap))))
        deadline = ContinuousClock.now + .seconds(10)
        while model.upNext == nil, ContinuousClock.now < deadline { await Task.yield() }
        #expect(model.upNext == snap)
        await model.refresh()
        #expect(await probe.calls == 2)
        #expect(model.upNext == snap)
        let groups = UpNextPresentation.groups(model.upNext, sort: .newest, repos: ["/b"])
        #expect(groups.first?.items.map(\.number) == [2])
        #expect(UpNextPresentation.phase(model.upNext, failed: false, groups: groups) == .ready)
    }

    @Test func defaultNewestAndEverySortModePersistInAnAppOwnedSuiteKey() {
        let suite = "UpNextTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("recommended", forKey: "shepherd.upnext.sort")
        #expect(UpNextPanelState(defaults: defaults).sort == .newest)
        for mode in UpNextSort.allCases {
            UpNextPanelState(defaults: defaults).setSort(mode)
            #expect(UpNextPanelState(defaults: defaults).sort == mode)
        }
        defaults.set("future-mode", forKey: UpNextSort.storageKey)
        #expect(UpNextPanelState(defaults: defaults).sort == .newest)
        #expect(defaults.string(forKey: "shepherd.upnext.sort") == "recommended")
    }

    @Test func recommendedPreservesSectionAndItemOrderWithIndependentCaps() {
        let priority = (1...12).reversed().map { item($0, priority: true) }
        let normal = (20...27).reversed().map { item($0) }
        let groups = UpNextPresentation.groups(snapshot([section(priority, priority: true),
            section(normal), section([item(90, repo: "/b")], repo: "/b")]), sort: .recommended)
        #expect(groups.count == 3)
        #expect(groups[0].items == priority && groups[1].items == normal)
        #expect(groups[0].cap == 10 && groups[1].cap == 5 && groups[2].cap == 5)
        #expect(groups[0].shown(expanded: false).count == 10)
        #expect(groups[1].shown(expanded: false).count == 5)
        #expect(groups[0].shown(expanded: true).count == 12)
        #expect(groups[1].shown(expanded: true).count == 8)
        #expect(groups[0].totalCount == 12 && groups[1].totalCount == 8)
    }

    @Test func allClientSortsFlattenReposAndSplitOnTheItemPriorityFlag() {
        let a = item(1, title: "Alpha", age: 10)
        let b = item(2, repo: "/b", title: "Beta", age: 30)
        let c = item(3, title: "Charlie", age: 20)
        let urgent = item(4, priority: true)
        let snap = snapshot([section([c, urgent, a]), section([b], repo: "/b")])
        for (sort, expected) in [(UpNextSort.newest, [b, c, a]), (.oldest, [a, c, b]),
                                 (.titleAscending, [a, b, c]), (.titleDescending, [c, b, a])] {
            let groups = UpNextPresentation.groups(snap, sort: sort)
            #expect(groups.count == 2)
            #expect(groups[0].items == [urgent] && groups[0].cap == 10)
            #expect(groups[1].items == expected && groups[1].cap == 5)
        }
    }

    @Test func everyClientSortBreaksTiesByRepoLabelThenPathThenNumber() {
        let expected = [item(3, repo: "/z", label: "A"), item(1, repo: "/a", label: "B"),
                        item(2, repo: "/a", label: "B"), item(1, repo: "/b", label: "B")]
        for sort in UpNextSort.allCases where sort != .recommended {
            let groups = UpNextPresentation.groups(snapshot([section(Array(expected.reversed()))]), sort: sort)
            #expect(groups.first?.items == expected)
        }
    }

    @Test func staleSnapshotStillFiltersLocallyAndRecountsPriority() {
        let a = item(1, priority: true)
        let b = item(2, repo: "/b", priority: true)
        let snap = snapshot([section([a, b], priority: true), section([item(3)]),
                             section([item(4, repo: "/b")], repo: "/b")])
        let groups = UpNextPresentation.groups(snap, sort: .recommended, repos: ["/b"])
        #expect(groups.count == 2 && groups[0].items == [b] && groups[0].totalCount == 1)
        #expect(groups[1].items.map(\.number) == [4])
        #expect(UpNextPresentation.groups(snap, sort: .newest, repos: ["/missing"]).isEmpty)
        #expect(snap.sections[0].items.count == 2)
    }

    @Test func loadingAndFailureNeverMasqueradeAsAnEmptyQueueOrHideCachedWork() {
        #expect(UpNextPresentation.phase(nil, failed: false, groups: []) == .computing)
        #expect(UpNextPresentation.phase(nil, failed: true, groups: []) == .failed)
        #expect(UpNextPresentation.phase(snapshot([]), failed: false, groups: []) == .empty)
        #expect(UpNextPresentation.phase(snapshot([], failed: 2), failed: false, groups: []) == .failed)
        let snap = snapshot([section([item(1)])], failed: 1)
        let groups = UpNextPresentation.groups(snap, sort: .newest)
        #expect(UpNextPresentation.phase(snap, failed: true, groups: groups) == .ready)
        #expect(UpNextPresentation.phase(snap, failed: false, groups: []) == .empty)
    }

    @Test func labelChipsDropOnlyExactPriorityAndEpicBadgeDuplicates() {
        let labels = ["shepherd:priority", "priority", "shepherd:priority-high", "epic", "bug"]
        #expect(UpNextPresentation.labels(item(1, kind: "epic", labels: labels)) ==
                ["priority", "shepherd:priority-high", "bug"])
        #expect(UpNextPresentation.labels(item(1, labels: labels)) ==
                ["priority", "shepherd:priority-high", "epic", "bug"])
        #expect(UpNextPresentation.labels(item(1, kind: "epic", labels: ["Shepherd:Priority", "Epic"])) ==
                ["Shepherd:Priority", "Epic"])
    }

    @Test func selectionIsRepoScopedAndUsesOnlyTheCurrentFilteredSnapshot() {
        let state = UpNextPanelState()
        let a = item(1)
        let b = item(1, repo: "/b")
        state.toggle(a)
        #expect(state.selectedItems(in: [a, b]) == [a])
        state.toggle(b)
        #expect(state.selectedItems(in: [b]) == [b])
        state.reconcile([b])
        #expect(state.selectedItems(in: [a, b]) == [b])
    }

    @Test func atMostThreeStartsImmediatelyButFourRequiresMatchingConfirmation() async {
        let state = UpNextPanelState()
        let gate = SessionCommandState()
        var calls: [[UpNextStartItem]] = []
        let commands = UpNextCommands(start: { items, _ in
            calls.append(items)
            return .init(outcome: .held, body: .init(created: [], held: [], errors: []))
        })
        #expect(await state.requestStart([item(1), item(2), item(3)], commands: commands,
                                          gate: gate, isCurrent: { true }))
        #expect(calls.count == 1)
        let batch = (1...4).map { item($0) }
        #expect(await state.requestStart(batch, commands: commands, gate: gate, isCurrent: { true }) == false)
        #expect(calls.count == 1 && state.confirmation?.count == 4)
        // Same count with a changed target must arm again, never reuse the old confirmation.
        let changed = (2...5).map { item($0) }
        #expect(await state.requestStart(changed, commands: commands, gate: gate, isCurrent: { true }) == false)
        #expect(calls.count == 1)
        #expect(await state.requestStart(changed, commands: commands, gate: gate, isCurrent: { true }))
        #expect(calls.count == 2 && calls.last?.first?.issueRef.body == "Full issue body")
        #expect(state.confirmation == nil)
    }

    @Test func selectionChangeAndSnapshotReconciliationCancelConfirmation() async {
        let state = UpNextPanelState()
        let commands = UpNextCommands(start: { _, _ in
            Issue.record("must not launch an unconfirmed batch")
            return .init(outcome: .held, body: .init(created: [], held: [], errors: []))
        })
        let batch = (1...4).map { item($0) }
        let gate = SessionCommandState()
        _ = await state.requestStart(batch, commands: commands, gate: gate, isCurrent: { true })
        state.toggle(item(9))
        #expect(state.confirmation == nil)
        _ = await state.requestStart(batch, commands: commands, gate: gate, isCurrent: { true })
        state.reconcile(batch)
        #expect(state.confirmation == nil)
    }

    @Test func everyStatusProcessesAllThreeArraysAndPreservesIssuePayloadAndChoice() async {
        for outcome in [UpNextStartResult.Outcome.created, .held, .allErrors] {
            let state = UpNextPanelState()
            let row = item(1)
            state.toggle(row)
            let choice = UpNextStartChoice(agentProvider: .codex, model: "test", effort: "high")
            let commands = UpNextCommands(start: { items, sentChoice in
                #expect(items == [.init(repoPath: row.repoPath, issueRef: row.issueRef)])
                #expect(sentChoice == choice)
                return .init(outcome: outcome, body: .init(created: [PreviewData.session(id: "new")],
                    held: [.init(id: "held", repoPath: "/a", number: 2)],
                    errors: [.init(number: 3, error: "failed")]))
            })
            #expect(await state.requestStart([row], choice: choice, commands: commands,
                                              gate: SessionCommandState(), isCurrent: { true }))
            #expect(state.notices.map(\.kind) == [.created, .held, .errors])
            #expect(state.notices.map(\.count) == [1, 1, 1])
            #expect(state.selectedItems(in: [row]).isEmpty)
        }
    }

    @Test func emptyResponseAndThrownFailureHaveVisibleErrors() async {
        let state = UpNextPanelState()
        let gate = SessionCommandState()
        let empty = UpNextCommands(start: { _, _ in
            .init(outcome: .allErrors, body: .init(created: [], held: [], errors: []))
        })
        _ = await state.requestStart([item(1)], commands: empty, gate: gate, isCurrent: { true })
        #expect(state.notices.map(\.kind) == [.errors] && state.notices[0].count == 1)
        let failed = UpNextCommands(start: { _, _ in throw ShepherdError.unauthenticated })
        state.toggle(item(1))
        #expect(await state.requestStart([item(1)], commands: failed, gate: gate, isCurrent: { true }) == false)
        #expect(gate.message?.contains(L.t("upnext_start_failed", "1")) == true)
        #expect(state.selectedItems(in: [item(1)]).count == 1)
    }

    @Test func busyGateRejectsDuplicatesAndStaleCompletionsHaveNoNotices() async {
        let state = UpNextPanelState()
        let gate = SessionCommandState()
        var current = true
        var release: CheckedContinuation<Void, Never>?
        var calls = 0
        let commands = UpNextCommands(start: { _, _ in
            calls += 1
            await withCheckedContinuation { release = $0 }
            return .init(outcome: .created, body: .init(created: [PreviewData.session(id: "old")],
                                                        held: [], errors: []))
        })
        let first = Task { await state.requestStart([item(1)], commands: commands, gate: gate,
                                                    isCurrent: { current }) }
        let deadline = ContinuousClock.now + .seconds(10)
        while release == nil, ContinuousClock.now < deadline { await Task.yield() }
        #expect(release != nil && gate.busy)
        #expect(await state.requestStart([item(1)], commands: commands, gate: gate, isCurrent: { true }) == false)
        current = false
        release?.resume()
        #expect(await first.value == false)
        #expect(calls == 1 && state.notices.isEmpty && !gate.busy)
        #expect(await state.requestStart([item(1)], commands: commands, gate: gate, isCurrent: { false }) == false)
        #expect(calls == 1)
    }
}
}

private actor UpNextRefreshProbe {
    private(set) var calls = 0
    func accept() { calls += 1 }
}
