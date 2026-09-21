import Foundation
import Observation
import ShepherdKit
import SwiftUI
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

private actor QueueReadGate {
    private(set) var calls = 0
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func enter() async {
        calls += 1
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        opened = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }
}

@MainActor @Observable
private final class QueueConnectionBox {
    var state: ConnectionState = .idle
}

@MainActor
private func queueSettle(_ condition: () async -> Bool) async -> Bool {
    for _ in 0..<1_000 {
        if await condition() { return true }
        await Task.yield()
    }
    return await condition()
}

@MainActor
private final class QueueFixture {
    let suite = "QueuesModelTests.\(UUID().uuidString)"
    let defaults: UserDefaults
    let app: AppModel
    let store: SessionStore
    let model: QueuesModel

    init(_ reads: QueuesReads) throws {
        defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        store = try SessionStore(
            profile: ServerProfile(name: "queues", baseURL: URL(string: "https://queues.invalid")!,
                                   mode: .remote),
            credentials: InMemoryCredentialStore())
        model = QueuesModel(store: store, app: app)
        // No suspension before replacing the live closures; no test starts the store/socket.
        model.reads = reads
    }

    func close() {
        model.teardown()
        store.stop()
        app.teardown()
        defaults.removePersistentDomain(forName: suite)
    }
}

@MainActor
struct QueuesModelTests {
    private var empty: QueuesReads {
        QueuesReads(held: { [] }, done: { [] }, recaps: { [:] }, stranded: { [] },
                    refreshUpNext: {})
    }

    private func held(_ id: String) throws -> HeldQueueEntry {
        try JSONDecoder().decode(HeldQueueEntry.self, from: Data("""
            {"id":"\(id)","repoPath":"/repo",
             "input":{"repoPath":"/repo","baseBranch":"main","prompt":"task"},
             "createdAt":1,"reason":"capacity"}
            """.utf8))
    }

    private func frame(_ name: String, _ json: String) throws -> ServerEvent {
        try JSONDecoder().decode(ServerEvent.self,
            from: Data("{\"event\":\"\(name)\",\"data\":\(json)}".utf8))
    }

    private func snapshot(_ time: Int, populated: Bool = false) throws -> ServerEvent {
        let sections = populated ? """
            [{"kind":"repo","repoPath":"/repo","repoSlug":null,"repoLabel":"Old",
              "items":[],"totalCount":0}]
            """ : "[]"
        return try frame("upnext:snapshot", """
            {"snapshot":{"generatedAt":\(time),"sections":\(sections),"repoCount":\(time),
             "fallback":null,"failedRepoCount":0}}
            """)
    }

}

extension MacSeamTests {
@MainActor
@Suite(.serialized)
struct QueuesStreamTests {
    @Test func scenePassRegistersPanelsBeforeAnyModelExists() {
        QueuesPanels.reset()
        defer { QueuesPanels.reset() }
        QueuesStream.installScene()
        QueuesStream.installScene()
        for lens in HerdLens.allCases {
            #expect((QueuesPanels.panel(for: lens) != nil) == [.next, .done, .owed].contains(lens))
        }
    }

    @Test func installRegistersThreePanelsAndOneLifecycleManagedModel() async throws {
        QueuesPanels.reset()
        let suite = "QueuesStreamTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        let store = try SessionStore(profile: ServerProfile(name: "queues",
            baseURL: URL(string: "https://queues.invalid")!, mode: .remote),
            credentials: InMemoryCredentialStore())
        defer {
            app.teardown()
            store.stop()
            defaults.removePersistentDomain(forName: suite)
            QueuesPanels.reset()
        }
        QueuesStream.install(app)
        QueuesStream.install(app)
        for lens in HerdLens.allCases {
            #expect((QueuesPanels.panel(for: lens) != nil) == [.next, .done, .owed].contains(lens))
        }
        #expect(app.extensionFactories.filter { $0.key == ObjectIdentifier(QueuesModel.self) }.count == 1)
        #expect(app.extension(QueuesModel.self) == nil)
        // Exercise the registered factory without starting a store or making network requests.
        app.makeExtensions(store: store)
        let model = try #require(app.extension(QueuesModel.self))
        model.reads = QueuesReads(held: { [] }, done: { [] }, recaps: { [:] }, stranded: { [] },
                                 refreshUpNext: {})
        #expect(await queueSettle { !model.isRefreshing })
        #expect(model.isSubscribed && model.isWatchingConnection)
        QueuesStream.install(app)
        #expect(app.extension(QueuesModel.self) === model)
        app.teardown()
        #expect(app.extension(QueuesModel.self) == nil)
        #expect(!model.isSubscribed)
        #expect(await queueSettle { !model.isWatchingConnection })
    }
}
}

@MainActor
struct QueueActionsTests {
    private var commands: QueueActionCommands {
        .init(halt: { .init(halted: 2) }, retry: { _, _ in .init(resumed: 1, steered: 2, total: 3) },
              revive: { .init(revived: 2, failed: 1) }, restore: { PreviewData.session(id: $0) },
              broadcast: { _, _ in .init(delivered: 1, queued: 2, offline: 3, skipped: 4, total: 10) },
              reloadStranded: {})
    }

}

@MainActor
struct QueueActionsReconciliationTests {
    private func model() -> QueuesModel {
        QueuesModel(reads: .init(held: { [] }, done: { [] }, recaps: { [:] },
            stranded: { [] }, refreshUpNext: {}))
    }

}
