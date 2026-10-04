import AppKit
import Foundation
import ShepherdKit
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
@MainActor @Suite struct RepoMenuTests {
    private func repo(_ name: String) throws -> Repo {
        let json: [String: Any] = ["name": name, "path": "/repos/\(name)", "display": name,
                                   "realPath": "/repos/\(name)", "isFork": false, "hidden": false]
        return try JSONDecoder().decode(Repo.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func recentReposComeFirstThenEveryRepoInASubmenu() throws {
        let alpha = try repo("alpha"), beta = try repo("beta"), gamma = try repo("gamma")
        var picked: [String] = []
        let menu = RepoMenu.make(recent: [gamma, alpha], all: [alpha, beta, gamma], selected: alpha.path,
                                 age: { $0.name == "gamma" ? "2 hours ago" : nil }, pick: { picked.append($0) })
        #expect(menu.items.map(\.title) == [L.t("native_compose_repo_recent"), "gamma", "alpha", "", L.t("native_compose_repo_all")])
        #expect(menu.items[0].isSectionHeader)
        #expect(menu.items[3].isSeparatorItem)
        #expect(menu.items[1].subtitle == "2 hours ago")
        #expect(menu.items[2].subtitle == nil)
        #expect(menu.items.map(\.state) == [.off, .off, .on, .off, .off])
        let submenu = try #require(menu.items[4].submenu)
        #expect(submenu.items.map(\.title) == ["alpha", "beta", "gamma"])
        #expect(submenu.items.map(\.state) == [.on, .off, .off])
        menu.performActionForItem(at: 1)
        submenu.performActionForItem(at: 1)
        #expect(picked == ["/repos/gamma", "/repos/beta"])
    }

    @Test func withoutRecentReposEveryRepoIsListedFlat() throws {
        let alpha = try repo("alpha"), beta = try repo("beta")
        var picked: [String] = []
        let menu = RepoMenu.make(recent: [], all: [alpha, beta], selected: beta.path, age: { _ in nil },
                                 pick: { picked.append($0) })
        #expect(menu.items.map(\.title) == ["alpha", "beta"])
        #expect(menu.items.allSatisfy { $0.submenu == nil && !$0.isSectionHeader })
        #expect(menu.items.map(\.state) == [.off, .on])
        menu.performActionForItem(at: 0)
        #expect(picked == ["/repos/alpha"])
    }
}
}
