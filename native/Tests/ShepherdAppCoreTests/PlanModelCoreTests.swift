import Foundation
import Observation
import ShepherdKit
import Testing

@testable import ShepherdAppCore

private actor PlanReadLatch {
    private(set) var count = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var opened = false

    func enter() async {
        count += 1
        if !opened { await withCheckedContinuation { waiters.append($0) } }
    }

    func open() {
        opened = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }
}

@Observable @MainActor
private final class PlanConnectionBox {
    var state: ConnectionState = .idle
}

extension CoreSeamTests {
@MainActor
struct PlanModelTests {
    private func settle(_ condition: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            if await condition() { return true }
            await Task.yield()
        }
        return await condition()
    }

    private func gate(_ summary: String = "Current") -> PlanGate {
        .init(sessionId: "s1", planHash: "hash", decision: .init(known: .approved),
              summary: summary, body: "", findings: [], round: 1, cap: 3,
              approved: true, plan: "# Plan", updatedAt: 1)
    }

    private func reads(_ gate: PlanGate? = nil) -> PlanReads {
        PlanReads(gates: { gate.map { ["s1": $0] } ?? [:] }, inflight: { [] })
    }

    private func event<T: Encodable>(_ name: String, _ payload: T) throws -> ServerEvent {
        .unknown(name: name, payload: try JSONEncoder().encode(payload))
    }

    private func reviewing(_ on: Bool, env: ReviewerEnv? = nil) throws -> ServerEvent {
        try event("session:plangate-reviewing",
                  SessionPlanGateReviewingEvent(id: "s1", reviewing: on, env: env))
    }

    private func activity(_ line: String) throws -> ServerEvent {
        try event("session:plangate-activity", SessionPlanGateActivityEvent(id: "s1", summary: line))
    }

    private func live(_ reads: PlanReads) throws -> (PlanModel, SessionStore, AppModel, UserDefaults, String) {
        let suite = "PlanModelTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        let profile = ServerProfile(name: "plan", baseURL: URL(string: "https://plan.invalid")!, mode: .remote)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        let model = PlanModel(store: store, app: app)
        model.reads = reads // Before the scheduled bootstrap can reach a suspension.
        return (model, store, app, defaults, suite)
    }

    @Test func snapshotRestoresGatesAndEnvironmentsAndClearsActivity() async throws {
        let expected = gate()
        let m = PlanModel(reads: PlanReads(gates: { ["s1": expected] }, inflight: {
            [.init(id: "s1", provider: .claude, model: "opus", effort: "high")]
        }))
        m.receive(try activity("old"))
        await m.refresh()
        #expect(m.gates["s1"] == expected)
        #expect(m.reviewing == ["s1"])
        #expect(m.reviewerEnv["s1"]?.model == "opus")
        #expect(m.reviewerEnv["s1"]?.provider?.known == .claude)
        #expect(m.activity.isEmpty)
        m.reads = reads()
        await m.refresh()
        #expect(m.gates.isEmpty && m.reviewing.isEmpty && m.reviewerEnv.isEmpty)
    }

    // "Both keys optional, handled independently."
    @Test func polymorphicGateAndPhaseAreIndependentAndNeverPatchSession() async throws {
        let (m, store, app, defaults, suite) = try live(reads(gate()))
        defer { m.teardown(); app.teardown(); defaults.removePersistentDomain(forName: suite) }
        #expect(await settle { m.gates["s1"] != nil })
        var session = PreviewData.session(id: "s1")
        session.planPhase = .init(known: .planning)
        store.apply(.sessionNew(session))
        #expect(m.canRelease(session))
        m.markReleased("s1")
        #expect(!m.canRelease(session))
        await m.refresh()
        #expect(!m.canRelease(session), "snapshot reads must not resurrect the release action")
        m.receive(try event("session:plangate", SessionPlanGateEvent(id: "s1")))
        #expect(m.releasedGates == ["s1"])
        m.receive(try event("session:plangate", SessionPlanGateEvent(id: "s1", planPhase: .init(known: .executing))))
        #expect(m.gates["s1"]?.summary == "Current")
        #expect(m.releasedGates == ["s1"])
        #expect(!m.canRelease(session), "an executing frame must suppress stale planning sessions")
        #expect(store.sessions.first?.planPhase?.known == .planning)
        m.markReleased("s1")
        m.receive(try event("session:plangate", SessionPlanGateEvent(
            id: "s1", gate: gate("Both"), planPhase: .init(unknown: "future"))))
        #expect(m.gates["s1"]?.summary == "Both")
        #expect(m.releasedGates == ["s1"])
    }

    // "A landing verdict means the review is no longer in flight."
    @Test func landedGateEndsReviewAndClearsEnvironmentAndActivity() throws {
        let m = PlanModel(reads: reads())
        m.receive(try reviewing(true, env: .init(provider: .init(known: .claude), model: "opus")))
        m.receive(try activity("Inspecting"))
        m.receive(try event("session:plangate", SessionPlanGateEvent(id: "s1", gate: gate())))
        #expect(m.gates["s1"]?.approved == true)
        #expect(m.reviewing.isEmpty && m.reviewerEnv.isEmpty && m.activity.isEmpty)
    }

    // "Env cache write runs BEFORE the transition guard."
    @Test func redundantStartUpdatesEnvironmentWithoutClearingActivity() throws {
        let m = PlanModel(reads: reads())
        m.receive(try reviewing(true, env: .init(provider: .init(known: .claude), model: "old")))
        m.receive(try activity("Inspecting"))
        m.receive(try reviewing(true, env: .init(provider: .init(known: .codex), model: "new")))
        #expect(m.reviewerEnv["s1"]?.model == "new")
        #expect(m.reviewerEnv["s1"]?.provider?.known == .codex)
        #expect(m.activity["s1"] == ["Inspecting"])
        m.receive(try reviewing(true))
        #expect(m.reviewerEnv["s1"]?.model == "new")
        m.receive(try reviewing(false))
        #expect(m.reviewerEnv.isEmpty)
    }

    // "Reset the feed on both ends of a transition."
    @Test func bothEdgesClearActivityAndFeedKeepsOnlyTwoDistinctLines() throws {
        let m = PlanModel(reads: reads())
        m.receive(try activity("stale"))
        m.receive(try reviewing(true))
        #expect(m.activity.isEmpty)
        for line in ["one", "two", "two", "three"] { m.receive(try activity(line)) }
        #expect(m.activity["s1"] == ["two", "three"])
        m.receive(try reviewing(false))
        #expect(m.activity.isEmpty)
    }

    @Test func archiveDropsGateAndReviewStateAndOpenTick() async throws {
        let m = PlanModel(reads: reads(gate()))
        await m.refresh()
        m.openPlan("s1")
        m.markReleased("s1")
        m.receive(try reviewing(true, env: .init(model: "opus")))
        m.receive(try activity("Inspecting"))
        m.receive(.sessionArchived(.init(id: "s1")))
        #expect(m.gates.isEmpty && m.reviewing.isEmpty && m.reviewerEnv.isEmpty)
        #expect(m.activity.isEmpty && m.releasedGates.isEmpty)
        m.openPlan("s1")
        #expect(m.openPlanTick["s1"] == 1)
    }

    @Test func snapshotsPruneEveryMapToBootstrappedSessions() async throws {
        let (m, store, app, defaults, suite) = try live(reads(gate()))
        defer { m.teardown(); app.teardown(); defaults.removePersistentDomain(forName: suite) }
        #expect(await settle { m.gates["s1"] != nil })
        // An empty store has not bootstrapped yet; preserve the early plan snapshot.
        m.openPlan("s1")
        m.markReleased("s1")
        await m.refresh()
        #expect(m.gates["s1"] != nil && m.releasedGates == ["s1"])
        store.apply(.sessionNew(PreviewData.session(id: "live")))
        let stale = gate()
        m.reads = PlanReads(gates: { ["s1": stale] }, inflight: {
            [.init(id: "s1", model: "old")]
        })
        await m.refresh()
        #expect(m.gates.isEmpty && m.reviewing.isEmpty && m.reviewerEnv.isEmpty)
        #expect(m.activity.isEmpty && m.releasedGates.isEmpty && m.openPlanTick.isEmpty)
    }

    @Test func archivePrunesOtherOrphansAndPreservesLiveState() async throws {
        let (m, store, app, defaults, suite) = try live(reads(gate()))
        defer { m.teardown(); app.teardown(); defaults.removePersistentDomain(forName: suite) }
        #expect(await settle { m.gates["s1"] != nil })
        store.apply(.sessionNew(PreviewData.session(id: "live")))
        for id in ["s1", "archived", "live"] {
            m.openPlan(id)
            m.markReleased(id)
            m.receive(try event("session:plangate-reviewing",
                SessionPlanGateReviewingEvent(id: id, reviewing: true, env: .init(model: "reviewer"))))
            m.receive(try event("session:plangate-activity", SessionPlanGateActivityEvent(id: id, summary: "work")))
        }
        m.receive(.sessionArchived(.init(id: "archived")))
        #expect(m.gates.isEmpty)
        #expect(m.reviewing == ["live"] && Set(m.reviewerEnv.keys) == ["live"])
        #expect(Set(m.activity.keys) == ["live"] && m.releasedGates == ["live"])
        #expect(m.openPlanTick == ["live": 1])
    }

    @Test(arguments: [false, true])
    func revokedGateReopensAfterFrameOrSnapshot(snapshot: Bool) async throws {
        let m = PlanModel(reads: reads(gate()))
        await m.refresh()
        var session = PreviewData.session(id: "s1")
        session.planPhase = .init(known: .planning)
        m.markReleased("s1")
        var revoked = gate("Reopened")
        revoked.approved = false
        revoked.decision = .init(known: .changesRequested)
        if snapshot {
            m.reads = reads(revoked)
            await m.refresh()
        } else {
            m.receive(try event("session:plangate", SessionPlanGateEvent(id: "s1", gate: revoked)))
        }
        #expect(m.releasedGates.isEmpty)
        #expect(!m.canRelease(session))
        m.receive(try event("session:plangate", SessionPlanGateEvent(id: "s1", gate: gate("Approved again"))))
        #expect(m.canRelease(session))
    }

    @Test func phaseFramesKeepReleasedGatesSuppressedUntilPlanningReopens() async throws {
        let m = PlanModel(reads: reads(gate()))
        await m.refresh()
        var session = PreviewData.session(id: "s1")
        session.planPhase = .init(known: .planning)
        // An automatic release also reaches the app without a local /go.
        m.receive(try event("session:plangate", SessionPlanGateEvent(id: "s1", planPhase: .init(known: .executing))))
        #expect(!m.canRelease(session))
        m.receive(try event("session:plangate", SessionPlanGateEvent(id: "s1", gate: gate("Adopted edit"))))
        await m.refresh()
        #expect(!m.canRelease(session))
        m.receive(try event("session:plangate", SessionPlanGateEvent(id: "s1", planPhase: .init(known: .planning))))
        #expect(m.canRelease(session))
        m.markReleased("s1")
        m.reads = reads()
        await m.refresh()
        #expect(m.releasedGates.isEmpty, "a missing gate cannot keep a local release tombstone")
    }

    @Test func questionSignalAndOpenTickAreScopedToTheSession() async {
        var g = gate()
        g.blocks = [.init(value13: .init(_type: .questionForm, id: "b", questions: [
            .init(id: "q", prompt: "Which?", kind: .init(known: .freeform))
        ]))]
        let m = PlanModel(reads: reads(g))
        await m.refresh()
        #expect(m.questionsUnanswered("s1"))
        #expect(!m.questionsUnanswered("s2"))
        g.answeredQuestionKeys = ["b q"]
        m.reads = reads(g)
        await m.refresh()
        #expect(!m.questionsUnanswered("s1"))
        m.openPlan("s1"); m.openPlan("s1"); m.openPlan("s2")
        #expect(m.openPlanTick == ["s1": 2, "s2": 1])
    }

    @Test func malformedKnownEventDoesNotReplaceGateOrEndReview() async throws {
        let m = PlanModel(reads: reads(gate()))
        await m.refresh()
        m.receive(try reviewing(true))
        let raw = """
        {"id":"s1","gate":{"sessionId":"s1","planHash":"hash","decision":"approved",
        "summary":"Invalid","body":"","findings":[],"round":1,"cap":3,"approved":true,
        "plan":"","updatedAt":1,"blocks":[{"type":"question-form","id":"bad","questions":"not an array"}]}}
        """
        m.receive(.unknown(name: "session:plangate", payload: Data(raw.utf8)))
        m.receive(.unknown(name: "session:plangate-reviewing", payload: Data("{}".utf8)))
        m.receive(.unknown(name: "unrelated", payload: nil))
        #expect(m.gates["s1"]?.summary == "Current")
        #expect(m.reviewing == ["s1"])
    }

    @Test func failedSnapshotKeepsPreviousState() async {
        let m = PlanModel(reads: reads(gate()))
        await m.refresh()
        m.reads = PlanReads(gates: { [:] }, inflight: { throw CancellationError() })
        await m.refresh()
        #expect(m.gates["s1"]?.summary == "Current")
    }

    @Test func olderSnapshotCannotOverwriteNewerRefresh() async {
        let latch = PlanReadLatch()
        let old = gate("Old")
        let m = PlanModel(reads: PlanReads(gates: { await latch.enter(); return ["s1": old] }, inflight: { [] }))
        let first = Task { await m.refresh() }
        #expect(await settle { await latch.count == 1 })
        m.reads = reads(gate("New"))
        await m.refresh()
        await latch.open()
        await first.value
        #expect(m.gates["s1"]?.summary == "New")
    }

    @Test func tapBootstrapsAndRejectsBufferedFramesAfterTeardown() async throws {
        let (m, store, app, defaults, suite) = try live(reads(gate()))
        defer { m.teardown(); app.teardown(); defaults.removePersistentDomain(forName: suite) }
        #expect(m.isSubscribed)
        #expect(await settle { m.gates["s1"] != nil })
        store.apply(try reviewing(true))
        #expect(await settle { m.reviewing == ["s1"] })
        store.apply(try event("session:plangate", SessionPlanGateEvent(id: "s1", gate: gate("Buffered"))))
        m.teardown() // The tap has queued a frame but has not resumed.
        #expect(!m.isSubscribed)
        #expect(await settle { !m.isWatchingConnection })
        #expect(m.gates["s1"]?.summary != "Buffered")
    }

    @Test(arguments: [false, true])
    func suspendedSnapshotIsDroppedAfterTeardownOrActivationChange(activation: Bool) async throws {
        let latch = PlanReadLatch()
        let expected = gate("Stale")
        let (m, store, app, defaults, suite) = try live(PlanReads(
            gates: { await latch.enter(); return ["s1": expected] }, inflight: { [] }))
        defer { m.teardown(); app.teardown(); defaults.removePersistentDomain(forName: suite) }
        #expect(await settle { await latch.count == 1 })
        if activation { app.teardown() } else { m.teardown() }
        await latch.open()
        for _ in 0..<200 { await Task.yield() }
        store.apply(try reviewing(true))
        for _ in 0..<100 { await Task.yield() }
        #expect(m.gates.isEmpty && m.reviewing.isEmpty)
    }

    @Test func reconnectReconcilesAndRearmedWatcherFinishesOnTeardown() async {
        let latch = PlanReadLatch()
        await latch.open()
        let expected = gate()
        let m = PlanModel(reads: PlanReads(gates: {
            await latch.enter(); return ["s1": expected]
        }, inflight: { [] }))
        let box = PlanConnectionBox()
        m.watchConnection { box.state }
        m.watchConnection { box.state }
        for _ in 0..<50 { await Task.yield() }
        #expect(m.isWatchingConnection)
        box.state = .live
        #expect(await settle { m.gates["s1"] != nil })
        #expect(await latch.count == 1)
        box.state = .offline(message: "down")
        for _ in 0..<50 { await Task.yield() }
        box.state = .live
        #expect(await settle { await latch.count == 2 })
        m.teardown()
        #expect(await settle { !m.isWatchingConnection })
    }

    @Test func refreshRequestsCollapseAndEventsInvalidateSuspendedSnapshot() async throws {
        let latch = PlanReadLatch()
        let stale = gate("Stale")
        let m = PlanModel(reads: PlanReads(gates: { await latch.enter(); return ["s1": stale] }, inflight: { [] }))
        m.requestRefresh()
        #expect(await settle { await latch.count == 1 })
        for _ in 0..<10 { m.requestRefresh() }
        m.receive(try event("session:plangate", SessionPlanGateEvent(id: "s1", gate: gate("Event"))))
        // The trailing reconciliation now reads the newer authoritative snapshot.
        let followup = PlanReadLatch()
        let reconciled = gate("Reconciled")
        m.reads = PlanReads(gates: {
            await followup.enter(); return ["s1": reconciled]
        }, inflight: { [] })
        await latch.open()
        #expect(await settle { await followup.count == 1 })
        #expect(m.gates["s1"]?.summary == "Event", "the stale snapshot must never land")
        await followup.open()
        #expect(await settle { m.gates["s1"]?.summary == "Reconciled" })
        for _ in 0..<100 { await Task.yield() }
        #expect(await latch.count == 1)
        #expect(await followup.count == 1, "ten requests collapse into exactly one trailing read")
        m.teardown()
    }
}
}

extension CoreSeamTests {
@Suite(.serialized)
@MainActor
struct PlanTabTests {
    private func fixture(approved: Bool = false) async -> (PlanModel, Session) {
        var session = PreviewData.session(id: "s1", status: .init(known: .idle))
        session.planPhase = .init(known: .planning)
        let gate = PlanGate(sessionId: "s1", planHash: "hash",
                            decision: .init(known: approved ? .approved : .changesRequested),
                            summary: "Verdict", body: "Review body", findings: ["Keep rollback"],
                            round: 3, cap: 3, approved: approved, plan: "# Deployment", updatedAt: 1)
        let model = PlanModel(reads: .init(gates: { ["s1": gate] }, inflight: { [] }))
        await model.refresh()
        return (model, session)
    }

    private func writer(_ status: PlanReviewTriggerKnown = .started) -> PlanTabWriter {
        .init(review: { _ in .init(ok: true, status: .init(known: status)) },
              release: { _ in true }, quota: { _, resume in
                  .init(ok: true, status: .init(known: resume ? .resumed : .dismissed))
              })
    }

    @Test func goRequiresCurrentConfirmationAndHonorsBothServerResults() async throws {
        let (model, session) = await fixture(approved: true)
        var calls = 0
        var accepted = false
        var writer = writer()
        writer.release = { _ in calls += 1; return accepted }
        let actions = PlanTabActions(session: session, model: model, writer: writer)
        defer { actions.teardown(); model.teardown() }
        await actions.release()
        #expect(calls == 0)
        actions.requestConfirmation()
        #expect(actions.confirming)
        #expect(actions.confirmationMessage.contains(session.name))
        await actions.release()
        #expect(calls == 1 && actions.canRelease)
        #expect(actions.releaseNote.map { L.t($0) } == L.t("planpanel_native_not_releasable"))
        accepted = true
        actions.requestConfirmation()
        await actions.release()
        #expect(calls == 2 && !actions.canRelease)
        #expect(actions.answerContext == nil)
        #expect(actions.chip == .view)
        actions.requestConfirmation()
        await actions.release()
        #expect(calls == 2)
    }

    @Test func changedGateAndCancelledConsentNeverRelease() async throws {
        let (model, session) = await fixture(approved: true)
        var calls = 0
        var writer = writer()
        writer.release = { _ in calls += 1; return true }
        let actions = PlanTabActions(session: session, model: model, writer: writer)
        defer { actions.teardown(); model.teardown() }
        actions.requestConfirmation()
        actions.cancelConfirmation()
        await actions.release()
        actions.requestConfirmation()
        var gate = try #require(model.gates[session.id])
        gate.planHash = "replaced"
        model.receive(.unknown(name: "session:plangate", payload: try JSONEncoder().encode(
            SessionPlanGateEvent(id: session.id, gate: gate))))
        await actions.release()
        #expect(calls == 0)
    }

    @Test func bridgeExpiresAtFourSecondsAndOutcomeAtSix() async {
        let (model, session) = await fixture()
        let clock = PlanTabClock()
        let started = PlanTabActions(session: session, model: model, writer: writer(), sleep: clock.sleep)
        let skipped = PlanTabActions(session: session, model: model, writer: writer(.skipped), sleep: clock.sleep)
        defer { started.teardown(); skipped.teardown(); model.teardown(); clock.finish() }
        await started.review()
        await skipped.review()
        #expect(started.awaitingReview)
        #expect(skipped.outcome != nil)
        var deadline = ContinuousClock.now + .seconds(10)
        while clock.durations.count < 2, ContinuousClock.now < deadline { await Task.yield() }
        #expect(clock.durations.contains(.milliseconds(4_000)))
        #expect(clock.durations.contains(.milliseconds(6_000)))
        clock.finish()
        deadline = ContinuousClock.now + .seconds(10)
        while started.awaitingReview || skipped.outcome != nil, ContinuousClock.now < deadline { await Task.yield() }
        #expect(!started.awaitingReview && skipped.outcome == nil)
    }

    @Test(arguments: [PlanReviewTriggerKnown.skipped, .errorWorktree, .errorAuth, .errorSpawn])
    func transientOutcomeDoesNotSurviveTeardownAndReactivation(status: PlanReviewTriggerKnown) async throws {
        let (model, session) = await fixture()
        let clock = PlanTabClock()
        var current = true
        let actions = PlanTabActions(session: session, model: model, writer: writer(status),
                                     isCurrent: { current }, sleep: clock.sleep)
        defer { actions.teardown(); model.teardown(); clock.finish() }
        await actions.review()
        _ = try #require(actions.outcome)
        let deadline = ContinuousClock.now + .seconds(10)
        while clock.durations.isEmpty, ContinuousClock.now < deadline { await Task.yield() }
        try #require(clock.durations == [.milliseconds(6_000)])

        // Leave before the dismissal timer fires, retaining the tab's action state.
        current = false
        actions.teardown()
        #expect(actions.outcome == nil)
        current = true
        actions.reconcile()
        #expect(actions.outcome == nil, "Returning to the tab must not resurrect its transient message")

        // The retained state remains usable for a fresh review after reactivation.
        await actions.review()
        #expect(actions.outcome != nil)
    }

    @Test func reviewingClearsBridgeUnavailableAndQuotaNotes() async throws {
        let (model, session) = await fixture()
        let clock = PlanTabClock()
        var writer = writer(.planUnavailable)
        writer.quota = { _, _ in .init(ok: false, status: .init(known: .unreachable)) }
        let actions = PlanTabActions(session: session, model: model, writer: writer, sleep: clock.sleep)
        defer { actions.teardown(); model.teardown(); clock.finish() }
        // A gate can disappear while planning. The unavailable note persists until a gate arrives.
        model.reads = .init(gates: { [:] }, inflight: { [] })
        await model.refresh()
        await actions.review()
        #expect(actions.planUnavailable)
        model.receive(.unknown(name: "session:plangate-reviewing", payload: try JSONEncoder().encode(
            SessionPlanGateReviewingEvent(id: session.id, reviewing: true))))
        actions.reconcile()
        #expect(!actions.planUnavailable && !actions.awaitingReview && actions.outcome == nil)
        #expect(actions.answerContext?.locked == true)
    }

    @Test func liveReviewWinsEvenIfItArrivesBeforeTheHTTPResponse() async throws {
        let (model, session) = await fixture()
        var writer = writer()
        writer.review = { _ in
            model.receive(.unknown(name: "session:plangate-reviewing", payload: try JSONEncoder().encode(
                SessionPlanGateReviewingEvent(id: session.id, reviewing: true))))
            return .init(ok: true, status: .init(known: .started))
        }
        let actions = PlanTabActions(session: session, model: model, writer: writer)
        defer { actions.teardown(); model.teardown() }
        await actions.review()
        #expect(actions.reviewing && !actions.awaitingReview)
    }

    @Test func teardownAndActivationChangeDiscardLateResponses() async {
        let (model, session) = await fixture()
        let latch = PlanReadLatch()
        var writer = writer()
        writer.review = { _ in await latch.enter(); return .init(ok: true, status: .init(known: .started)) }
        var current = true
        let actions = PlanTabActions(session: session, model: model, writer: writer, isCurrent: { current })
        let task = Task { await actions.review() }
        let deadline = ContinuousClock.now + .seconds(10)
        while await latch.count == 0, ContinuousClock.now < deadline { await Task.yield() }
        current = false
        actions.teardown()
        await latch.open()
        await task.value
        #expect(!actions.awaitingReview && !actions.busy)
        model.teardown()
    }

    @Test func reviewAndQuotaOutcomesUseServerStatusAndClearOnReviewing() async throws {
        let (model, session) = await fixture()
        let clock = PlanTabClock()
        var reviewStatus: PlanReviewTriggerKnown = .errorAuth
        var quotaStatus: PlanQuotaStatusKnown = .unreachable
        var calls: [Bool] = []
        var writer = writer()
        writer.review = { _ in .init(ok: true, status: .init(known: reviewStatus)) }
        writer.quota = { _, resume in
            calls.append(resume)
            return .init(ok: true, status: .init(known: quotaStatus))
        }
        let actions = PlanTabActions(session: session, model: model, writer: writer, sleep: clock.sleep)
        defer { actions.teardown(); model.teardown(); clock.finish() }
        await actions.quota(resume: true)
        #expect(actions.quotaOutcome.map { L.t($0) } == L.t("planpanel_quota_unreachable"))
        quotaStatus = .notStalled
        await actions.quota(resume: false)
        #expect(actions.quotaOutcome.map { L.t($0) } == L.t("planpanel_quota_not_stalled"))
        #expect(calls == [true, false])
        await actions.review()
        #expect(actions.outcome.map { L.t($0) } == L.t("planpanel_review_failed_auth"))
        reviewStatus = .startedAtCap
        await actions.review()
        #expect(actions.awaitingReview && actions.heldAtCap)
        model.receive(.unknown(name: "session:plangate-reviewing", payload: try JSONEncoder().encode(
            SessionPlanGateReviewingEvent(id: session.id, reviewing: true))))
        actions.reconcile()
        #expect(!actions.awaitingReview && actions.outcome == nil && actions.quotaOutcome == nil)
        #expect(actions.heldAtCap)
        await actions.quota(resume: true)
        #expect(calls.count == 2)
    }

    @Test func approvedReviewIsInertButEditedExecutionCanReview() async throws {
        let (model, session) = await fixture(approved: true)
        var calls = 0
        var writer = writer()
        writer.review = { _ in calls += 1; return .init(ok: true, status: .init(known: .skipped)) }
        let actions = PlanTabActions(session: session, model: model, writer: writer)
        defer { actions.teardown(); model.teardown() }
        #expect(actions.canReview && actions.reviewBlock == .approved)
        await actions.review()
        #expect(calls == 0)
        var gate = try #require(model.gates[session.id])
        gate.livePlanHash = "edited"
        model.receive(.unknown(name: "session:plangate", payload: try JSONEncoder().encode(
            SessionPlanGateEvent(id: session.id, gate: gate, planPhase: .init(known: .executing)))))
        #expect(actions.canReview && actions.answerContext == nil && !actions.canRelease)
        await actions.review()
        #expect(calls == 1)
    }

    @Test func reviewerEnvironmentUsesWholeLiveTripleOnlyWithProvider() async throws {
        let (model, _) = await fixture()
        var gate = try #require(model.gates["s1"])
        gate.reviewerProvider = .claude
        gate.reviewerModel = "persisted-model"
        gate.reviewerEffort = "high"
        let live = ReviewerEnv(provider: .init(known: .codex), model: "live-model", effort: "low")
        #expect(PlanEnvironment.reviewer(live: live, gate: gate).contains("live-model"))
        #expect(!PlanEnvironment.reviewer(live: live, gate: gate).contains("persisted-model"))
        #expect(PlanEnvironment.reviewer(live: .init(model: "orphan"), gate: gate).contains("persisted-model"))
        model.teardown()
    }

}
}

@MainActor
private final class PlanTabClock {
    var durations: [Duration] = []
    private var signals: [AsyncStream<Void>.Continuation] = []

    func sleep(_ duration: Duration) async throws {
        durations.append(duration)
        let (stream, signal) = AsyncStream<Void>.makeStream()
        signals.append(signal)
        for await _ in stream { break }
    }

    func finish() { for signal in signals { signal.finish() }; signals.removeAll() }
}
