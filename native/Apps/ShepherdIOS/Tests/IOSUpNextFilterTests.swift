import XCTest
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

private actor PatchLog {
    private(set) var patches: [IssueFilterPatch] = []
    func record(_ patch: IssueFilterPatch) { patches.append(patch) }
}

/// The iOS Up Next default filter (#3022): badge and chips, the empty-state choice, and the
/// merged multi-server sheet (mixed marks, writes to every server).
@MainActor
final class IOSUpNextFilterTests: XCTestCase {
    private func server(_ value: IssueFilterSettings?, log: PatchLog = PatchLog()) -> IssueFilterSettingsModel {
        IssueFilterSettingsModel(reads: .init(read: { value }, write: { patch in
            await log.record(patch)
            return nil
        }), initial: value)
    }

    private func snapshot(hidden: Int, scope: Int = 0, forks: Int = 0, labels: Int = 0,
                          mineCount: Int = 1, fork: Bool = false) throws -> UpNextSnapshot {
        let json = #"""
        {"generatedAt":1,"sections":[{"kind":"repo","repoPath":"/r","repoSlug":null,"repoLabel":"repo","totalCount":1,"items":[
          {"repoPath":"/r","repoSlug":null,"repoLabel":"repo","number":1,"title":"A","url":"https://example.test/1","kind":"feature","priority":false,"createdAt":1,"labels":["bug"],"issueRef":{"number":1,"url":"https://example.test/1","title":"A"},"fromFork":\#(fork),"mine":false}]}],
         "repoCount":1,"fallback":null,"failedRepoCount":0,
         "filter":{"hiddenCount":\#(hidden),"hiddenBy":{"scope":\#(scope),"forks":\#(forks),"labels":\#(labels)},"hiddenByRepo":{"/r":\#(hidden)},
                   "optionCounts":{"scope":{"all":5,"mine_unassigned":3,"mine":\#(mineCount)},"forks":{"all":3,"own":2,"hide":1}}}}
        """#
        return try JSONDecoder().decode(UpNextSnapshot.self, from: Data(json.utf8))
    }

    private func source(_ settings: IssueFilterSettingsModel, _ snapshot: UpNextSnapshot? = nil,
                        name: String? = nil) -> IOSUpNextFilter.Source {
        .init(name: name, settings: settings, snapshot: snapshot, repos: [])
    }

    func testBadgeCountsActiveRulesAndChipsNameThem() throws {
        let rules = IssueFilterSettings(scope: .mine, forks: .all, hiddenLabels: ["wip"])
        let filter = IOSUpNextFilter([source(server(rules), try snapshot(hidden: 4, scope: 3, labels: 1))])
        XCTAssertTrue(filter.isAvailable)
        XCTAssertEqual(filter.chips, [L.t("upnext_filter_chip_scope_mine"), L.t("upnext_filter_chip_label", "wip")])
        XCTAssertEqual(filter.count, rules.activeRuleCount)
        XCTAssertTrue(filter.isActive)
        XCTAssertEqual(filter.hidden(repos: []), 4)
        XCTAssertEqual(filter.hidden(repos: ["/other"]), 0)
        XCTAssertEqual(L.t("native_ios_upnext_filter_button", String(filter.count)), "Filter · 2")

        let open = IOSUpNextFilter([source(server(IssueFilterSettings(scope: .all)))])
        XCTAssertEqual(open.count, 0)
        XCTAssertFalse(open.isActive)
        XCTAssertTrue(open.chips.isEmpty)
        XCTAssertFalse(open.isDefault, "scope .all differs from the default mine & unassigned")
    }

    func testServerWithoutTheSettingShowsNoFilter() {
        let filter = IOSUpNextFilter([source(server(nil))])
        XCTAssertFalse(filter.isAvailable)
        XCTAssertEqual(IOSUpNextEmpty.choose(filter, repos: []), .plain)
    }

    func testEmptyStateIsFilteredOnlyWhenTheFilterHidSomething() throws {
        let plain = IOSUpNextFilter([source(server(.defaults), try snapshot(hidden: 0))])
        XCTAssertEqual(IOSUpNextEmpty.choose(plain, repos: []), .plain)

        let hidden = IOSUpNextFilter([source(server(.defaults), try snapshot(hidden: 3, scope: 2, labels: 1))])
        XCTAssertEqual(IOSUpNextEmpty.choose(hidden, repos: []), .filtered(hidden: 3, reasons: [
            L.t("upnext_filter_empty_by_scope", "2"), L.t("upnext_filter_empty_by_labels", "1"),
        ]))
        // A repo filter keeps the count for that repo but drops the queue-wide breakdown.
        XCTAssertEqual(IOSUpNextEmpty.choose(hidden, repos: ["/r"]), .filtered(hidden: 3, reasons: []))
        XCTAssertEqual(IOSUpNextEmpty.choose(hidden, repos: ["/other"]), .plain)
    }

    func testMergedServersSumHiddenAndCountsAndUnionChips() throws {
        let a = server(IssueFilterSettings(scope: .mine)), b = server(IssueFilterSettings(scope: .mine, forks: .hide))
        let filter = IOSUpNextFilter([source(a, try snapshot(hidden: 2, scope: 2, mineCount: 1, fork: true), name: "studio"),
                                      source(b, try snapshot(hidden: 1, forks: 1, mineCount: 4), name: "laptop")])
        XCTAssertEqual(filter.chips, [L.t("upnext_filter_chip_scope_mine"), L.t("upnext_filter_chip_forks_hide")])
        XCTAssertEqual(filter.hidden(repos: []), 3)
        XCTAssertEqual(filter.count(IssueFilterSettings.Scope.mine), 5)
        XCTAssertEqual(filter.count(IssueFilterSettings.Forks.hide), 2)
        XCTAssertEqual(filter.forkRepos, ["repo"])
        XCTAssertEqual(IOSUpNextEmpty.choose(filter, repos: []), .filtered(hidden: 3, reasons: [
            L.t("upnext_filter_empty_by_scope", "2"), L.t("upnext_filter_empty_by_forks", "1"),
        ]))
    }

    func testDifferingServersShowMixedUntilAPickAppliesToAll() async throws {
        let logA = PatchLog(), logB = PatchLog()
        let a = server(IssueFilterSettings(scope: .mine, hiddenLabels: ["wip"]), log: logA)
        let b = server(IssueFilterSettings(scope: .all), log: logB)
        var filter = IOSUpNextFilter([source(a), source(b)])
        XCTAssertEqual(filter.mark(IssueFilterSettings.Scope.mine), .mixed)
        XCTAssertEqual(filter.mark(IssueFilterSettings.Scope.all), .mixed)
        XCTAssertEqual(filter.mark(IssueFilterSettings.Scope.mineUnassigned), .off)
        XCTAssertEqual(filter.mark(IssueFilterSettings.Forks.all), .on)
        XCTAssertEqual(filter.mark(label: "WIP"), .mixed)

        for task in filter.setScope(.mine) { await task.value }
        for task in filter.setLabel("wip", hidden: true) { await task.value }
        filter = IOSUpNextFilter([source(a), source(b)])
        XCTAssertEqual(filter.mark(IssueFilterSettings.Scope.mine), .on)
        XCTAssertEqual(filter.mark(IssueFilterSettings.Scope.all), .off)
        XCTAssertEqual(filter.mark(label: "wip"), .on)
        let patchesA = await logA.patches, patchesB = await logB.patches
        XCTAssertEqual(patchesA, [IssueFilterPatch(scope: .mine)], "a label already hidden is not rewritten")
        XCTAssertEqual(patchesB, [IssueFilterPatch(scope: .mine), IssueFilterPatch(hiddenLabels: ["wip"])])

        for task in filter.reset() { await task.value }
        XCTAssertEqual(a.value?.scope, IssueFilterSettings.defaults.scope)
        XCTAssertEqual(b.value?.hiddenLabels, [])
        XCTAssertTrue(IOSUpNextFilter([source(a), source(b)]).isDefault)
    }
}
