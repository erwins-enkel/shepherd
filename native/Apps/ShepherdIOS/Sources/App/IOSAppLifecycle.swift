import Foundation
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
    private var pending: Task<Void, Never>?
    private var generation = 0
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
        self.store = store
        connection = nil
        if let phase { enqueuePresence(phase == .active, recover: phase == .active) }
    }

    func update(_ phase: IOSScenePhase) async {
        let wasActive = self.phase == .active
        let hadPhase = self.phase != nil
        self.phase = phase
        let active = phase == .active
        guard !hadPhase || active != wasActive else { return }
        enqueuePresence(active, recover: active)
        await pending?.value
    }

    func connectionDidChange(_ state: ConnectionState?) async {
        guard state != connection else { return }
        connection = state
        guard phase == .active, state == .live else { return }
        enqueuePresence(true, recover: true)
        await pending?.value
    }

    private func enqueuePresence(_ active: Bool, recover: Bool) {
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
                self.app?.retry()
                await self.onForegroundRecovery()
            }
        }
    }
}
