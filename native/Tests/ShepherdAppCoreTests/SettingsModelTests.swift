import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore
actor SettingsReadLatch {
    var waiting = false
    var continuation: CheckedContinuation<SettingsSnapshot, any Error>?
    func read() async throws -> SettingsSnapshot {
        try await withCheckedThrowingContinuation { continuation = $0; waiting = true }
    }
    func fail() { continuation?.resume(throwing:ShepherdError.notFound); continuation = nil }
    func succeed(_ value: SettingsSnapshot) { continuation?.resume(returning: value); continuation = nil }
}
private actor SettingsReadSequence {
    private(set) var count = 0
    private var pending: [Int: CheckedContinuation<SettingsSnapshot, any Error>] = [:]
    func read() async throws -> SettingsSnapshot {
        count += 1
        let id = count
        return try await withCheckedThrowingContinuation { pending[id] = $0 }
    }
    func succeed(_ id: Int, _ value: SettingsSnapshot) {
        pending.removeValue(forKey: id)?.resume(returning: value)
    }
}
extension CoreSeamTests {
@Suite(.serialized) @MainActor struct SettingsModelTests {
    private func fixture(_ stamp: Int = 1) throws -> SettingsSnapshot {
        let data = Data(#"{"repoRoot":"/repo","repoRootDisplay":"repo","firstRunPending":false,"defaultModel":"opus","defaultEffort":"default","defaultAgentProvider":"claude","authMode":"subscription","operatorLanguage":"en"}"#.utf8)
        return .init(settings: try JSONDecoder().decode(Components.Schemas.Settings.self, from: data),
                     diagnostics: .init(checks: [], generatedAt: stamp, overall: .init(known: .ok)),
                     usage: nil, repos: [])
    }
    @Test func independentDiagnosticsFailureIsVisibleAndCanRecover() async throws {
        let snapshot = try fixture()
        let recovery = BackendRecoveryModel(reads: .init(health: { true },
            diagnostics: { throw ShepherdError.notFound }))
        let model = SettingsModel(reads: .init(snapshot: { snapshot }), recovery: recovery)
        defer { model.teardown(); recovery.teardown() }
        await model.load()
        for _ in 0..<2 {
            await recovery.refresh()
            #expect(model.snapshot != nil)
            #expect(model.error == nil)
            #expect(recovery.serverReachable == true)
            #expect(recovery.diagnosticsError != nil)
            #expect(!recovery.diagnosticsLoading)
        }
        recovery.replaceDiagnostics(snapshot.diagnostics!)
        #expect(recovery.diagnosticsError == nil)
        #expect(recovery.diagnostics != nil)
    }

    @Test func failureAfterTeardownCannotReopenErrorState() async {
        let latch = SettingsReadLatch()
        let model = SettingsModel(reads:.init(snapshot:{try await latch.read()}))
        let load = Task {await model.load()}
        while !(await latch.waiting) {await Task.yield()}
        model.teardown(); await latch.fail(); await load.value
        #expect(model.error == nil); #expect(model.snapshot == nil); #expect(!model.busy)
    }
    @Test func failedReadIsVisibleBeforeTeardown() async {
        let model = SettingsModel(reads:.init(snapshot:{throw ShepherdError.notFound}))
        await model.load()
        #expect(model.error != nil)
        model.teardown()
    }
    @Test func successfulWriteReconcilesSharedStoreBeforePublishing() async {
        var reconciled = false
        var committed = false
        let model = SettingsModel(reads: .init(snapshot: { throw ShepherdError.notFound },
            reconcile: { reconciled = true }))
        defer { model.teardown() }
        model.run({ true }, commit: { value in
            #expect(reconciled)
            committed = value
        })
        while model.busy { await Task.yield() }
        #expect(reconciled); #expect(committed)
    }
    @Test func registrationUsesIsolatedPersistence() {
        let suite = "SettingsModel-" + UUID().uuidString
        let defaults = UserDefaults(suiteName:suite)!
        defer {defaults.removePersistentDomain(forName:suite)}
        let app = AppModel(defaults:defaults,credentials:InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        app.register(SettingsModel.self); app.register(SettingsModel.self)
        #expect(app.extensionFactories.count == 1)
        #expect(app.extension(SettingsModel.self) == nil)
        app.teardown()
    }
    @Test func teardownClearsAnExistingErrorAndIsIdempotent() async {
        let model = SettingsModel(reads: .init(snapshot: { throw ShepherdError.notFound }))
        await model.load()
        #expect(model.error != nil)
        model.teardown(); model.teardown()
        #expect(model.error == nil)
        #expect(model.tokens.entries.isEmpty)
        #expect(model.tokens.revealed == nil)
        #expect(!model.tokens.authenticated)
    }
    @Test func successAfterTeardownCannotRestoreSnapshot() async throws {
        let latch = SettingsReadLatch()
        let model = SettingsModel(reads: .init(snapshot: { try await latch.read() }))
        let load = Task { await model.load() }
        while !(await latch.waiting) { await Task.yield() }
        model.teardown()
        await latch.succeed(try fixture())
        await load.value
        #expect(model.snapshot == nil)
        #expect(model.error == nil)
    }
    @Test func olderReadCannotReplaceANewerSnapshot() async throws {
        let reads = SettingsReadSequence()
        let model = SettingsModel(reads: .init(snapshot: { try await reads.read() }))
        defer { model.teardown() }
        let first = Task { await model.load() }
        while await reads.count < 1 { await Task.yield() }
        let second = Task { await model.load() }
        while await reads.count < 2 { await Task.yield() }
        await reads.succeed(2, try fixture(2))
        await second.value
        await reads.succeed(1, try fixture(1))
        await first.value
        #expect(model.diagnostics?.generatedAt == 2)
    }
    @Test func snapshotPrunesMissingRepositoryAndItsMetadata() async throws {
        let value = try fixture()
        let model = SettingsModel(reads: .init(snapshot: { value }))
        defer { model.teardown() }
        model.repo = "/removed"
        model.roles = .init(roles: .init(reviewer: "reviewer", merger: nil), me: nil)
        model.collaborators = .init(logins: ["reviewer"], me: nil,
                                   collaboratorsUnavailable: false, repoSlug: nil, isFork: false)
        await model.load()
        #expect(model.snapshot != nil)
        #expect(model.repo.isEmpty)
        #expect(model.repoConfig == nil)
        #expect(model.roles == nil)
        #expect(model.collaborators == nil)
    }
    @Test func failedReconciliationDoesNotCommitAndReleasesBusy() async {
        var committed = false
        let model = SettingsModel(reads: .init(snapshot: { throw ShepherdError.notFound },
            reconcile: { throw ShepherdError.notFound }))
        defer { model.teardown() }
        model.run({ true }, commit: { committed = $0 })
        while model.busy { await Task.yield() }
        #expect(!committed)
        #expect(model.error == L.t("native_settings_action_failed"))
    }
    @Test func reloadDuringWriteDoesNotStrandBusyOrSkipReconciliation() async throws {
        let latch = SettingsReadLatch()
        let value = try fixture()
        var reconciled = false
        var committed = false
        let model = SettingsModel(reads: .init(snapshot: { value }, reconcile: { reconciled = true }))
        defer { model.teardown() }
        model.run({ try await latch.read() }, commit: { _ in committed = true })
        while !(await latch.waiting) { await Task.yield() }
        model.reload()
        while model.snapshot == nil { await Task.yield() }
        #expect(model.busy)
        await latch.succeed(value)
        while model.busy { await Task.yield() }
        #expect(reconciled)
        #expect(committed)
    }
    @Test func stoppedModelCannotSelectARepository() throws {
        let model = SettingsModel(reads: .init(snapshot: { throw ShepherdError.notFound }))
        let client = try ShepherdClient(
            profile: .init(name: "fixture", baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local),
            credentials: InMemoryCredentialStore())
        model.teardown()
        model.selectRepo("/retired", client: client)
        #expect(model.repo.isEmpty)
        #expect(!model.busy)
    }
    @Test func teardownDuringReconciliationRejectsCommitAndReleasesOwner() async throws {
        let latch = SettingsReadLatch()
        let value = try fixture()
        var committed = false
        var model: SettingsModel? = SettingsModel(reads: .init(snapshot: { value },
            reconcile: { _ = try await latch.read() }))
        weak var retired = model
        model?.run({ true }, commit: { committed = $0 })
        while !(await latch.waiting) { await Task.yield() }
        model?.teardown()
        model = nil
        await latch.succeed(value)
        while retired != nil { await Task.yield() }
        #expect(!committed)
    }
}
}
