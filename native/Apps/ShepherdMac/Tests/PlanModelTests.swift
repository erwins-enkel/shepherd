import Foundation
import Observation
import ShepherdKit
import Testing

@testable import Shepherd

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

@MainActor
struct PlanModelTests {
    private func settle(_ condition: () async -> Bool) async -> Bool {
        for _ in 0..<1_000 {
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
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
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
        #expect(m.releasedGates.isEmpty)
        #expect(store.sessions.first?.planPhase?.known == .planning)
        m.markReleased("s1")
        m.receive(try event("session:plangate", SessionPlanGateEvent(
            id: "s1", gate: gate("Both"), planPhase: .init(unknown: "future"))))
        #expect(m.gates["s1"]?.summary == "Both")
        #expect(m.releasedGates.isEmpty)
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

    @Test func archiveDropsGateAndReviewStateWhileKeepingOpenTickMonotonic() async throws {
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
        #expect(m.openPlanTick["s1"] == 2)
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
