import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

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

/// NewSessionSubmission is NewSessionSheet's busy/dismiss gate and create seam
/// (pattern: LoginSheetStateTests, FirstRunSubmissionTests). What it has to
/// guarantee: one create per submission, a sheet that cannot be dismissed out
/// from under an in-flight create, a held task that keeps the sheet open with
/// an explanation instead of silently doing nothing, and a completion for a
/// store the operator has moved on from that touches neither `message` nor the
/// caller's selection.
@MainActor
struct NewSessionSubmissionTests {
    private struct StubError: Error {}

    private func request() -> CreateSessionRequest {
        CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "do the thing")
    }

    private func held() -> CreateOutcome {
        .held(HeldTask(held: true, id: "held-1", count: 3))
    }

    @Test func notDismissableWhileBusy() async {
        let submission = NewSessionSubmission()
        #expect(submission.canDismiss)

        let gate = Gate()
        let task = Task {
            await submission.submit(
                request(),
                using: { _ in
                    await gate.wait()
                    return .created(PreviewData.session())
                },
                isCurrent: { true })
        }
        #expect(await settle(until: { gate.isWaiting }))
        #expect(submission.busy)
        #expect(!submission.canDismiss)

        gate.open()
        _ = await task.value
        #expect(!submission.busy)
        #expect(submission.canDismiss)
    }

    @Test func oneCreatePerSubmissionDoubleSubmitIgnoredWhileBusy() async {
        let submission = NewSessionSubmission()
        var calls = 0
        let gate = Gate()

        let first = Task {
            await submission.submit(
                request(),
                using: { _ in
                    calls += 1
                    await gate.wait()
                    return .created(PreviewData.session())
                },
                isCurrent: { true })
        }
        #expect(await settle(until: { gate.isWaiting }))

        let ignored = await submission.submit(
            request(),
            using: { _ in
                calls += 1
                return .created(PreviewData.session())
            },
            isCurrent: { true })
        #expect(ignored == .dropped)
        #expect(calls == 1)

        gate.open()
        _ = await first.value
        #expect(calls == 1)
    }

    @Test func aCreatedSessionComesBackForTheCallerToSelect() async {
        let submission = NewSessionSubmission()
        let session = PreviewData.session(id: "s-42", desig: "TASK-42")

        let outcome = await submission.submit(
            request(), using: { _ in .created(session) }, isCurrent: { true })

        #expect(outcome == .created(session))
        #expect(submission.message == nil)
        #expect(!submission.busy)
    }

    @Test func aHeldTaskKeepsTheSheetOpenAndSaysWhy() async {
        let submission = NewSessionSubmission()

        let outcome = await submission.submit(
            request(), using: { _ in held() }, isCurrent: { true })

        #expect(outcome == .held)
        #expect(submission.message == L.t("native_newsession_held"))
    }

    @Test func failureMapsToShepherdErrorCopyWhenCurrent() async {
        let submission = NewSessionSubmission()
        let error = ShepherdError.conflict(code: "dirty", message: "worktree is dirty")

        let outcome = await submission.submit(
            request(), using: { _ in throw error }, isCurrent: { true })

        #expect(outcome == .failed)
        #expect(submission.message == L.t("newtask_create_failed", ShepherdErrorCopy.message(error)))
    }

    /// The operator switched profiles (or closed the sheet) while the create
    /// was in flight: selecting the new session would put a row from the old
    /// server into the new server's window.
    @Test func aStaleSuccessIsDroppedWithoutSelectingAnything() async {
        let submission = NewSessionSubmission()

        let outcome = await submission.submit(
            request(),
            using: { _ in .created(PreviewData.session()) },
            isCurrent: { false })

        #expect(outcome == .dropped)
        #expect(submission.message == nil)
        #expect(!submission.busy)
    }

    @Test func aStaleFailureIsDroppedSilently() async {
        let submission = NewSessionSubmission()

        let outcome = await submission.submit(
            request(), using: { _ in throw StubError() }, isCurrent: { false })

        #expect(outcome == .dropped)
        #expect(submission.message == nil)
    }

    @Test func aStaleHeldTaskIsDroppedSilently() async {
        let submission = NewSessionSubmission()

        let outcome = await submission.submit(
            request(), using: { _ in held() }, isCurrent: { false })

        #expect(outcome == .dropped)
        #expect(submission.message == nil)
    }
}
