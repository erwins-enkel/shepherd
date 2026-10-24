import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

enum IOSScenePhase { case active, inactive, background }

/// Serializes presence sends. The store is never stopped for scene suspension.
@MainActor
final class IOSAppLifecycle {
    private weak var app: AppModel?
    private weak var store: SessionStore?
    private var phase: IOSScenePhase?
    private var connection: ConnectionState?
    private var hasBeenLive = false
    private var pending: Task<Void, Never>?
    private var generation = 0
    private var watcher: Task<Void, Never>?
    private var connectionSignal: AsyncStream<Void>.Continuation?
    private let setPresence: (@MainActor (Bool) async -> Void)?
    private let onForegroundRecovery: @MainActor () async -> Void

    init(app: AppModel, onForegroundRecovery: @escaping @MainActor () async -> Void) {
        self.app = app
        self.onForegroundRecovery = onForegroundRecovery
        setPresence = nil
    }

    init(setActive: @escaping @MainActor (Bool) async -> Void,
         onForegroundRecovery: @escaping @MainActor () async -> Void) {
        setPresence = setActive
        self.onForegroundRecovery = onForegroundRecovery
    }

    func storeDidChange(_ store: SessionStore?) {
        guard self.store !== store else { return }
        generation &+= 1
        watcher?.cancel()
        connectionSignal?.finish()
        self.store = store
        connection = nil
        hasBeenLive = false
        if let store {
            let (changes, signal) = AsyncStream<Void>.makeStream()
            connectionSignal = signal
            let generation = generation
            watcher = Task { [weak self, weak store] in
                var iterator = changes.makeAsyncIterator()
                while !Task.isCancelled {
                    guard let state = store?.connection, self?.generation == generation else { return }
                    Task { [weak self] in
                        guard self?.generation == generation else { return }
                        await self?.connectionDidChange(state)
                    }
                    withObservationTracking { _ = store?.connection } onChange: { signal.yield() }
                    guard await iterator.next() != nil else { return }
                    await Task.yield()
                }
            }
        }
        if let phase { enqueuePresence(phase == .active, recover: false) }
    }

    func update(_ phase: IOSScenePhase) async {
        let wasActive = self.phase == .active
        let hadPhase = self.phase != nil
        self.phase = phase
        let active = phase == .active
        guard !hadPhase || active != wasActive else { return }
        enqueuePresence(active, recover: active && hadPhase)
        await pending?.value
    }

    func connectionDidChange(_ state: ConnectionState?) async {
        guard state != connection else { return }
        let wasLiveBefore = hasBeenLive
        connection = state
        if state == .live { hasBeenLive = true }
        guard phase == .active, state == .live else { return }
        enqueuePresence(true, recover: wasLiveBefore, reloadStore: false)
        await pending?.value
    }

    private func enqueuePresence(_ active: Bool, recover: Bool, reloadStore: Bool = true) {
        let previous = pending
        let generation = generation
        let target = store
        pending = Task { [weak self] in
            await previous?.value
            guard let self, generation == self.generation else { return }
            if let setPresence = self.setPresence { await setPresence(active) }
            else {
                guard let target, self.app?.store === target else { return }
                await target.setActive(active)
            }
            guard generation == self.generation else { return }
            if recover, self.phase == .active {
                if let target, !target.hasLoadedSessions,
                   target.connection == .idle || target.connection == .connecting { return }
                if reloadStore { self.app?.retry() }
                await self.onForegroundRecovery()
            }
        }
    }
}
