import Foundation
import ShepherdKit
import Testing
@testable import Shepherd

@MainActor
struct DonePanelTests {
    private func session(_ id: String, archivedAt: Int? = nil) -> Session {
        var row = PreviewData.session(id: id)
        row.archivedAt = archivedAt
        return row
    }

    private func recap(_ state: RecapStateKnown = .ready) -> Recap {
        Recap(sessionId: "a", state: .init(known: state), verdict: .init(known: .ready),
              headline: "Shipped", body: "**Result**", openItems: ["Follow up"], updatedAt: 1)
    }

    @Test func selectionIsIndependentAndFallsBackOnlyWhenMissing() {
        let rows = [session("a"), session("b")]
        #expect(DonePresentation.nextSelectedID(rows, selectedID: "b") == "b")
        #expect(DonePresentation.nextSelectedID(rows, selectedID: "live-only") == "a")
        #expect(DonePresentation.nextSelectedID([], selectedID: "a") == nil)
    }

    @Test func newestFirstWithoutClientTimeWindowing() {
        let rows = [session("old", archivedAt: 1), session("new", archivedAt: 99)]
        #expect(DonePresentation.sorted(rows).map(\.id) == ["new", "old"])
    }

    @Test func onlyReadyRecapsSupplyVerdictsAndSnippets() {
        let row = session("a")
        #expect(DonePresentation.verdict(recap(.generating)) == nil)
        #expect(DonePresentation.verdict(recap(.failed)) == nil)
        #expect(DonePresentation.verdict(recap())?.known == .ready)
        #expect(DonePresentation.snippet(row, recap: recap()) == "Shipped")
        #expect(DonePresentation.snippet(row, recap: recap(.failed)) == row.name)
        var unnamed = row
        unnamed.name = ""
        #expect(DonePresentation.snippet(unnamed, recap: nil) == row.prompt)
    }

    @Test func missingRecapsDistinguishTheExactFeatureEpoch() {
        #expect(DonePresentation.emptyCopy(session("a", archivedAt: 1_781_423_072_999), recap: nil)
                == L.t("recap_predates_feature"))
        #expect(DonePresentation.emptyCopy(session("a", archivedAt: 1_781_423_073_000), recap: nil)
                == L.t("recap_unavailable"))
        #expect(DonePresentation.emptyCopy(session("a", archivedAt: 1), recap: recap(.empty))
                == L.t("recap_empty_legacy"))
    }

    @Test func everyOpenReadsBothSnapshotsAgain() async {
        var listReads = 0
        var recapReads = 0
        let state = DonePanelState()
        let reads = DoneReads(sessions: { listReads += 1; return [self.session("a")] },
                              recaps: { recapReads += 1; return ["a": self.recap()] })
        await state.reload(reads)
        await state.reload(reads)
        #expect(listReads == 2 && recapReads == 2)
        #expect(state.sessions.map(\.id) == ["a"])
        #expect(state.recaps["a"]?.headline == "Shipped")
    }

    @Test func closedPanelDropsLateSnapshots() async {
        let gate = LoadGate()
        let state = DonePanelState()
        let task = Task {
            await state.reload(.init(sessions: { await gate.wait(); return [self.session("late")] },
                                     recaps: { [:] }))
        }
        #expect(await settleDetail(until: { gate.isWaiting }))
        state.close()
        gate.open()
        await task.value
        #expect(state.sessions.isEmpty)
    }

    @Test func failedSnapshotCanRetryAndOlderOpenCannotOverwriteNewerOpen() async {
        let gate = LoadGate()
        let state = DonePanelState()
        await state.reload(.init(sessions: { throw ShepherdError.notFound }, recaps: { [:] }))
        #expect(state.error != nil && !state.isLoading)
        let old = Task {
            await state.reload(.init(sessions: { await gate.wait(); return [self.session("old")] },
                                     recaps: { [:] }))
        }
        #expect(await settleDetail(until: { gate.isWaiting }))
        await state.reload(.init(sessions: { [self.session("new")] }, recaps: { [:] }))
        gate.open()
        await old.value
        #expect(state.sessions.map(\.id) == ["new"])
        #expect(state.error == nil && !state.isLoading)
    }

    @Test func activationChangeRejectsSnapshotEvenWithoutCancellation() async {
        let state = DonePanelState()
        await state.reload(.init(sessions: { [self.session("old-server")] }, recaps: { [:] }),
                           isCurrent: { false })
        #expect(state.sessions.isEmpty)
    }

    @Test func usageDropsLatePreviousRowAndSwallowsFailures() async throws {
        let gate = LoadGate()
        let state = DoneUsageState()
        let value = try JSONDecoder().decode(Components.Schemas.SessionUsage.self, from: Data(
            #"{"available":true,"source":"snapshot","total":42,"input":null,"output":null,"cacheRead":null,"cacheWrite":null,"messageCount":null,"byModel":null}"#.utf8))
        let old = Task { await state.load(id: "a") { _ in await gate.wait(); return value } }
        #expect(await settleDetail(until: { gate.isWaiting }))
        await state.load(id: "b") { _ in throw ShepherdError.notFound }
        gate.open()
        await old.value
        #expect(state.usage == nil)
        #expect(state.display == "—")
        await state.load(id: "b") { _ in value }
        #expect(state.usage?.total == 42)
        state.close()
        #expect(state.usage == nil)
    }

    @Test func failureCopyUsesGeneratedAdditionalProperties() throws {
        let value = try JSONDecoder().decode(Recap.self, from: Data(
            #"{"sessionId":"a","state":"failed","headline":"","body":"","openItems":[],"updatedAt":1,"failure":{"code":"auth-unavailable","provider":"codex","model":"gpt-test"}}"#.utf8))
        #expect(DonePresentation.failureHeadline(value) == L.t("recap_failure_auth_headline"))
        #expect(DonePresentation.failureAction(value) == L.t("recap_failure_auth_action"))
        #expect(DonePresentation.failureField(value, "provider") == "codex")
        #expect(DonePresentation.failureField(value, "model") == "gpt-test")
    }

    @Test(arguments: [
        ("auth-unavailable", "recap_failure_auth_headline"),
        ("source-unavailable", "recap_failure_source_headline"),
        ("launch-failed", "recap_failure_launch_headline"),
        ("timed-out", "recap_failure_timeout_headline"),
        ("no-result", "recap_failure_no_result_headline"),
        ("invalid-result", "recap_failure_invalid_result_headline"),
    ] as [(String, StaticString)])
    func everyFailureCodeHasLocalizedCopy(code: String, key: StaticString) throws {
        var value = recap(.failed)
        value.additionalProperties = try .init(unvalidatedValue: ["failure": ["code": code]])
        let copy = DonePresentation.failureHeadline(value)
        #expect(copy == L.t(key))
        #expect(copy != "\(key)")
    }

    @Test func requiredCopyResolvesAndFinishedTimeInterpolates() {
        let keys: [StaticString] = [
            "herd_done_empty", "donerecap_bringback", "donerecap_bringback_confirm",
            "recap_generating", "recap_failed", "recap_changed_files", "recap_unavailable",
            "recap_predates_feature", "recap_empty_legacy", "recap_failure_details",
            "recap_failure_provider", "recap_failure_model", "recap_failure_detail",
            "recap_failure_default_model", "usage_prompt_tokens_unit",
        ]
        for key in keys { #expect(L.t(key) != "\(key)") }
        #expect(L.t("done_recap_panel_aria", "TASK-07").contains("TASK-07"))
        let copy = DonePresentation.finished(session("a", archivedAt: 0),
                                              now: Date(timeIntervalSince1970: 3_600))
        #expect(!copy.contains("%@") && !copy.contains("%1$@"))
    }

    @Test func markdownPreservesBlockBoundariesAndInlineEmphasis() {
        let rendered = DoneMarkdown.render("# Result\n\nFirst **bold** paragraph.\n\n- One\n- Two")
        #expect(String(rendered.characters) == "Result\n\nFirst bold paragraph.\n\n• One\n\n• Two")
        #expect(rendered.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    }

    @Test func bringBackRequiresTwoClicksWithinThreeThousandMilliseconds() {
        var confirmation = DoneRestoreConfirmation()
        let first = confirmation.tap(now: 100)
        let confirmed = confirmation.tap(now: 3_099)
        let next = confirmation.tap(now: 4_000)
        let expired = confirmation.tap(now: 7_000)
        #expect(!first)
        #expect(confirmed)
        #expect(!next)
        #expect(!expired)
        confirmation.disarm()
        #expect(!confirmation.isArmed)
    }
}
