import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

struct RepoProjectDraftTests {
    static let rules = RepoRules(criticEnabled: false, criticAllPrs: false, criticSmellLensEnabled: false,
        autoAddressEnabled: false, autopilotEnabled: false, planGateEnabled: false, autoDrainEnabled: false,
        autoMergeEnabled: false, buildQueueEnabled: false, draftMode: false, signoffAuthority: "either",
        manualStepsIssueEnabled: false, preWarmEpicLandingCi: false, epicStacksEnabled: false,
        autoLabel: "shepherd", defaultModel: "inherit", defaultEffort: "inherit")

    @Test func twoEditsBecomeOneSparseProjectPatch() throws {
        var draft = RepoProjectDraft(rules: Self.rules, leader: "mac")
        draft.rules.criticEnabled = true
        draft.rules.planGateEnabled = true
        #expect(try draft.changes().count == 2)
        let data = try JSONEncoder().encode(draft.patch())
        let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body.count == 1)
        let rules = try #require(body["rules"] as? [String: Bool])
        #expect(rules == ["criticEnabled": true, "planGateEnabled": true])
        #expect(draft.original.criticEnabled == false)
    }

    @Test func revertingAnEditRemovesItFromTheCommit() throws {
        var draft = RepoProjectDraft(rules: Self.rules, leader: nil)
        draft.rules.defaultEffort = "high"
        draft.rules.defaultEffort = "inherit"
        #expect(try draft.changes().isEmpty)
        let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.patch())) as? [String: Any])
        #expect(body.isEmpty)
    }

    @Test func clearingLeaderEncodesExplicitNullWhileUnchangedLeaderIsOmitted() throws {
        var draft = RepoProjectDraft(rules: Self.rules, leader: "mac")
        draft.leader = nil
        let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.patch())) as? [String: Any])
        #expect(body.count == 1)
        #expect(body["leitrechner"] is NSNull)
        #expect(try draft.changes().first?.id == "leitrechner")
    }
}
