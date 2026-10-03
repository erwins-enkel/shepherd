import Foundation
import Testing
import ShepherdKit

@testable import ShepherdAppCore

/// Yields until `condition` holds, bounded by a 10 s deadline.
@MainActor
private func settle(until condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + .seconds(10)
    while ContinuousClock.now < deadline {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
}

/// A stand-in that only models attach attempts.
@MainActor
private final class AttemptingAttachment: PTYAttaching {
    let output: AsyncStream<Data>
    let lifecycle: AsyncStream<PTYConnection.LifecycleEvent>
    let attempts: AsyncStream<PTYConnection.Attempt>
    private let sink: AsyncStream<PTYConnection.Attempt>.Continuation

    init() {
        output = AsyncStream<Data>.makeStream().stream
        lifecycle = AsyncStream<PTYConnection.LifecycleEvent>.makeStream().stream
        (attempts, sink) = AsyncStream<PTYConnection.Attempt>.makeStream()
    }

    func start() {}
    func stop() {}
    func takeOver() {}
    func send(_ bytes: Data) {}
    func resize(cols: Int, rows: Int) {}
    func emit(_ attempt: PTYConnection.Attempt) { sink.yield(attempt) }
}

/// One fresh attachment per attach, so no stream is iterated twice.
@MainActor
private final class AttemptingFactory {
    private(set) var made: [AttemptingAttachment] = []

    func make() -> AttemptingAttachment {
        let attachment = AttemptingAttachment()
        made.append(attachment)
        return attachment
    }
}

extension CoreSeamTests {
/// A connect that takes longer than a moment explains itself: which socket,
/// which try, why the last one died, and what a create is waiting on.
@MainActor
struct ConnectingDetailTests {
    private let attempt = PTYConnection.Attempt(
        endpoint: "wss://host.example.ts.net:7330/pty/s1", number: 3, stage: .handshake, fastFails: 2,
        lastDrop: PTYConnection.Drop(
            closeCode: 0, httpStatus: 502, error: "NSURLErrorDomain -1011: bad response",
            lived: .milliseconds(120)))

    @Test func terminalModelReportsTheLatestAttemptAndAttachClearsIt() async {
        let factory = AttemptingFactory()
        let model = TerminalSessionModel(sessionID: "s1", reply: { _ in },
            makeAttachment: { _, _ in factory.make() })
        model.attach(cols: 80, rows: 24)
        factory.made[0].emit(attempt)
        #expect(await settle(until: { model.connectAttempt == attempt }))

        model.detach()
        model.attach(cols: 80, rows: 24)

        #expect(model.connectAttempt == nil)
        model.detach()
    }

    @Test func terminalRowsNameTheSocketTheTryAndWhyTheLastOneDied() {
        let rows = ConnectingDetailCopy.terminalRows(attempt, elapsed: 4.6)

        #expect(rows.map(\.label) == [
            L.t("native_connect_detail_endpoint"), L.t("native_connect_detail_step"),
            L.t("native_connect_detail_elapsed"), L.t("native_connect_detail_last_failure"),
            L.t("native_connect_detail_fast_fails"),
        ])
        let failure: [String] = [
            "HTTP 502", L.t("native_connect_drop_no_close"), "NSURLErrorDomain -1011: bad response",
            L.t("native_connect_drop_lived", "120 ms"),
        ]
        let expected: [String] = [
            "wss://host.example.ts.net:7330/pty/s1",
            L.t("native_connect_step_handshake", "3"),
            L.t("newtask_spawn_seconds", "4"),
            failure.joined(separator: " · "),
            L.t("native_connect_fast_fails_value", "2", String(PTYConnection.maxFastFails)),
        ]
        #expect(rows.map(\.value) == expected)
    }

    @Test func aCloseCodeStandsInForTheTransportErrorAndWaitingNamesThePause() {
        let closed = PTYConnection.Attempt(
            endpoint: "ws://h/pty/s1", number: 1, stage: .waiting(.seconds(1)), fastFails: 0,
            lastDrop: PTYConnection.Drop(
                closeCode: 1011, httpStatus: nil, error: "NSPOSIXErrorDomain 57: Socket is not connected",
                lived: .seconds(12)))

        let rows = ConnectingDetailCopy.terminalRows(closed, elapsed: 0)

        #expect(!rows.map(\.label).contains(L.t("native_connect_detail_fast_fails")))
        #expect(rows[1].value == L.t("native_connect_step_retry", ConnectingDetailCopy.duration(1)))
        let failure: [String] = [
            L.t("native_connect_drop_close", "1011"),
            L.t("native_connect_drop_lived", ConnectingDetailCopy.duration(12)),
        ]
        #expect(rows[3].value == failure.joined(separator: " · "))
    }

    @Test func withoutAnAttemptOnlyTheWaitIsShown() {
        #expect(ConnectingDetailCopy.terminalRows(nil, elapsed: 2).map(\.label)
            == [L.t("native_connect_detail_elapsed")])
    }

    @Test func serverRowsSayWhatTheStoreWaitsOnAndCountDownTheBackoff() {
        let now = Date()

        let snapshot = ConnectingDetailCopy.serverRows(
            server: "https://h.example.ts.net:7330",
            detail: ConnectingDetail(step: .snapshot, attempt: 2, lastFailure: "offline"), elapsed: 3, now: now)
        #expect(snapshot.map(\.value) == [
            "https://h.example.ts.net:7330", L.t("native_connect_step_snapshot", "2"),
            L.t("newtask_spawn_seconds", "3"), "offline",
        ])

        let waiting = ConnectingDetailCopy.serverRows(
            server: nil, detail: ConnectingDetail(step: .events, attempt: 1, retryAt: now.addingTimeInterval(7.2)),
            elapsed: 1, now: now)
        #expect(waiting.first?.value
            == L.t("native_connect_step_events_retry", "1", L.t("newtask_spawn_seconds", "8")))

        let opening = ConnectingDetailCopy.serverRows(
            server: nil, detail: ConnectingDetail(step: .events, attempt: 2), elapsed: 1, now: now)
        #expect(opening.first?.value == L.t("native_connect_step_events", "2"))
    }

    @Test func durationsReadAsMillisecondsBelowASecond() {
        #expect(ConnectingDetailCopy.duration(0.12) == "120 ms")
        #expect(ConnectingDetailCopy.duration(12) == L.t("newtask_spawn_seconds", "12"))
    }

    @Test func spawnPhasesExplainWhyTheyCanTakeAWhile() {
        #expect(ComposeSubmission.phaseWhy(.init(known: .worktree)) == L.t("newtask_spawn_why_worktree"))
        #expect(ComposeSubmission.phaseWhy(.init(unknown: "future-phase")) == nil)
    }

    @Test func debouncerRemembersWhenConnectingBegan() {
        let debouncer = ConnectingOverlayDebouncer(delay: .seconds(60))
        #expect(debouncer.since == nil)

        debouncer.phaseChanged(toConnecting: true)
        let since = debouncer.since
        #expect(since != nil)
        // A repeated report of the same stretch keeps its start.
        debouncer.phaseChanged(toConnecting: true)
        #expect(debouncer.since == since)

        debouncer.phaseChanged(toConnecting: false)
        #expect(debouncer.since == nil)
    }
}
}
