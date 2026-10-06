import ShepherdKit
import Testing
@testable import ShepherdAppCore

@MainActor
@Suite("Steer delivery")
struct SteerSendTests {
    private let steer = ComposeSteer(id: "a", label: "Tests", text: "Run the tests", inSteerBar: true, onIssues: false)

    @Test func sendingSentAndExpiry() async {
        let replyGate = SteerTestGate(), feedbackGate = SteerTestGate()
        let state = SteerSendState(settle: { await feedbackGate.wait() })
        var sent: [String] = []
        let first = Task {
            await state.send(steer, allowed: { true }, reply: { text in
                sent.append(text)
                await replyGate.wait()
            })
        }
        await replyGate.started()
        #expect(state.phase(for: steer.id) == .sending)
        #expect(state.sendingID == steer.id)
        await state.send(steer, allowed: { true }, reply: { sent.append($0) })
        #expect(sent == [steer.text])
        replyGate.open()
        await feedbackGate.started()
        #expect(state.phase(for: steer.id) == .sent)
        #expect(state.sendingID == nil)
        feedbackGate.open()
        await first.value
        #expect(state.phase(for: steer.id) == .idle)
    }

    @Test func failedReplyRetainsRetryThenClearsError() async {
        let feedbackGate = SteerTestGate()
        let state = SteerSendState(settle: { await feedbackGate.wait() })
        await state.send(steer, allowed: { true }, reply: { _ in throw ShepherdError.transport("offline") })
        guard case .failed(let error) = state.phase(for: steer.id) else {
            Issue.record("Failure must be visible on the chip"); return
        }
        #expect(!error.isEmpty)
        #expect(state.failedID == steer.id)
        #expect(state.sendingID == nil)
        var retried: String?
        let retry = Task { await state.send(steer, allowed: { true }, reply: { retried = $0 }) }
        await feedbackGate.started()
        #expect(retried == steer.text)
        #expect(state.failedID == nil)
        #expect(state.phase(for: steer.id) == .sent)
        feedbackGate.open()
        await retry.value
        #expect(state.phase(for: steer.id) == .idle)
    }

    @Test func writeBlockAndBlankTextNeverReply() async {
        let state = SteerSendState(settle: {})
        var calls = 0
        await state.send(steer, allowed: { false }, reply: { _ in calls += 1 })
        var blank = steer
        blank.text = " \n "
        await state.send(blank, allowed: { true }, reply: { _ in calls += 1 })
        #expect(calls == 0)
        #expect(state.phase(for: steer.id) == .idle)
    }

    @Test func disappearingDropsLateFailures() async {
        let gate = SteerTestGate()
        let state = SteerSendState(settle: {})
        let first = Task {
            await state.send(steer, allowed: { true }, reply: { _ in
                await gate.wait()
                throw ShepherdError.transport("late")
            })
        }
        await gate.started()
        state.reset()
        gate.open()
        await first.value
        #expect(state.phase(for: steer.id) == .idle)
        #expect(state.failedID == nil)
        #expect(state.sendingID == nil)
    }

    @Test func losingWriteAccessDropsFeedback() async {
        let gate = SteerTestGate()
        let state = SteerSendState(settle: {})
        var allowed = true
        let first = Task {
            await state.send(steer, allowed: { allowed }, reply: { _ in await gate.wait() })
        }
        await gate.started()
        allowed = false
        gate.open()
        await first.value
        #expect(state.phase(for: steer.id) == .idle)
        #expect(state.sendingID == nil)
    }

    @Test func olderTimerCannotClearRepeatedSend() async {
        let oldGate = SteerTestGate(), newGate = SteerTestGate()
        var timers = 0
        let state = SteerSendState(settle: {
            timers += 1
            if timers == 1 { await oldGate.wait() } else { await newGate.wait() }
        })
        let first = Task { await state.send(steer, allowed: { true }, reply: { _ in }) }
        await oldGate.started()
        let second = Task { await state.send(steer, allowed: { true }, reply: { _ in }) }
        await newGate.started()
        oldGate.open()
        await first.value
        #expect(state.phase(for: steer.id) == .sent)
        newGate.open()
        await second.value
        #expect(state.phase(for: steer.id) == .idle)
    }
}

@MainActor
private final class SteerTestGate {
    private var reached = false
    private var ready: CheckedContinuation<Void, Never>?
    private var release: CheckedContinuation<Void, Never>?
    func wait() async {
        await withCheckedContinuation { continuation in
            release = continuation
            reached = true
            ready?.resume(); ready = nil
        }
    }
    func started() async {
        if reached { return }
        await withCheckedContinuation { ready = $0 }
    }
    func open() { release?.resume(); release = nil }
}
