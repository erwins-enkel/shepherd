import Foundation
import Observation
import Synchronization
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

    @Test func recapFrameAfterLoadUpdatesTheObservedRow() async throws {
        let actions = ActionsModel(reads: .init(recaps: { [:] }), now: { 0 })
        defer { actions.teardown() }
        let state = DonePanelState()
        await state.reload(.init(sessions: { [self.session("a")] },
                                 recaps: { ["a": self.recap(.generating)] }))
        let changed = Mutex(false)
        withObservationTracking {
            #expect(DonePresentation.snippet(state.sessions[0],
                recap: state.recap(for: "a", actions: actions)) == state.sessions[0].name)
        } onChange: {
            changed.withLock { $0 = true }
        }
        // The existing S4 handler owns frame decoding, including post-archive finalisation.
        actions.apply(.sessionArchived(.init(id: "a")))
        actions.apply(.unknown(name: "session:recap", payload: try JSONEncoder().encode(
            Components.Schemas.SessionRecapEvent(id: "a", recap: recap()))))
        #expect(changed.withLock { $0 })
        let updated = state.recap(for: "a", actions: actions)
        #expect(DonePresentation.snippet(state.sessions[0], recap: updated) == "Shipped")
        #expect(DonePresentation.verdict(updated)?.known == .ready)
        state.apply(.unknown(name: "session:recap", payload: try JSONEncoder().encode(
            Components.Schemas.SessionRecapEvent(id: "a", recap: recap()))))
        // Done owns the final frame even after S4 prunes the archived id.
        #expect(state.recap(for: "a", actions: nil)?.state.known == .ready)
    }

    @Test func finalArchivedRecapSurvivesReconnectPruningWithAnotherLiveSession() async throws {
        let suite = "DonePanelTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        let store = try SessionStore(
            profile: ServerProfile(name: "done", baseURL: URL(string: "https://done.invalid")!,
                                   mode: .remote), credentials: InMemoryCredentialStore())
        store.apply(.sessionNew(session("b")))
        let actions = ActionsModel(store: store, app: app)
        var ready = recap()
        ready.updatedAt = 2
        let finalRecap = ready
        actions.reads = .init(recaps: { ["a": finalRecap] })
        defer {
            actions.teardown()
            store.stop()
            app.teardown()
            defaults.removePersistentDomain(forName: suite)
        }
        let state = DonePanelState()
        var listReads = 0
        var recapReads = 0
        var initial = recap(.generating)
        initial.headline = ""
        initial.body = ""
        initial.verdict = nil
        let reads = DoneReads(sessions: { listReads += 1; return [self.session("a", archivedAt: 1)] },
                              recaps: { recapReads += 1; return ["a": initial] })
        await state.reload(reads)
        let frame = ServerEvent.unknown(name: "session:recap", payload: try JSONEncoder().encode(
            Components.Schemas.SessionRecapEvent(id: "a", recap: ready)))
        actions.apply(frame)
        state.apply(frame)
        #expect(state.recap(for: "a", actions: actions)?.state.known == .ready)
        // Reconnect reconciles the live map against B, pruning archived A.
        await actions.refresh()
        #expect(await settleDetail(until: { actions.recaps["a"] == nil }))
        #expect(state.recap(for: "a", actions: actions) == ready)
        await state.reload(reads)
        #expect(listReads == 2 && recapReads == 2)
        #expect(state.recap(for: "a", actions: actions) == ready)
        #expect(DonePresentation.snippet(state.sessions[0], recap: state.recaps["a"]) == "Shipped")
        #expect(DonePresentation.verdict(state.recaps["a"])?.known == .ready)
        #expect(state.recaps["a"]?.body == "**Result**")
    }

    @Test func ownTapRetainsFinalFramesAndCloseRejectsBufferedFrames() async throws {
        let state = DonePanelState()
        let (events, signal) = AsyncStream<ServerEvent>.makeStream()
        let frame = ServerEvent.unknown(name: "session:recap", payload: try JSONEncoder().encode(
            Components.Schemas.SessionRecapEvent(id: "a", recap: recap())))
        let watching = Task { await state.follow(events) }
        signal.yield(frame)
        #expect(await settleDetail(until: { state.recaps["a"]?.state.known == .ready }))
        state.close()
        signal.yield(frame)
        signal.finish()
        await watching.value
        #expect(state.recaps.isEmpty)
    }

    @Test func activationChangeClearsTheArchivedSnapshot() async {
        let state = DonePanelState()
        state.prepare(activation: 1)
        await state.reload(.init(sessions: { [self.session("a")] }, recaps: { ["a": self.recap()] }))
        state.prepare(activation: 2)
        #expect(state.recaps.isEmpty && state.sessions.isEmpty)
    }

    @Test func repositoryFilterScopesRowsAndSelection() {
        var first = session("a")
        first.repoPath = "/repos/alpha"
        var second = session("b")
        second.repoPath = "/repos/beta"
        var third = session("c")
        third.repoPath = "/repos/gamma"
        let rows = [first, second, third]
        #expect(DonePresentation.filtered(rows, repos: []).map(\.id) == ["a", "b", "c"])
        let beta = DonePresentation.filtered(rows, repos: ["/repos/beta"])
        #expect(beta.map(\.id) == ["b"])
        #expect(DonePresentation.nextSelectedID(beta, selectedID: "a") == "b")
        #expect(DonePresentation.filtered(rows, repos: ["/repos/alpha", "/repos/gamma"])
            .map(\.id) == ["a", "c"])
        let empty = DonePresentation.filtered(rows, repos: ["/repos/missing"])
        #expect(empty.isEmpty)
        #expect(DonePresentation.nextSelectedID(empty, selectedID: "a") == nil)
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
