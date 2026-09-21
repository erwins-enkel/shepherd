import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore
extension CoreSeamTests {
struct MergeRulesTests {
    @Test func confirmationUsesGateAndActualTargetRatherThanHerdHandoff() throws {
        let git = try JSONDecoder().decode(GitState.self, from: Data(#"{"state":"open","checks":"pending","number":7,"deployConfigured":false,"headSha":"head-a","baseRefName":"release","handoff":"reviewer","handoffWho":"wrong","mergeGate":{"handoff":"merger","handoffWho":"owner","reviewBlockBy":"reviewer"}}"#.utf8))
        let confirm = MergeConfirmationRules.payload(git)
        #expect(confirm.headSha == "head-a")
        #expect(confirm.baseRefName == "release")
        #expect(confirm.handoff?.rawValue == "merger")
        #expect(confirm.handoffWho == "owner")
        #expect(confirm.reviewBlockBy == "reviewer")
    }
    func queue(_ statuses: [String], approved: Bool = true) throws -> BuildQueue {
        let rows = statuses.enumerated().map { ["id": String($0.offset), "title": "Step",
            "detail": "", "status": $0.element, "position": $0.offset] as [String: Any] }
        return try JSONDecoder().decode(BuildQueue.self, from: JSONSerialization.data(withJSONObject:
            ["sessionId": "a", "approved": approved, "steps": rows]))
    }
    @Test func trainPicksLargestRepoAndFirstSeenTie() {
        let a = MergeReadyPR(id: "a", number: 1, title: "A", url: "", repo: "/a")
        let b = MergeReadyPR(id: "b", number: 2, title: "B", url: "", repo: "/b")
        let c = MergeReadyPR(id: "c", number: 3, title: "C", url: "", repo: "/b")
        #expect(MergeRules.train([a,b]).repo == "/a")
        #expect(MergeRules.train([a,b,c]).prs == [b,c])
        #expect(MergeRules.train([a,b,c]).excluded == 1)
        #expect(MergeRules.train([]).repo == nil)
        let request = MergeRules.request(repo: "/b", base: "release", prs: [b,c])
        #expect(request.mergeTrainPrs == [2,3])
        #expect(request.planGateEnabled == false)
        #expect(request.autopilotEnabled == false)
        #expect(request.baseBranch == "release")
    }
    @Test func skippedResolvesButDoesNotRestart() throws {
        let q = try queue(["done","skipped","pending"])
        #expect(MergeRules.resolved(q) == 2)
        #expect(!MergeRules.canStart(q, status: "idle", planning: false, reviewBlocked: false, ended: false))
        let skipped = try queue(["skipped"])
        #expect(!MergeRules.canStart(skipped, status: "idle", planning: false, reviewBlocked: false, ended: false))
    }
    @Test func queueRulesCoverReviewAndDrift() throws {
        let q = try queue(["pending"])
        #expect(MergeRules.canStart(q, status: "blocked", planning: false, reviewBlocked: false, ended: false))
        #expect(!MergeRules.canStart(q, status: "running", planning: false, reviewBlocked: false, ended: false))
        #expect(!MergeRules.canStart(q, status: "idle", planning: true, reviewBlocked: true, ended: false))
        #expect(!MergeRules.drifted(q, planning: true, openPR: false))
        #expect(MergeRules.drifted(q, planning: true, openPR: true))
        let awaiting = try queue(["pending"], approved: false)
        #expect(MergeRules.canApprove(awaiting, status: "idle", planning: false, reviewBlocked: false, ended: false))
        #expect(!MergeRules.canApprove(awaiting, status: "archived", planning: false, reviewBlocked: false, ended: true))
    }
    @Test func readinessRequiresOpenNumberedUnreviewedPR() throws {
        var s = PreviewData.session(); s.readyToMerge = true
        let g = try JSONDecoder().decode(GitState.self, from: Data(#"{"state":"open","checks":"success","number":7,"deployConfigured":false}"#.utf8))
        #expect(MergeRules.ready([s], git: [s.id:g], reviewing: []).count == 1)
        #expect(MergeRules.ready([s], git: [s.id:g], reviewing: [s.id]).isEmpty)
        #expect(MergeRules.ready([s], git: [:], reviewing: []).isEmpty)
        s.readyToMerge = false
        #expect(MergeRules.ready([s], git: [s.id:g], reviewing: []).isEmpty)
    }
    @Test func readinessRejectsClosedMergedUnknownAndUnnumberedPRs() throws {
        var session = PreviewData.session()
        session.readyToMerge = true
        for state in ["closed", "merged", "future-state"] {
            let git = try JSONDecoder().decode(GitState.self, from: JSONSerialization.data(
                withJSONObject: ["state": state, "checks": "success", "number": 7,
                                 "deployConfigured": false]))
            #expect(MergeRules.ready([session], git: [session.id: git], reviewing: []).isEmpty)
        }
        let unnumbered = try JSONDecoder().decode(GitState.self, from: Data(
            #"{"state":"open","checks":"success","deployConfigured":false}"#.utf8))
        #expect(MergeRules.ready([session], git: [session.id: unnumbered], reviewing: []).isEmpty)
    }
    @Test func unknownQueueStatesCannotStartOrResolveProgress() throws {
        let unknown = try queue(["pending", "future-state"])
        #expect(MergeRules.resolved(unknown) == 0)
        #expect(!MergeRules.canStart(unknown, status: "idle", planning: false,
                                    reviewBlocked: false, ended: false))
        #expect(!MergeRules.drifted(unknown, planning: false, openPR: true))
        let skippedAndPending = try queue(["skipped", "pending"])
        #expect(MergeRules.canStart(skippedAndPending, status: "idle", planning: false,
                                   reviewBlocked: false, ended: false))
        #expect(!MergeRules.canStart(skippedAndPending, status: "idle", planning: false,
                                    reviewBlocked: false, ended: true))
    }
    @Test func owedKeepsDurableRecordsAndFiltersClearedRecordsAndRepos() throws {
        let pruned = try JSONDecoder().decode(PostMergeSteps.self, from: Data(
            #"{"sessionId":"pruned","desig":"TASK-1","repoPath":"/a","prNumber":7,"prTitle":"Ship","steps":[{"id":"one","text":"Check","postMerge":true,"doneAt":null}],"trackingIssueUrl":null,"trackingIssueNumber":null,"createdAt":1,"updatedAt":1,"clearedAt":null}"#.utf8))
        var otherRepo = pruned
        otherRepo.sessionId = "other"
        otherRepo.repoPath = "/b"
        var cleared = pruned
        cleared.sessionId = "cleared"
        cleared.clearedAt = 2
        let records = [pruned, cleared, otherRepo]
        #expect(MergeRules.owed(records, repos: []).map(\.sessionId) == ["pruned", "other"])
        #expect(MergeRules.owed(records, repos: ["/a"]).map(\.sessionId) == ["pruned"])
        #expect(MergeRules.owed(records, repos: ["/missing"]).isEmpty)
        #expect(MergeRules.owed([], repos: []).isEmpty)
    }
}
}
