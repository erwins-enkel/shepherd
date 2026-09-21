import Foundation
import Testing
import ShepherdKit
import SwiftTerm

@testable import Shepherd
@testable import ShepherdAppCore

/// Yields until `condition` holds or the budget runs out. Mirrors
/// `AppModelTests.settle`: everything here is main-actor work a yield lets run.
@MainActor
private func settle(until condition: () -> Bool, yields: Int = 500) async -> Bool {
    for _ in 0..<yields {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
}

/// Main-actor recorders the test closures write into. `@MainActor` makes them
/// implicitly `Sendable`, so a `@Sendable` reply closure may capture them.
@MainActor
final class Recorder {
    private var chunks: [Data] = []
    func append(_ data: Data) { chunks.append(data) }
    func joined() -> String { String(decoding: chunks.reduce(Data(), +), as: UTF8.self) }
}

@MainActor
final class Counter {
    private(set) var value = 0
    func bump() { value += 1 }
}

/// A hand-driven stand-in for a live `PTYConnection`.
@MainActor
final class FakeAttachment: PTYAttaching {
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private(set) var takeOverCount = 0
    private(set) var sent: [Data] = []
    private(set) var sizes: [(cols: Int, rows: Int)] = []

    private let outputContinuation: AsyncStream<Data>.Continuation
    private let lifecycleContinuation: AsyncStream<PTYConnection.LifecycleEvent>.Continuation
    let output: AsyncStream<Data>
    let lifecycle: AsyncStream<PTYConnection.LifecycleEvent>

    init() {
        (output, outputContinuation) = AsyncStream<Data>.makeStream()
        (lifecycle, lifecycleContinuation) = AsyncStream<PTYConnection.LifecycleEvent>.makeStream()
    }

    func start() { startCount += 1 }
    func stop() { stopCount += 1 }
    func takeOver() { takeOverCount += 1 }
    func send(_ bytes: Data) { sent.append(bytes) }
    func resize(cols: Int, rows: Int) { sizes.append((cols, rows)) }

    func emit(_ event: PTYConnection.LifecycleEvent) { lifecycleContinuation.yield(event) }
    func emit(bytes: Data) { outputContinuation.yield(bytes) }
}

extension MacSeamTests {
@MainActor
struct TerminalStateTests {
    @Test func goneSessionReadsThenResumesBeforeReattaching() async {
        let attachment = FakeAttachment()
        var operations: [String] = []
        var session = PreviewData.session(id: "s1", status: .init(known: .done))
        session.claudeSessionId = "conversation"
        let model = TerminalSessionModel(sessionID: "s1",
            readSession: { operations.append("read"); return session },
            resumeSession: {
                #expect(attachment.takeOverCount == 0)
                operations.append("resume")
            }, reply: { _ in }, makeAttachment: { _, _ in attachment })
        model.attach(cols: 80, rows: 24)
        attachment.emit(.closed(.gone))
        #expect(await settle(until: { model.phase == .ended(.gone) }))
        #expect(operations.isEmpty)
        await model.recoverGoneSession()
        #expect(operations == ["read", "resume"])
        #expect(attachment.takeOverCount == 1)
        #expect(model.phase == .connecting)
        model.detach()
    }

    @Test func failedGoneSessionResumeStaysParkedWithAnExplanation() async {
        let attachment = FakeAttachment()
        var session = PreviewData.session(id: "s1", status: .init(known: .done))
        session.claudeSessionId = "conversation"
        let model = TerminalSessionModel(sessionID: "s1", readSession: { session },
            resumeSession: { throw ShepherdError.transport("offline") },
            reply: { _ in }, makeAttachment: { _, _ in attachment })
        model.attach(cols: 80, rows: 24)
        attachment.emit(.closed(.gone))
        #expect(await settle(until: { model.phase == .ended(.gone) }))
        await model.recoverGoneSession()
        #expect(model.phase == .ended(.gone))
        #expect(attachment.takeOverCount == 0)
        #expect(model.sessionRecoveryError != nil)
        model.detach()
    }

    @Test(arguments: [false, true])
    func unavailableGoneSessionReloadsListWithoutResuming(deleted: Bool) async {
        let attachment = FakeAttachment()
        var reloads = 0
        var resumes = 0
        let model = TerminalSessionModel(sessionID: "s1", readSession: {
            if deleted { throw ShepherdError.notFound }
            return PreviewData.session(id: "s1", status: .init(known: .archived))
        }, resumeSession: { resumes += 1 }, reloadSessions: { reloads += 1 },
            reply: { _ in }, makeAttachment: { _, _ in attachment })
        model.attach(cols: 80, rows: 24)
        attachment.emit(.closed(.gone))
        #expect(await settle(until: { model.phase == .ended(.gone) }))
        await model.recoverGoneSession()
        #expect(reloads == 1)
        #expect(resumes == 0)
        #expect(attachment.takeOverCount == 0)
        #expect(model.phase == .ended(.gone))
        #expect(model.sessionRecoveryError != nil)
        model.detach()
    }

    @Test(arguments: ["running", "terminal", "no-conversation", "authentication"])
    func ineligibleGoneSessionNeverResumesOrReattaches(reason: String) async {
        let attachment = FakeAttachment()
        var resumes = 0
        var session = PreviewData.session(id: "s1", status: .init(known: .done))
        session.claudeSessionId = reason == "no-conversation" ? "" : "conversation"
        session.agentProvider = AgentProvider(rawValue: "claude")
        if reason == "running" { session.status = .init(known: .running) }
        if reason == "terminal" { session.terminal = true }
        let model = TerminalSessionModel(sessionID: "s1", readSession: {
            if reason == "authentication" { throw ShepherdError.unauthenticated }
            return session
        }, resumeSession: { resumes += 1 }, reply: { _ in }, makeAttachment: { _, _ in attachment })
        model.attach(cols: 80, rows: 24)
        attachment.emit(.closed(.gone))
        #expect(await settle(until: { model.phase == .ended(.gone) }))
        await model.recoverGoneSession()
        #expect(resumes == 0)
        #expect(attachment.takeOverCount == 0)
        #expect(model.sessionRecoveryError != nil)
        model.detach()
    }

    @Test(arguments: [false, true])
    func goneRecoveryCoalescesClicksAndDetachInvalidatesAwaitedWork(holdResume: Bool) async {
        let attachment = FakeAttachment()
        let gate = Gate()
        var reads = 0
        var resumes = 0
        var session = PreviewData.session(id: "s1", status: .init(known: .done))
        session.claudeSessionId = "conversation"
        let model = TerminalSessionModel(sessionID: "s1", readSession: {
            reads += 1
            if !holdResume { await gate.wait() }
            return session
        }, resumeSession: { resumes += 1; if holdResume { await gate.wait() } },
            reply: { _ in }, makeAttachment: { _, _ in attachment })
        model.attach(cols: 80, rows: 24)
        attachment.emit(.closed(.gone))
        #expect(await settle(until: { model.phase == .ended(.gone) }))
        let task = Task { await model.recoverGoneSession() }
        #expect(await settle(until: { gate.isWaiting }))
        #expect(model.sessionRecoveryBusy)
        await model.recoverGoneSession()
        #expect(reads == 1)
        model.detach()
        gate.open()
        await task.value
        #expect(resumes == (holdResume ? 1 : 0))
        #expect(attachment.takeOverCount == 0)
        #expect(!model.sessionRecoveryBusy)
        #expect(model.sessionRecoveryError == nil)
        #expect(model.phase == .ended(.gone))
    }

    @Test func isolatedTerminalCannotResumeGoneSession() async {
        let attachment = FakeAttachment()
        var reads = 0
        let model = TerminalSessionModel(sessionID: "s1", allowsInput: false,
            readSession: { reads += 1; throw ShepherdError.notFound },
            reply: { _ in }, makeAttachment: { _, _ in attachment })
        model.attach(cols: 80, rows: 24)
        attachment.emit(.closed(.gone))
        #expect(await settle(until: { model.phase == .ended(.gone) }))
        await model.recoverGoneSession()
        #expect(reads == 0)
        #expect(attachment.takeOverCount == 0)
        model.detach()
    }

    @Test func unreachableDiagnosesWithoutReattaching() async {
        let recovery = BackendRecoveryModel(reads: .init(health: { false }, diagnostics: { throw ShepherdError.transport("offline") }))
        let attachment = FakeAttachment()
        let model = TerminalSessionModel(sessionID: "s1", recovery: recovery,
            reply: { _ in }, makeAttachment: { _, _ in attachment })
        model.attach(cols: 80, rows: 24)
        attachment.emit(.closed(.unreachable))
        #expect(await settle(until: { model.recoveryFailure == .serverUnavailable }))
        #expect(attachment.startCount == 1)
        #expect(attachment.takeOverCount == 0)
        model.detach(); recovery.teardown()
    }

    @Test(arguments: [false, true])
    func emulatorRepliesRespectLiveInputIsolation(allowsInput: Bool) async {
        let attachment = FakeAttachment()
        let replies = Counter()
        let model = TerminalSessionModel(
            sessionID: "s1", allowsInput: allowsInput,
            reply: { _ in await replies.bump() }, makeAttachment: { _, _ in attachment })
        let view = SwiftTerm.TerminalView(frame: .init(x: 0, y: 0, width: 640, height: 400))
        let coordinator = TerminalHostView.Coordinator(model: model)
        view.terminalDelegate = coordinator
        coordinator.bind(view)
        defer {
            view.terminalDelegate = nil
            coordinator.unbind()
            model.detach()
        }
        // Real emulator parsing, no keyboard event: a cursor-position query in scrollback
        // produces a reply through the same coordinator as operator keystrokes.
        view.feed(byteArray: ArraySlice("\u{1b}[6n".utf8))
        #expect(attachment.sent.isEmpty == !allowsInput)
        model.promptText = "must not reach a live agent"
        await model.submitPrompt()
        #expect(replies.value == (allowsInput ? 1 : 0))
        model.takeOver()
        #expect(attachment.takeOverCount == (allowsInput ? 1 : 0))
        model.resize(cols: 90, rows: 25)
        #expect(attachment.sizes.last?.cols == 90)
        #expect(attachment.startCount == 1)
    }

    private func makeModel(
        _ attachment: FakeAttachment,
        reply: @escaping @Sendable (String) async throws -> Void = { _ in }
    ) -> TerminalSessionModel {
        TerminalSessionModel(
            sessionID: "s1", reply: reply, makeAttachment: { _, _ in attachment })
    }

}
}

extension MacSeamTests {
@MainActor
struct TerminalResumeTests {
    private func resumableSession() -> Session {
        var session = PreviewData.session(id: "s1", status: .init(known: .done))
        session.claudeSessionId = "conversation"
        return session
    }

    @Test func resumeWaitsForTheAgentAndIgnoresRepeatedClicks() async {
        let attachment = FakeAttachment()
        let gate = Gate()
        let calls = Counter()
        let model = TerminalSessionModel(
            sessionID: "s1", readSession: { self.resumableSession() },
            resumeSession: { calls.bump(); await gate.wait() },
            reply: { _ in }, makeAttachment: { _, _ in attachment })
        model.attach(cols: 80, rows: 24)
        defer { model.detach() }
        attachment.emit(.closed(.gone))
        #expect(await settle(until: { model.phase == .ended(.gone) }))

        let task = Task { await model.recoverGoneSession() }
        #expect(await settle(until: { gate.isWaiting }))
        #expect(model.sessionRecoveryBusy)
        #expect(attachment.takeOverCount == 0)
        await model.recoverGoneSession()
        #expect(calls.value == 1)

        gate.open()
        await task.value
        #expect(!model.sessionRecoveryBusy)
        #expect(model.sessionRecoveryError == nil)
        #expect(attachment.takeOverCount == 1)
        #expect(model.phase == .connecting)
        attachment.emit(.reattached)
        #expect(await settle(until: { model.phase == .live }))
    }

    @Test func failedResumeStaysEndedAndCanBeRetried() async {
        let attachment = FakeAttachment()
        let calls = Counter()
        let model = TerminalSessionModel(
            sessionID: "s1", readSession: { self.resumableSession() },
            resumeSession: {
                calls.bump()
                if calls.value == 1 { throw ShepherdError.notFound }
            },
            reply: { _ in }, makeAttachment: { _, _ in attachment })
        model.attach(cols: 80, rows: 24)
        defer { model.detach() }
        attachment.emit(.closed(.gone))
        #expect(await settle(until: { model.phase == .ended(.gone) }))

        await model.recoverGoneSession()
        #expect(model.phase == .ended(.gone))
        #expect(!model.sessionRecoveryBusy)
        #expect(model.sessionRecoveryError == L.t(
            "native_terminal_recovery_failed", ShepherdErrorCopy.message(ShepherdError.notFound)))
        #expect(attachment.takeOverCount == 0)

        await model.recoverGoneSession()
        #expect(calls.value == 2)
        #expect(model.sessionRecoveryError == nil)
        #expect(attachment.takeOverCount == 1)
    }

    @Test(arguments: [false, true])
    func detachDiscardsResumeCompletion(fails: Bool) async {
        let attachment = FakeAttachment()
        let gate = Gate()
        let model = TerminalSessionModel(
            sessionID: "s1", readSession: { self.resumableSession() },
            resumeSession: {
                await gate.wait()
                if fails { throw ShepherdError.notFound }
            },
            reply: { _ in }, makeAttachment: { _, _ in attachment })
        model.attach(cols: 80, rows: 24)
        attachment.emit(.closed(.gone))
        #expect(await settle(until: { model.phase == .ended(.gone) }))

        let task = Task { await model.recoverGoneSession() }
        #expect(await settle(until: { gate.isWaiting }))
        model.detach()
        gate.open()
        await task.value

        #expect(!model.sessionRecoveryBusy)
        #expect(model.sessionRecoveryError == nil)
        #expect(attachment.takeOverCount == 0)
        #expect(model.phase == .ended(.gone))
    }

    @Test(arguments: [PTYConnection.Closure.gone, .unreachable, .superseded], [false, true])
    func resumeOnlyRestartsGoneSessionsWithInputEnabled(
        closure: PTYConnection.Closure, allowsInput: Bool
    ) async {
        let attachment = FakeAttachment()
        let calls = Counter()
        let model = TerminalSessionModel(
            sessionID: "s1", allowsInput: allowsInput, readSession: { self.resumableSession() },
            resumeSession: { calls.bump() },
            reply: { _ in }, makeAttachment: { _, _ in attachment })
        await model.recoverGoneSession()
        #expect(calls.value == 0)
        model.attach(cols: 80, rows: 24)
        defer { model.detach() }
        attachment.emit(.closed(closure))
        #expect(await settle(until: { model.phase != .connecting }))

        await model.recoverGoneSession()
        #expect(calls.value == (allowsInput && closure == .gone ? 1 : 0))
    }
}

@MainActor
struct TerminalRegistrationTests {
    private func makeApp() -> AppModel {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
    }

    @Test func theTerminalTabSortsAheadOfTheBuiltInPromptTab() {
        DetailTabRegistry.reset()
        TerminalInstall.install(into: makeApp())

        // order 0 is the whole point: the terminal is what the operator came for.
        #expect(DetailTabRegistry.tabs.first?.id == "terminal")
        #expect(DetailTabRegistry.tabs.first?.title == L.t("native_terminal_tab_title"))
        #expect(DetailTabRegistry.tabs.map(\.id) == ["terminal", "prompt"])
    }

    @Test func installIsIdempotent() {
        DetailTabRegistry.reset()
        let app = makeApp()
        TerminalInstall.install(into: app)
        TerminalInstall.install(into: app)

        #expect(DetailTabRegistry.tabs.filter { $0.id == "terminal" }.count == 1)
    }
}
}

/// Hands out a fresh `FakeAttachment` per call and keeps them, so a test can
/// assert how many sockets a model opened — and re-attaching never re-consumes
/// an `AsyncStream` that already has an iterator on it.
@MainActor
final class FakeAttachmentFactory {
    private(set) var made: [FakeAttachment] = []

    func make() -> FakeAttachment {
        let attachment = FakeAttachment()
        made.append(attachment)
        return attachment
    }
}

/// Records the order commands actually ran in, for the serial-queue tests.
private actor CommandLog {
    private(set) var entries: [String] = []
    func append(_ entry: String) { entries.append(entry) }
}

/// A verdict the server handed down survives a tab switch. Re-attaching behind
/// the operator's back would bump whoever took the terminal over, or spin for
/// ever on a session whose agent is gone.
@MainActor
struct TerminalParkingTests {
    private func makeModel(_ factory: FakeAttachmentFactory) -> TerminalSessionModel {
        TerminalSessionModel(
            sessionID: "s1", reply: { _ in }, makeAttachment: { _, _ in factory.make() })
    }

}

@MainActor
struct PTYCommandQueueTests {

}

/// R2: `pump(from:into:)` is the exact drain `LivePTYAttachment` uses for its
/// output relay, and `.unbounded` is the exact policy it now uses for that
/// relay's sink. Exercised directly — without a live `PTYConnection` — with a
/// hand-fed source, so the "never drop" guarantee is provable without a
/// socket.
@MainActor
struct PTYOutputRelayTests {
    private func chunk(_ i: Int) -> Data { Data([UInt8(i % 256), UInt8((i / 256) % 256)]) }

    /// Fires the whole burst into the source before anything drains the sink
    /// — the ordering a real socket can produce: `start()` can hand bytes to
    /// the kit's tap faster than the main actor gets a turn to relay them.
    private func drain(
        bufferingPolicy: AsyncStream<Data>.Continuation.BufferingPolicy, burstSize: Int
    ) async -> [Data] {
        let (source, sourceContinuation) = AsyncStream<Data>.makeStream()
        let (sink, sinkContinuation) = AsyncStream<Data>.makeStream(
            bufferingPolicy: bufferingPolicy)

        let pumpTask = Task { await pump(from: source, into: sinkContinuation) }
        for i in 0..<burstSize { sourceContinuation.yield(chunk(i)) }
        sourceContinuation.finish()
        await pumpTask.value

        var received: [Data] = []
        for await bytes in sink { received.append(bytes) }
        return received
    }

}

/// R3: `TerminalController` must not keep a model — and its socket, prompt
/// draft or parked verdict — alive forever for a session that no longer
/// exists.
@MainActor
struct TerminalControllerPruneTests {
    /// A store the test drives by hand: `events: nil` so `apply(_:)` is the
    /// only thing that ever touches `sessions`, and nothing here opens a
    /// socket.
    private func makeStore() -> SessionStore {
        let profile = ServerProfile(
            name: "test", baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local)
        let client = try! ShepherdClient(profile: profile, credentials: InMemoryCredentialStore())
        return SessionStore(client: client)
    }

    private func makeApp() -> AppModel {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
    }

    /// Every argument is a *required* property of `#/components/schemas/Session`
    /// (mirrors `ShepherdKitTests.Fixtures.session`, which this target cannot
    /// import); optionals are left at their defaults.
    private func makeSession(id: String) -> Session {
        Session(
            id: id, desig: "TASK-01", name: "session", prompt: "do the thing",
            repoPath: "/repos/demo", baseBranch: "main", branch: nil,
            worktreePath: "/repos/demo-\(id)", isolated: false,
            herdrSession: "herdr-\(id)", herdrAgentId: "agent-\(id)",
            claudeSessionId: "claude-\(id)", model: nil, effort: nil,
            readyToMerge: false, mergingSince: nil, autopilotEnabled: nil,
            autopilotPaused: false, autopilotComplete: false, planGateEnabled: nil,
            planPhase: nil, autoMergeEnabled: nil, auto: false, issueNumber: nil,
            sandboxApplied: nil, status: SessionStatus(known: .running),
            lastState: Components.Schemas.HerdrState(known: .working),
            createdAt: 1_700_000_000, updatedAt: 1_700_000_001, archivedAt: nil,
            archiveReason: nil, haltReason: nil, haltedAt: nil, manualSteps: [])
    }

}

/// R6: the `.connecting` overlay must not flash for a reattach that resolves
/// within the debounce window.
@MainActor
struct ConnectingOverlayDebouncerTests {

}
