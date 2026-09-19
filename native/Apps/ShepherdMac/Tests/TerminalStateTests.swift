import Foundation
import Testing
import ShepherdKit

@testable import Shepherd

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

@MainActor
struct TerminalStateTests {
    private func makeModel(
        _ attachment: FakeAttachment,
        reply: @escaping @Sendable (String) async throws -> Void = { _ in }
    ) -> TerminalSessionModel {
        TerminalSessionModel(
            sessionID: "s1", reply: reply, makeAttachment: { _, _ in attachment })
    }

    @Test func startsIdle() {
        let model = makeModel(FakeAttachment())
        #expect(model.phase == .idle)
        #expect(model.promptBusy == false)
    }

    @Test func attachingConnectsAndGoesLive() async {
        let attachment = FakeAttachment()
        let model = makeModel(attachment)

        model.attach(cols: 120, rows: 40)
        #expect(model.phase == .connecting)
        #expect(attachment.startCount == 1)

        attachment.emit(.attached)
        #expect(await settle(until: { model.phase == .live }))
    }

    @Test func outputReachesTheViewAfterItSubscribes() async {
        let attachment = FakeAttachment()
        let model = makeModel(attachment)
        model.attach(cols: 80, rows: 24)
        attachment.emit(.attached)
        #expect(await settle(until: { model.phase == .live }))

        // Bytes that land before the view exists must not be lost: the first
        // paint of a session IS the replayed scrollback.
        attachment.emit(bytes: Data("early".utf8))
        let seen = Recorder()
        model.onOutput = { seen.append($0) }
        #expect(await settle(until: { seen.joined() == "early" }))

        attachment.emit(bytes: Data("later".utf8))
        #expect(await settle(until: { seen.joined() == "earlylater" }))
    }

    @Test func reattachClearsTheBufferAndReSendsTheSize() async {
        let attachment = FakeAttachment()
        let model = makeModel(attachment)
        let cleared = Counter()
        model.onClear = { cleared.bump() }
        model.attach(cols: 80, rows: 24)

        attachment.emit(.attached)
        #expect(await settle(until: { model.phase == .live }))
        attachment.emit(.detached)
        #expect(await settle(until: { model.phase == .connecting }))
        attachment.emit(.reattached)

        // The server replays the scrollback on every attach; appending instead
        // of clearing would double every line.
        #expect(await settle(until: { cleared.value == 1 && model.phase == .live }))
        #expect(await settle(until: { attachment.sizes.last?.cols == 80 }))
    }

    @Test func supersededParksAndTakeOverReattaches() async {
        let attachment = FakeAttachment()
        let model = makeModel(attachment)
        model.attach(cols: 80, rows: 24)
        attachment.emit(.attached)
        #expect(await settle(until: { model.phase == .live }))

        attachment.emit(.closed(.superseded))
        #expect(await settle(until: { model.phase == .superseded }))

        model.takeOver()
        #expect(attachment.takeOverCount == 1)
        #expect(model.phase == .connecting)
    }

    @Test func goneAndUnreachableEndTheSession() async {
        let goneAttachment = FakeAttachment()
        let gone = makeModel(goneAttachment)
        gone.attach(cols: 80, rows: 24)
        goneAttachment.emit(.closed(.gone))
        #expect(await settle(until: { gone.phase == .ended(.gone) }))

        let deadAttachment = FakeAttachment()
        let dead = makeModel(deadAttachment)
        dead.attach(cols: 80, rows: 24)
        deadAttachment.emit(.closed(.unreachable))
        #expect(await settle(until: { dead.phase == .ended(.unreachable) }))
    }

    @Test func promptIsBusyWhileTheReplyIsInFlight() async {
        let gate = Gate()
        let model = makeModel(FakeAttachment(), reply: { _ in await gate.wait() })
        model.promptText = "go ahead"

        let submitted = Task { await model.submitPrompt() }
        #expect(await settle(until: { gate.isWaiting }))
        #expect(model.promptBusy)
        // The field clears optimistically so the operator can keep typing.
        #expect(model.promptText.isEmpty)

        gate.open()
        _ = await submitted.value
        #expect(model.promptBusy == false)
        #expect(model.promptError == nil)
    }

    @Test func aFailedReplyRestoresTheTextAndShowsWhy() async {
        let model = makeModel(FakeAttachment(), reply: { _ in throw ShepherdError.notFound })
        model.promptText = "go ahead"

        await model.submitPrompt()

        #expect(model.promptBusy == false)
        #expect(model.promptText == "go ahead")
        #expect(model.promptError == L.t("native_terminal_prompt_failed"))
    }

    @Test func blankPromptsAreNotSent() async {
        let sentBox = Counter()
        // `reply` is nonisolated and `@Sendable`; `Counter` is `@MainActor`,
        // so the hop is explicit.
        let model = makeModel(FakeAttachment(), reply: { _ in await sentBox.bump() })
        model.promptText = "   \n "

        await model.submitPrompt()

        #expect(sentBox.value == 0)
        #expect(model.promptBusy == false)
    }

    @Test func detachAfterASubmitDiscardsTheStaleCompletion() async {
        let gate = Gate()
        let model = makeModel(FakeAttachment(), reply: { _ in
            await gate.wait()
            throw ShepherdError.notFound
        })
        model.promptText = "go ahead"

        let submitted = Task { await model.submitPrompt() }
        #expect(await settle(until: { gate.isWaiting }))
        // The operator switched away and came back: detach + attach bump the
        // generation the in-flight reply captured.
        model.detach()
        model.attach(cols: 80, rows: 24)
        gate.open()
        _ = await submitted.value

        // The stale failure must not paint an error over the fresh attach.
        #expect(model.promptError == nil)
        #expect(model.promptBusy == false)
    }
}

@MainActor
struct TerminalRegistrationTests {
    private func makeApp() -> AppModel {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
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

    @Test func detachThenAttachKeepsASupersededTerminalParked() async {
        let factory = FakeAttachmentFactory()
        let model = makeModel(factory)
        model.attach(cols: 80, rows: 24)
        factory.made[0].emit(.closed(.superseded))
        #expect(await settle(until: { model.phase == .superseded }))

        model.detach()
        model.attach(cols: 80, rows: 24)

        // No second socket, and the banner the operator left is still there.
        #expect(model.phase == .superseded)
        #expect(factory.made.count == 1)
    }

    @Test func detachThenAttachKeepsAGoneSessionParked() async {
        let factory = FakeAttachmentFactory()
        let model = makeModel(factory)
        model.attach(cols: 80, rows: 24)
        factory.made[0].emit(.closed(.gone))
        #expect(await settle(until: { model.phase == .ended(.gone) }))

        model.detach()
        model.attach(cols: 80, rows: 24)

        #expect(model.phase == .ended(.gone))
        #expect(factory.made.count == 1)
    }

    @Test func takeOverIsTheOneWayOutOfAParkedTerminal() async {
        let factory = FakeAttachmentFactory()
        let model = makeModel(factory)
        model.attach(cols: 80, rows: 24)
        factory.made[0].emit(.closed(.unreachable))
        #expect(await settle(until: { model.phase == .ended(.unreachable) }))
        model.detach()
        model.attach(cols: 80, rows: 24)

        model.takeOver()

        // `detach` dropped the attachment, so the take-over is a fresh socket
        // rather than a no-op on a dead one.
        #expect(model.phase == .connecting)
        #expect(factory.made.count == 2)
        #expect(factory.made[1].startCount == 1)
    }

    @Test func detachStopsTheAttachmentExactlyOnce() async {
        let factory = FakeAttachmentFactory()
        let model = makeModel(factory)
        model.attach(cols: 80, rows: 24)
        factory.made[0].emit(.attached)
        #expect(await settle(until: { model.phase == .live }))

        model.detach()
        model.detach()

        #expect(factory.made[0].stopCount == 1)
    }

    @Test func aStoppedSocketIsDroppedSoTheNextAttachRebuilds() async {
        let factory = FakeAttachmentFactory()
        let model = makeModel(factory)
        model.attach(cols: 80, rows: 24)
        // `stop()` is terminal for an attachment instance: a socket that closed
        // itself must never be handed a second `start()`.
        factory.made[0].emit(.closed(.stopped))
        #expect(await settle(until: { model.phase == .idle }))

        model.attach(cols: 80, rows: 24)

        #expect(model.phase == .connecting)
        #expect(factory.made.count == 2)
        #expect(factory.made[1].startCount == 1)
    }
}

@MainActor
struct PTYCommandQueueTests {
    @Test func commandsRunInOrderAndNeverBeforeThePrologue() async {
        let log = CommandLog()
        let drained = Counter()
        let queue = PTYCommandQueue(
            prologue: { await log.append("taps") },
            epilogue: { Task { @MainActor in drained.bump() } })

        queue.enqueue { await log.append("start") }
        queue.enqueue { await log.append("send") }
        queue.enqueue { await log.append("stop") }
        queue.finish()

        #expect(await settle(until: { drained.value == 1 }))
        #expect(await log.entries == ["taps", "start", "send", "stop"])
    }

    @Test func nothingRunsAfterFinish() async {
        let log = CommandLog()
        let drained = Counter()
        let queue = PTYCommandQueue(
            prologue: {}, epilogue: { Task { @MainActor in drained.bump() } })

        queue.enqueue { await log.append("stop") }
        queue.finish()
        queue.enqueue { await log.append("takeOver") }

        #expect(await settle(until: { drained.value == 1 }))
        // A take-over that outran a stop would reopen the socket with no taps
        // on it, and the view would sit in "connecting" for ever.
        #expect(await log.entries == ["stop"])
    }
}
