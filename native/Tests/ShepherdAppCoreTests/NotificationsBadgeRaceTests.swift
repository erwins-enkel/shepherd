import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
/// The badge is global to the Dock. Hold an older reply until a newer write has landed so the
/// cache must describe the newest intent, independently of the task scheduler's ordering.
@MainActor
struct NotificationsBadgeRaceTests {
    @Test func anOlderCountNeverCommitsOverANewerOne() async {
        let centre = ReorderingCenter()
        let model = NotificationsModel.forTesting(center: centre)
        centre.delayNext = true
        async let slow: Void = model.setBadgeForTesting(1)
        await centre.waitUntilDelayed()
        await model.setBadgeForTesting(7)
        #expect(model.lastBadgeForTesting == 7)
        centre.resumeDelayed()
        await slow
        #expect(centre.written.last == 7)
        #expect(model.lastBadgeForTesting == 7)
    }

    /// Reverting to a cached count is still a newer intent than the in-flight write.
    @Test func aRevertToTheCachedCountStillSupersedesAnInFlightWrite() async {
        let centre = ReorderingCenter()
        let model = NotificationsModel.forTesting(center: centre)
        await model.setBadgeForTesting(0)
        centre.delayNext = true
        async let slow: Void = model.setBadgeForTesting(7)
        await centre.waitUntilDelayed()
        await model.setBadgeForTesting(0)
        centre.resumeDelayed()
        await slow
        #expect(centre.written == [0, 7, 0])
        #expect(model.lastBadgeForTesting == 0)
    }

    /// The stale round trip was already sent; its reply must neither commit nor invalidate the
    /// winner's cache, which would send the same count again on the next refresh.
    @Test func aSupersededCompletionDoesNotInvalidateTheWinner() async {
        let centre = ReorderingCenter()
        let model = NotificationsModel.forTesting(center: centre)
        centre.delayNext = true
        async let slow: Void = model.setBadgeForTesting(1)
        await centre.waitUntilDelayed()
        await model.setBadgeForTesting(7)
        centre.resumeDelayed()
        await slow
        #expect(model.lastBadgeForTesting == 7)
        await model.setBadgeForTesting(7)
        #expect(centre.written == [1, 7])
    }

    @Test func repeatingAnInFlightIntentDoesNotSendAnotherWrite() async {
        let centre = ReorderingCenter()
        let model = NotificationsModel.forTesting(center: centre)
        centre.delayNext = true
        async let slow: Void = model.setBadgeForTesting(7)
        await centre.waitUntilDelayed()
        await model.setBadgeForTesting(7)
        centre.resumeDelayed()
        await slow
        #expect(centre.written == [7])
        #expect(model.lastBadgeForTesting == 7)
    }
}
}

/// Records the write before delaying its reply, matching an already-issued XPC round trip.
/// Continuations establish overlap; yields alone cannot promise which async-let starts first.
@MainActor
private final class ReorderingCenter: NotificationCenterClient {
    var onSelectSession: ((String) -> Void)?
    var delayNext = false
    private(set) var written: [Int] = []
    private var delayed: CheckedContinuation<Void, Never>?
    private var waitingForDelay: CheckedContinuation<Void, Never>?

    func start() {}
    func authorization() async -> NotificationAuthorization { .granted }
    func requestAuthorization() async -> NotificationAuthorization { .granted }
    func post(_ request: NotificationRequest) async -> Bool { true }
    func clearBadgeNow() { written.append(0) }

    func setBadgeCount(_ count: Int) async -> Bool {
        written.append(count)
        if delayNext {
            delayNext = false
            await withCheckedContinuation { continuation in
                delayed = continuation
                waitingForDelay?.resume()
                waitingForDelay = nil
            }
            for _ in 0..<3 { await Task.yield() }
        }
        return true
    }

    func waitUntilDelayed() async {
        if delayed != nil { return }
        await withCheckedContinuation { waitingForDelay = $0 }
    }

    func resumeDelayed() {
        let continuation = delayed
        delayed = nil
        continuation?.resume()
    }
}
