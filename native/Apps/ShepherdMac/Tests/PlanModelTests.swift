import Foundation
import Observation
import ShepherdKit
import Testing

@testable import Shepherd
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
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        let profile = ServerProfile(name: "plan", baseURL: URL(string: "https://plan.invalid")!, mode: .remote)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        let model = PlanModel(store: store, app: app)
        model.reads = reads // Before the scheduled bootstrap can reach a suspension.
        return (model, store, app, defaults, suite)
    }

}

extension MacSeamTests {
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

    @Test(arguments: ["review", "release", "resume", "dismiss"], [false, true])
    func sessionSwitchRejectsTabWritesAndLateCompletions(operation: String, fails: Bool) async throws {
        let suite = "PlanTabSelectionTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        defer { app.teardown(); defaults.removePersistentDomain(forName: suite) }
        let profile = try app.addRemoteProfile(name: "fixture", address: "http://127.0.0.1:1")
        await app.activate(profile)
        let store = try #require(app.store)
        store.stop()
        app.selectedSessionID = "s1"
        let (model, session) = await fixture(approved: operation == "release")
        let latch = PlanReadLatch()
        var calls = 0
        let respond: @MainActor @Sendable () async throws -> Void = {
            calls += 1
            await latch.enter()
            if fails { throw ShepherdError.notFound }
        }
        let writer = PlanTabWriter(
            review: { _ in try await respond(); return .init(ok: true, status: .init(known: .skipped)) },
            release: { _ in try await respond(); return true },
            quota: { _, _ in try await respond(); return .init(ok: false, status: .init(known: .unreachable)) })
        let current = PlanDetailTab.currentSelection(session: session, store: store, app: app)
        let actions = PlanTabActions(session: session, model: model, writer: writer, isCurrent: current)
        defer { actions.teardown(); model.teardown() }
        let invoke: @MainActor () async -> Void = {
            switch operation {
            case "review": await actions.review()
            case "release": actions.requestConfirmation(); await actions.release()
            default: await actions.quota(resume: operation == "resume")
            }
        }
        let pending = Task { await invoke() }
        for _ in 0..<1_000 {
            if await latch.count > 0 { break }
            await Task.yield()
        }
        #expect(calls == 1)
        // Selection changes synchronously, before SwiftUI delivers onDisappear.
        app.selectedSessionID = "s2"
        #expect(!current())
        await latch.open()
        await pending.value
        #expect(actions.outcome == nil && actions.releaseNote == nil && actions.quotaOutcome == nil)
        #expect(!model.releasedGates.contains(session.id))
        await invoke()
        #expect(calls == 1, "A queued tap must not write to the session the operator left")
        app.selectedSessionID = "s1"
        #expect(current())
        app.teardown()
        #expect(!current(), "The same session id cannot revive an outgoing activation")
    }

    @Test func installRegistersTheTabAndConservativeWeakSignals() throws {
        let suite = "PlanTabTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        let previousTabs = DetailTabRegistry.tabs
        let previousQuestions = SessionSignals.planQuestionsUnanswered
        let previousReviewing = PlanSignals.planReviewing
        defer {
            app.teardown(); defaults.removePersistentDomain(forName: suite)
            DetailTabRegistry.reset()
            for tab in previousTabs { DetailTabRegistry.register(tab) }
            SessionSignals.planQuestionsUnanswered = previousQuestions
            PlanSignals.planReviewing = previousReviewing
        }
        PlanStream.install(app)
        PlanStream.install(app)
        let tabs = DetailTabRegistry.tabs.filter { $0.id == "plan" }
        #expect(tabs.count == 1)
        #expect(tabs.first?.order == 500)
        #expect(tabs.first?.systemImage == "list.bullet.rectangle")
        #expect(!SessionSignals.planQuestionsUnanswered("s1"))
        #expect(!PlanSignals.planReviewing("s1"))
        #expect(app.extensionFactories.filter { $0.key == ObjectIdentifier(PlanModel.self) }.count == 1)
        let profile = ServerProfile(name: "plan", baseURL: URL(string: "https://plan.invalid")!, mode: .remote)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        app.makeExtensions(store: store)
        let model = try #require(app.extension(PlanModel.self))
        model.reads = .init(gates: { [:] }, inflight: { [] })
        model.receive(.unknown(name: "session:plangate-reviewing", payload: try JSONEncoder().encode(
            SessionPlanGateReviewingEvent(id: "s1", reviewing: true))))
        #expect(PlanSignals.planReviewing("s1"))
        let form = VisualBlockQuestionForm(_type: .questionForm, id: "form", questions: [
            .init(id: "q", prompt: "Proceed?", kind: .init(known: .freeform)),
        ])
        let gate = PlanGate(sessionId: "s1", planHash: "hash", decision: .init(known: .changesRequested),
                            summary: "Questions", body: "", findings: [], round: 1, cap: 3,
                            approved: false, plan: "", blocks: [.init(value13: form)], updatedAt: 1)
        model.receive(.unknown(name: "session:plangate", payload: try JSONEncoder().encode(
            SessionPlanGateEvent(id: "s1", gate: gate))))
        #expect(SessionSignals.planQuestionsUnanswered("s1"))
        #expect(!PlanSignals.planReviewing("s1"))
        app.teardown()
        #expect(!SessionSignals.planQuestionsUnanswered("s1") && !PlanSignals.planReviewing("s1"))
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
