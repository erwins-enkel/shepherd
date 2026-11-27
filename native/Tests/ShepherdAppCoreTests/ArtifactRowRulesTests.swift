import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore
extension CoreSeamTests {
/// Mirrors ui/src/lib/components/viewport/artifact-row.test.ts.
struct ArtifactRowRulesTests {
    func artifact(_ id: String, updatedAt: Int = 1, hiddenAt: Int? = nil, url: String? = nil) throws -> SessionArtifact {
        var payload: [String: Any] = ["url": url ?? "https://claude.ai/artifact/\(id)", "title": id, "versions": 2,
            "firstSeenAt": 1, "updatedAt": updatedAt, "toolUseId": NSNull()]
        payload["hiddenAt"] = hiddenAt
        return try JSONDecoder().decode(SessionArtifact.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    @Test func cardWithoutMergeCardRowWithItNothingWithoutArtifact() throws {
        let a = try artifact("a")
        #expect(ArtifactRowRules.surface([a], mergeCard: false) == .card(a))
        #expect(ArtifactRowRules.surface([a], mergeCard: true) == .mergeRow(a))
        #expect(ArtifactRowRules.surface([], mergeCard: false) == .none)
        #expect(ArtifactRowRules.surface(nil, mergeCard: true) == .none)
    }

    @Test func latestIsTheNewestShowableAndNoneWhileHidden() throws {
        let old = try artifact("old", updatedAt: 1), new = try artifact("new", updatedAt: 5)
        #expect(ArtifactRowRules.latest([new, old])?.title == "new")
        // A tie goes to the later entry.
        #expect(ArtifactRowRules.latest([try artifact("x", updatedAt: 5), new])?.title == "new")
        // Hidden while every entry carries a hide stamp; a new url shows the newest again.
        let hidden = try artifact("hidden", updatedAt: 9, hiddenAt: 10)
        #expect(ArtifactRowRules.latest([hidden]) == nil)
        #expect(ArtifactRowRules.latest([hidden, new])?.title == "hidden")
    }

    @Test func onlyClaudeArtifactLinksAreShown() throws {
        #expect(ArtifactRowRules.url(try artifact("GEQx5QVP82WzdTBfcxx313")) != nil)
        #expect(ArtifactRowRules.url(try artifact("a", url: "https://claude.ai/code/artifact/a_b-1")) != nil)
        for bad in ["http://claude.ai/artifact/a", "https://claude.ai/artifact/a?x=1", "https://claude.ai/artifact/a/",
                    "https://evil.example/artifact/a", "https://claude.ai.evil.example/artifact/a", "https://claude.ai/artifact/a\n"] {
            let entry = try artifact("a", updatedAt: 9, url: bad)
            #expect(ArtifactRowRules.url(entry) == nil)
            #expect(ArtifactRowRules.latest([entry]) == nil)
        }
    }

    @Test func factsAndVoiceOverNameVersionAndAge() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        let a = try artifact("Canvas", updatedAt: 700_000)
        #expect(ArtifactRowRules.facts(a, now: now).contains("2"))
        let label = ArtifactRowRules.accessibilityLabel(a, now: now)
        #expect(label.contains("Canvas") && label.contains("2"))
    }
}
}
