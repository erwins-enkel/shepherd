import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

/// Yields until `condition` holds or the budget runs out, and reports whether
/// it held. Mirrors `AppModelTests.settle`: everything under test here is
/// main-actor work that a yield lets run, so there is nothing to sleep for.
@MainActor
private func settle(until condition: () -> Bool, yields: Int = 500) async -> Bool {
    for _ in 0..<yields {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
}

extension CoreSeamTests {
/// FirstRunSubmission is FirstRunSheet's busy/dismiss gate and resolve seam
/// (pattern: LoginSheetStateTests) — both must stay blocked while a resolve
/// is in flight, and a completion for a sheet the operator has moved on from
/// must not touch `message` or tell the caller to clear the sheet. `Gate`
/// (from AppModelTests) holds the injected resolve open so a submission can
/// be caught mid-flight instead of racing a sleep.
@MainActor
struct FirstRunSubmissionTests {
    private struct StubError: Error {}

    @Test func notDismissableWhileBusy() async {
        let submission = FirstRunSubmission()
        #expect(submission.canDismiss)

        let gate = Gate()
        let task = Task {
            await submission.submit(path: "/tmp", using: { _ in await gate.wait() }, isCurrent: { true })
        }
        #expect(await settle(until: { gate.isWaiting }))
        #expect(submission.busy)
        #expect(!submission.canDismiss)

        gate.open()
        _ = await task.value
        #expect(!submission.busy)
        #expect(submission.canDismiss)
    }

    @Test func oneResolvePerSubmissionDoubleSubmitIgnoredWhileBusy() async {
        let submission = FirstRunSubmission()
        var calls = 0
        let gate = Gate()

        let first = Task {
            await submission.submit(
                path: "/tmp",
                using: { _ in
                    calls += 1
                    await gate.wait()
                },
                isCurrent: { true })
        }
        #expect(await settle(until: { gate.isWaiting }))

        // A second submission while the first is still in flight must not
        // start a second resolve.
        let ignored = await submission.submit(
            path: "/tmp/other", using: { _ in calls += 1 }, isCurrent: { true })
        #expect(!ignored)
        #expect(calls == 1)

        gate.open()
        _ = await first.value
        #expect(calls == 1)
    }

    @Test func successReturnsClearedOnlyWhenCurrent() async {
        let submission = FirstRunSubmission()

        let cleared = await submission.submit(path: "/tmp", using: { _ in }, isCurrent: { true })
        #expect(cleared)
        #expect(submission.message == nil)
        #expect(!submission.busy)
    }

    @Test func successIsNotClearedWhenStale() async {
        let submission = FirstRunSubmission()

        let cleared = await submission.submit(path: "/tmp", using: { _ in }, isCurrent: { false })
        #expect(!cleared)
        #expect(submission.message == nil)
        #expect(!submission.busy)
    }

    @Test func failureMapsToShepherdErrorCopyWhenCurrent() async {
        let submission = FirstRunSubmission()
        let error = ShepherdError.transport("connection lost")

        let cleared = await submission.submit(
            path: "/tmp", using: { _ in throw error }, isCurrent: { true })

        #expect(!cleared)
        #expect(submission.message == L.t("native_firstrun_failed", ShepherdErrorCopy.message(error)))
    }

    @Test func aStaleFailureIsDroppedSilently() async {
        let submission = FirstRunSubmission()

        let cleared = await submission.submit(
            path: "/tmp", using: { _ in throw StubError() }, isCurrent: { false })

        #expect(!cleared)
        #expect(submission.message == nil)
        #expect(!submission.busy)
    }
}
}
