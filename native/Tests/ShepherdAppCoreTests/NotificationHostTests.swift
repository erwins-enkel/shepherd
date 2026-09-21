import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
struct NotificationHostTests {
    @Test func focusTransitionsDuringAuthorizationAndTeardown() async throws {
        let trace = FocusTrace()
        let focus = RecordingFocus(trace: trace)
        let center = RecordingCenter(trace: trace)
        let name = "run.shepherd.core.focus." + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(),
            notifications: NotificationEnvironment(makeCenter: { center }, makeDefaults: { defaults }, focus: focus))
        defer { app.teardown() }
        let profile = try app.addRemoteProfile(name: "fixture", address: "https://fixture.invalid")
        await app.activate(profile)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        focus.value = true
        let model = NotificationsModel(store: store, app: app)
        #expect(model.windowFocused)
        #expect(Array(trace.events.prefix(3)) == ["start", "observe", "sample"])
        await center.waitUntilAuthorizationRequested()
        focus.send(false)
        focus.send(true)
        await model.waitForFocusTaskForTesting()
        #expect(model.windowFocused)
        focus.send(false)
        await model.waitForFocusTaskForTesting()
        center.resumeAuthorization(.granted)
        await model.waitForLaunchTaskForTesting()
        #expect(!model.windowFocused)
        #expect(focus.delivered == [false, true, false])
        model.teardown()
        #expect(focus.observerCount == 0)
        #expect(center.onSelectSession == nil)
        #expect(Array(trace.events.suffix(2)) == ["cancel-observation", "clear-now"])
    }
}
}
@MainActor private final class FocusTrace { var events: [String] = [] }
@MainActor private final class RecordingFocus: NotificationFocusSource {
    let trace: FocusTrace
    var value = false
    var delivered: [Bool] = []
    var receiver: (@MainActor (Bool) -> Void)?
    var observerCount: Int { receiver == nil ? 0 : 1 }
    init(trace: FocusTrace) { self.trace = trace }
    func sample() -> Bool { trace.events.append("sample"); return value }
    func observe(_ receive: @escaping @MainActor (Bool) -> Void) -> @MainActor () -> Void {
        trace.events.append("observe")
        receiver = receive
        return { [weak self] in
            guard let self, self.receiver != nil else { return }
            self.trace.events.append("cancel-observation")
            self.receiver = nil
        }
    }
    func send(_ value: Bool) {
        self.value = value
        guard let receiver else { return }
        delivered.append(value)
        receiver(value)
    }
}
@MainActor private final class RecordingCenter: NotificationCenterClient {
    let trace: FocusTrace
    var onSelectSession: ((String) -> Void)?
    var requested = false
    var continuation: CheckedContinuation<NotificationAuthorization, Never>?
    var waiter: CheckedContinuation<Void, Never>?
    init(trace: FocusTrace) { self.trace = trace }
    func start() { trace.events.append("start") }
    func authorization() async -> NotificationAuthorization {
        guard !requested else { return .granted }
        requested = true
        return await withCheckedContinuation {
            continuation = $0
            waiter?.resume(); waiter = nil
        }
    }
    func waitUntilAuthorizationRequested() async {
        if requested { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func resumeAuthorization(_ value: NotificationAuthorization) {
        continuation?.resume(returning: value); continuation = nil
    }
    func requestAuthorization() async -> NotificationAuthorization { .granted }
    func post(_ request: NotificationRequest) async -> Bool { true }
    func setBadgeCount(_ count: Int) async -> Bool { true }
    func clearBadgeNow() { trace.events.append("clear-now") }
}
