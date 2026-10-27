import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
/// PRs in Up Next: the bridge from the snapshot, banding and sorting, the card status line, the
/// sheet's action set and locks, and the session requests the actions send.
@MainActor
struct UpNextPrsTests {
    private func pr(_ number: Int, band: UpNextPr.Band, action: UpNextPr.Action?, block: UpNextPr.BlockReason? = nil,
                    checks: UpNextPr.Checks = .success, kind: UpNextPr.Kind = .regular, repo: String = "/r/web",
                    title: String = "Task", age: Int = 1, base: String? = "main", approval: Bool? = nil) -> UpNextPr {
        UpNextPr(repoPath: repo, repoLabel: DonePresentation.repoBasename(repo), number: number, title: title,
                 url: "https://github.test/o/\(DonePresentation.repoBasename(repo))/pull/\(number)", author: "kai",
                 kind: kind, createdAt: age, checks: checks, mergeable: block == .conflict ? false : true,
                 awaitingWorkflowApproval: approval, baseRefName: base, mergeMethod: "squash",
                 band: band, action: action, blockReason: block)
    }

    private func snapshot(extras: String) throws -> UpNextSnapshot {
        let json = #"{"generatedAt":1,"sections":[],"repoCount":1,"fallback":null,"failedRepoCount":0"# + extras + "}"
        return try JSONDecoder().decode(UpNextSnapshot.self, from: Data(json.utf8))
    }

    @Test func parseReadsTheContractFieldAndDropsOnlyAnUnknownBand() throws {
        let good = #"{"repoPath":"/r/web","repoSlug":"o/web","repoLabel":"web","number":911,"title":"Security check","url":"https://github.test/o/web/pull/911","author":"kai","kind":"regular","createdAt":5,"checks":"success","mergeable":true,"mergeStateStatus":"clean","latestReview":{"state":"approved","author":"pat","submittedAt":7},"baseRefName":"main","mergeMethod":"squash","closesIssue":972,"band":"ready","action":"merge","headSha":"abc","jobs":[{"name":"test","state":"success"}]}"#
        // Open enums: values this client does not know yet still decode through the contract.
        let lenient = #"{"repoPath":"/r/web","repoSlug":null,"repoLabel":"web","number":12,"title":"Odd","url":"u","author":"bot","kind":"someday","createdAt":1,"checks":"weird","mergeable":null,"band":"blocked","action":"teleport","blockReason":"solar_flare"}"#
        let unknownBand = #"{"repoPath":"/r/web","repoSlug":null,"repoLabel":"web","number":2,"title":"Future band","url":"u","author":"kai","kind":"regular","createdAt":1,"checks":"none","mergeable":null,"band":"someday"}"#
        let parsed = UpNextPrs.parse(try snapshot(extras: #","pullRequests":[\#(good),\#(lenient),\#(unknownBand)]"#))
        #expect(parsed.map(\UpNextPr.number) == [911, 12])
        let first = try #require(parsed.first)
        #expect(first.band == .ready && first.action == .merge && first.closesIssue == .init(number: 972))
        #expect(first.latestReview == .init(state: "approved", author: "pat"))
        #expect(first.mergeMethod == "squash" && first.repoSlug == "o/web" && first.mergeable == true)
        let second = parsed[1]
        #expect(second.checks == .none && second.action == nil && second.blockReason == nil && second.kind == .regular)
        #expect(second.mergeable == nil && second.repoSlug == nil)
        // Older servers, and the key missing or null: no block, no crash.
        #expect(UpNextPrs.parse(try snapshot(extras: "")).isEmpty)
        #expect(UpNextPrs.parse(try snapshot(extras: #","pullRequests":null"#)).isEmpty)
        #expect(UpNextPrs.parse(nil).isEmpty)
    }

    @Test func groupsKeepBandOrderApplyTheRepoFilterAndSortWithinABand() {
        let prs = [
            pr(5, band: .blocked, action: .fix, block: .conflict, age: 50),
            pr(1, band: .ready, action: .merge, title: "b", age: 10),
            pr(2, band: .ready, action: .merge, title: "a", age: 20),
            pr(3, band: .dependabot, action: .merge, kind: .dependabot, repo: "/r/api"),
            pr(4, band: .review, action: .review, age: 30),
        ]
        let newest = UpNextPrPresentation.groups(prs, sort: .newest)
        #expect(newest.map(\UpNextPrGroup.band) == [UpNextPr.Band.ready, .review, .blocked, .dependabot])
        #expect(newest.first?.prs.map(\UpNextPr.number) == [2, 1])
        #expect(UpNextPrPresentation.groups(prs, sort: .oldest).first?.prs.map(\UpNextPr.number) == [1, 2])
        #expect(UpNextPrPresentation.groups(prs, sort: .titleAscending).first?.prs.map(\UpNextPr.number) == [2, 1])
        // Recommended keeps the server's order.
        #expect(UpNextPrPresentation.groups(prs, sort: .recommended).first?.prs.map(\UpNextPr.number) == [1, 2])
        #expect(UpNextPrPresentation.groups(prs, sort: .newest, repos: ["/r/api"]).map(\UpNextPrGroup.band) == [UpNextPr.Band.dependabot])
        #expect(UpNextPrPresentation.groups([], sort: .newest).isEmpty)
        #expect(UpNextPrPresentation.readyCount(prs) == 2)
        // The counter only counts what can merge right now, like the web badge.
        #expect(UpNextPrPresentation.readyCount([pr(6, band: .ready, action: nil, checks: .pending)]) == 0)
        #expect(UpNextPrPresentation.bandTitle(.review) == L.t("native_ios_upnext_pr_band_review"))
    }

    @Test func statusLineNamesTheBlockThenTheCiLight() {
        let conflict = UpNextPrPresentation.statusTokens(pr(1, band: .blocked, action: .fix, block: .conflict))
        #expect(conflict.map(\UpNextPrPresentation.StatusToken.text) == [L.t("native_ios_upnext_pr_status_conflict"), L.t("native_ios_upnext_pr_ci_green")])
        #expect(conflict.map(\UpNextPrPresentation.StatusToken.tone) == [UpNextPrPresentation.Tone.red, .green] && conflict.map(\UpNextPrPresentation.StatusToken.dot) == [false, true])
        let red = UpNextPrPresentation.statusTokens(pr(2, band: .blocked, action: .fix, block: .ciFailed, checks: .failure))
        #expect(red.map(\UpNextPrPresentation.StatusToken.text) == [L.t("native_ios_upnext_pr_ci_red")] && red.first?.tone == .red)
        let approval = UpNextPrPresentation.statusTokens(pr(3, band: .blocked, action: .approveOnForge, block: .workflowApproval, checks: .none))
        #expect(approval.map(\UpNextPrPresentation.StatusToken.text) == [L.t("native_ios_upnext_pr_status_approval"), L.t("native_ios_upnext_pr_ci_none")])
        let running = UpNextPrPresentation.statusTokens(pr(4, band: .review, action: nil, checks: .pending))
        #expect(running.map(\UpNextPrPresentation.StatusToken.text) == [L.t("native_ios_upnext_pr_ci_running")] && running.first?.tone == .amber)
        #expect(UpNextPrPresentation.statusTokens(pr(5, band: .ready, action: .merge, approval: true)).first?.text == L.t("native_ios_upnext_pr_status_approval"))
    }

    @Test func sheetFactsReadTheServerFields() {
        var ready = pr(1, band: .ready, action: .merge)
        ready.latestReview = .init(state: "changes_requested", author: "pat")
        #expect(UpNextPrPresentation.mergeability(ready).text == L.t("native_ios_upnext_pr_mergeable_yes"))
        #expect(UpNextPrPresentation.reviewLabel(ready) == L.t("native_ios_upnext_pr_review_changes", "@pat"))
        #expect(UpNextPrPresentation.targetLabel(ready) == "main · Squash")
        #expect(UpNextPrPresentation.tagline(ready, now: Date(timeIntervalSince1970: 7_200.001)).prefix(2) == ["web", "@kai"])
        var bare = pr(2, band: .review, action: .review, base: nil)
        bare.mergeMethod = nil; bare.mergeable = nil; bare.author = nil
        #expect(UpNextPrPresentation.mergeability(bare).text == L.t("mergeconfirm_value_unknown"))
        #expect(UpNextPrPresentation.reviewLabel(bare) == L.t("native_ios_upnext_pr_review_none"))
        #expect(UpNextPrPresentation.targetLabel(bare) == nil)
        #expect(UpNextPrPresentation.tagline(bare).count == 2)
        #expect(UpNextPrPresentation.mergeability(pr(3, band: .blocked, action: .fix, block: .behind)).text == L.t("native_ios_upnext_pr_status_behind"))
        var closes = ready
        closes.closesIssue = .init(number: 972)
        #expect(UpNextPrPresentation.closesIssueURL(closes)?.absoluteString == "https://github.test/o/web/issues/972")
        closes.closesIssue = .init(number: 972, url: "https://forge.test/i/972")
        #expect(UpNextPrPresentation.closesIssueURL(closes)?.absoluteString == "https://forge.test/i/972")
        #expect(UpNextPrPresentation.closesIssueURL(ready) == nil)
    }

    @Test func actionsPutTheRecommendationFirstAndLockMergeWhileBlocked() {
        let blocked = pr(1, band: .blocked, action: .fix, block: .conflict)
        #expect(UpNextPrPresentation.actions(blocked) == [UpNextPr.Action.fix, .review, .merge])
        #expect(UpNextPrPresentation.isPrimary(.fix, for: blocked) && !UpNextPrPresentation.isPrimary(.merge, for: blocked))
        #expect(UpNextPrPresentation.mergeLock(blocked) == L.t("native_ios_upnext_pr_lock_conflict", "main"))
        #expect(UpNextPrPresentation.mergeLock(pr(2, band: .blocked, action: .fix, block: .behind, base: "develop")) == L.t("native_ios_upnext_pr_lock_behind", "develop"))
        #expect(UpNextPrPresentation.mergeLock(pr(3, band: .blocked, action: .fix, block: .ciFailed, checks: .failure)) == L.t("native_ios_upnext_pr_lock_ci"))
        #expect(UpNextPrPresentation.mergeLock(pr(4, band: .review, action: nil, checks: .pending)) == L.t("native_ios_upnext_pr_lock_running"))
        // Review due with green CI: review first, merge offered as a secondary action.
        let review = pr(5, band: .review, action: .review)
        #expect(UpNextPrPresentation.actions(review) == [UpNextPr.Action.review, .merge])
        #expect(UpNextPrPresentation.mergeLock(review) == nil)
        // Fix only where the server offers it: its endpoint refuses every other PR.
        #expect(UpNextPrPresentation.actions(pr(6, band: .ready, action: .merge)) == [UpNextPr.Action.merge, .review])
        let approval = pr(7, band: .blocked, action: .approveOnForge, block: .workflowApproval, checks: .none, approval: true)
        #expect(UpNextPrPresentation.actions(approval) == [UpNextPr.Action.approveOnForge, .review, .merge])
        #expect(UpNextPrPresentation.mergeLock(approval) == L.t("native_ios_upnext_pr_lock_approval"))
        let bot = pr(8, band: .dependabot, action: .dependabotRebase, block: .behind, kind: .dependabot)
        #expect(UpNextPrPresentation.actions(bot) == [UpNextPr.Action.dependabotRebase, .review, .merge])
        // An action the server recommends but this client does not offer falls back to the fixed order.
        var odd = pr(9, band: .ready, action: .dependabotRebase)
        odd.kind = .regular
        #expect(UpNextPrPresentation.actions(odd) == [UpNextPr.Action.review, .merge])
        #expect(UpNextPrPresentation.label(.fix) == L.t("native_ios_upnext_pr_action_fix"))
    }

    @Test func reviewRequestNamesThePrAndItsBaseAndSkipsThePlanGate() {
        let blocked = pr(985, band: .blocked, action: .fix, block: .conflict, title: "feat(mcp): videos", base: "main")
        let review = UpNextPrPresentation.reviewRequest(blocked, baseBranch: "develop")
        #expect(review.repoPath == "/r/web" && review.planGateEnabled == false)
        #expect(review.baseBranch == "develop" && review.prompt.contains("#985") && review.mergeTrainPrs == nil)
    }

    @Test func trainTakesUnblockedGreenDependabotPrsOfTheBiggestRepo() {
        let prs = [
            pr(1, band: .dependabot, action: .merge, kind: .dependabot, repo: "/r/api"),
            pr(2, band: .dependabot, action: .merge, kind: .dependabot, repo: "/r/web", title: "bump a"),
            pr(3, band: .dependabot, action: .merge, kind: .dependabot, repo: "/r/web", title: "bump b"),
            pr(4, band: .dependabot, action: .dependabotRebase, block: .behind, kind: .dependabot, repo: "/r/web"),
            pr(5, band: .dependabot, action: nil, checks: .pending, kind: .dependabot, repo: "/r/web"),
            pr(6, band: .ready, action: .merge),
        ]
        #expect(UpNextPrPresentation.trainCandidates(prs).map(\UpNextPr.number) == [1, 2, 3])
        let plan = UpNextPrPresentation.trainPlan(prs)
        #expect(plan?.repoPath == "/r/web" && plan?.prs.map(\UpNextPr.number) == [2, 3] && plan?.otherRepoCount == 1)
        let request = UpNextPrPresentation.trainRequest(plan!, baseBranch: "main")
        #expect(request.mergeTrainPrs == [2, 3] && request.planGateEnabled == false && request.autopilotEnabled == false)
        #expect(request.prompt.contains("- #2 bump a — https://github.test/o/web/pull/2"))
        #expect(UpNextPrPresentation.trainPlan([prs[3], prs[4], prs[5]]) == nil)
        let summary = UpNextPrPresentation.dependabotSummary(Array(prs[0..<5]))
        #expect(summary.title == L.t("native_ios_upnext_pr_updates", "5"))
        #expect(summary.ci.text == L.t("native_ios_upnext_pr_ci_some_green", "4", "5") && summary.ci.tone == .amber)
        #expect(UpNextPrPresentation.dependabotSummary(Array(prs[0..<3])).ci.text == L.t("native_ios_upnext_pr_ci_all_green"))
    }
}
}
