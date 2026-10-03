import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
struct RepoRecencyTests {
    private func repo(_ name: String, lastUsedAt: Int? = nil) throws -> Repo {
        var json: [String: Any] = ["name": name, "path": "/repos/\(name)", "display": name,
                                   "realPath": "/repos/\(name)", "isFork": false, "hidden": false]
        if let lastUsedAt { json["lastUsedAt"] = lastUsedAt }
        return try JSONDecoder().decode(Repo.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func session(_ repoName: String, createdAt: Int) -> Session {
        var row = PreviewData.session(id: "\(repoName)-\(createdAt)")
        row.repoPath = "/repos/\(repoName)"
        row.createdAt = createdAt
        return row
    }

    @Test func ranksByLastUseNewestFirst() throws {
        let repos = [try repo("a", lastUsedAt: 10), try repo("b", lastUsedAt: 30), try repo("c", lastUsedAt: 20)]
        #expect(RepoRecency.recent(repos, sessions: []).map(\.name) == ["b", "c", "a"])
    }

    @Test func aLiveSessionNewerThanTheBootstrapStampWins() throws {
        let repos = [try repo("a", lastUsedAt: 10), try repo("b", lastUsedAt: 30)]
        let sessions = [session("a", createdAt: 40), session("b", createdAt: 5)]
        #expect(RepoRecency.recent(repos, sessions: sessions).map(\.name) == ["a", "b"])
        #expect(RepoRecency.lastUsed(repos, sessions: sessions) == ["/repos/a": 40, "/repos/b": 30])
    }

    @Test func reposNeverUsedAreNotRecent() throws {
        let repos = [try repo("never"), try repo("used", lastUsedAt: 1), try repo("live")]
        let sessions = [session("live", createdAt: 2)]
        #expect(RepoRecency.recent(repos, sessions: sessions).map(\.name) == ["live", "used"])
    }

    @Test func recentStopsAtTheLimit() throws {
        let repos = try (1...7).map { (n: Int) in try repo("r\(n)", lastUsedAt: n) }
        #expect(RepoRecency.recent(repos, sessions: []).map(\.name) == ["r7", "r6", "r5", "r4", "r3"])
        #expect(RepoRecency.recent(repos, sessions: [], limit: 2).count == 2)
    }

    @Test func equalStampsOrderByName() throws {
        let repos = [try repo("zeta", lastUsedAt: 5), try repo("alpha", lastUsedAt: 5)]
        #expect(RepoRecency.recent(repos, sessions: []).map(\.name) == ["alpha", "zeta"])
    }

    @Test func defaultPathPrefersTheMostRecentRepo() throws {
        let repos = [try repo("first", lastUsedAt: 1), try repo("latest", lastUsedAt: 9)]
        #expect(RepoRecency.defaultPath(repos, sessions: []) == "/repos/latest")
    }

    @Test func defaultPathFallsBackToTheFirstRepo() throws {
        let repos = [try repo("first"), try repo("second")]
        #expect(RepoRecency.defaultPath(repos, sessions: []) == "/repos/first")
        #expect(RepoRecency.defaultPath([], sessions: [session("x", createdAt: 1)]) == nil)
    }

    @Test func sessionsOfUnlistedReposAreIgnored() throws {
        let repos = [try repo("listed")]
        let sessions = [session("hidden", createdAt: 99)]
        #expect(RepoRecency.lastUsed(repos, sessions: sessions).isEmpty)
        #expect(RepoRecency.defaultPath(repos, sessions: sessions) == "/repos/listed")
    }

    @Test func alphabeticalUsesNaturalOrder() throws {
        let repos = [try repo("repo10"), try repo("Beta"), try repo("repo2"), try repo("alpha")]
        #expect(RepoRecency.alphabetical(repos).map(\.name) == ["alpha", "Beta", "repo2", "repo10"])
    }

    @Test func ageReadsAsARelativeTime() {
        let now = Date(timeIntervalSince1970: 10_000)
        let twoHoursAgo = Int((now.timeIntervalSince1970 - 7_200) * 1_000)
        #expect(RepoRecency.age(twoHoursAgo, now: now, locale: Locale(identifier: "en_US")) == "2 hours ago")
        #expect(RepoRecency.age(twoHoursAgo, now: now, locale: Locale(identifier: "de_DE")) == "vor 2 Stunden")
    }
}
}
