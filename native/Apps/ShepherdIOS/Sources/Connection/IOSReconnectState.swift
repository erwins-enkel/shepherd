import Foundation
import Observation

/// A visible foreground outage owns one countdown and at most one reconnect.
/// Time and suspension are injected so tests advance time without wall-clock waits.
@MainActor
@Observable
final class IOSReconnectState {
    enum Phase: Equatable { case connected, offline, checking, failed }
    private(set) var phase: Phase = .connected
    private(set) var secondsRemaining = 30
    private(set) var showsReconnected = false
    private(set) var lastContact: Date?
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let sleep: (Duration) async throws -> Void
    @ObservationIgnored private let reconnect: () async -> Bool
    @ObservationIgnored private var task: Task<Void, Never>?
    private var deadline: Date?
    private var running = false
    private var generation = 0

    init(now: @escaping () -> Date = Date.init,
         sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
         reconnect: @escaping () async -> Bool) {
        self.now = now
        self.sleep = sleep
        self.reconnect = reconnect
    }

    func update(unreachable: Bool, lastContact: Date? = nil) {
        if let lastContact { self.lastContact = lastContact }
        if unreachable {
            guard phase == .connected else { return }
            cancel()
            phase = .offline
            showsReconnected = false
            resetCountdown()
            schedule()
        } else if phase != .checking, phase != .connected {
            connected()
        }
    }

    /// First appearance counts down; returning from suspension checks immediately.
    func setRunning(_ value: Bool) {
        guard running != value else { return }
        running = value
        if !value {
            cancel()
            if phase == .checking { phase = .offline }
            showsReconnected = false
        } else if phase != .connected {
            retry()
        }
    }

    /// Mounting must not immediately replace the initial Offline state with Checking.
    func appear(active: Bool) {
        running = active
        schedule()
    }

    func retry() {
        guard running, phase != .connected, phase != .checking else { return }
        cancel()
        phase = .checking
        secondsRemaining = 30
        let mine = generation
        task = Task { [weak self, reconnect] in
            let success = await reconnect()
            guard let self, !Task.isCancelled, mine == generation, running else { return }
            if success { connected() }
            else {
                phase = .failed
                resetCountdown()
                schedule()
            }
        }
    }

    private func connected() {
        cancel()
        phase = .connected
        showsReconnected = running
        guard running else { return }
        let mine = generation
        task = Task { [weak self, sleep] in
            do { try await sleep(.seconds(3)) } catch { return }
            guard let self, !Task.isCancelled, mine == generation else { return }
            showsReconnected = false
        }
    }

    private func resetCountdown() {
        secondsRemaining = 30
        deadline = now().addingTimeInterval(30)
    }

    private func schedule() {
        guard running, phase == .offline || phase == .failed else { return }
        let mine = generation
        task = Task { [weak self, sleep] in
            while !Task.isCancelled {
                do { try await sleep(.seconds(1)) } catch { return }
                guard let self, !Task.isCancelled, mine == generation, running else { return }
                secondsRemaining = max(0, Int(ceil((deadline ?? now()).timeIntervalSince(now()))))
                if secondsRemaining == 0 { retry(); return }
            }
        }
    }

    private func cancel() {
        generation += 1
        task?.cancel()
        task = nil
    }

    deinit { task?.cancel() }
}
