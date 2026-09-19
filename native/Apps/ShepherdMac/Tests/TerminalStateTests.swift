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
