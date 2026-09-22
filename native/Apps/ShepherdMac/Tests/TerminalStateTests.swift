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
