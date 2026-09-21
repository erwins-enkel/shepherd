import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

/// Yields until `condition` holds or the budget runs out. Mirrors
/// `AppModelTests.settle`.
@MainActor
private func settle(until condition: () -> Bool, yields: Int = 500) async -> Bool {
    for _ in 0..<yields {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
}

extension CoreSeamTests {
/// SessionCommandState is the toolbar's gate for archive and interrupt. The
/// contract it has to keep: one command in flight at a time, a failure the
/// operator can read rather than one that only reaches the log, and a
/// completion for a store that is no longer active that changes nothing —
/// including not clearing a selection in a window that has moved on.
@MainActor
struct SessionCommandStateTests {
    @Test func busyBlocksASecondCommand() async {
        let state = SessionCommandState()
        var calls = 0
        let gate = Gate()

        let first = Task {
            await state.run(
                {
                    calls += 1
                    await gate.wait()
                },
                failureCopy: { $0 },
                isCurrent: { true })
        }
        #expect(await settle(until: { gate.isWaiting }))
        #expect(state.busy)

        let ignored = await state.run(
            { calls += 1 }, failureCopy: { $0 }, isCurrent: { true })
        #expect(!ignored)
        #expect(calls == 1)

        gate.open()
        #expect(await first.value)
        #expect(!state.busy)
        #expect(state.message == nil)
    }

    @Test func aFailureIsRenderedThroughShepherdErrorCopy() async {
        let state = SessionCommandState()
        let error = ShepherdError.notFound

        let ok = await state.run(
            { throw error },
            failureCopy: { L.t("native_archive_failed", $0) },
            isCurrent: { true })

        #expect(!ok)
        #expect(state.message == L.t("native_archive_failed", ShepherdErrorCopy.message(error)))
        #expect(!state.busy)
    }

    /// The operator switched profiles while the archive was in flight. The old
    /// server's failure must not surface over the new server's window, and the
    /// caller must not be told to clear a selection that now belongs to it.
    @Test func aStaleFailureIsDroppedSilently() async {
        let state = SessionCommandState()

        let ok = await state.run(
            { throw ShepherdError.transport("connection lost") },
            failureCopy: { L.t("native_interrupt_failed", $0) },
            isCurrent: { false })

        #expect(!ok)
        #expect(state.message == nil)
    }

    @Test func aStaleSuccessDoesNotTellTheCallerToAct() async {
        let state = SessionCommandState()

        let ok = await state.run({}, failureCopy: { $0 }, isCurrent: { false })

        #expect(!ok)
        #expect(state.message == nil)
    }

    @Test func clearDropsTheMessage() async {
        let state = SessionCommandState()
        await state.run(
            { throw ShepherdError.forbidden }, failureCopy: { $0 }, isCurrent: { true })
        #expect(state.message != nil)

        state.clear()
        #expect(state.message == nil)
    }
}
}
