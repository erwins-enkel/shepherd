import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
actor MergeLatch {
    private var continuation: CheckedContinuation<MergeSnapshot, Never>?
    private(set) var waiting = false
    private(set) var calls = 0
    func read() async -> MergeSnapshot {
        await withCheckedContinuation { continuation = $0; waiting = true; calls += 1 }
    }
    func release(_ value: MergeSnapshot) { continuation?.resume(returning: value); continuation = nil; waiting = false }
}
@Suite(.serialized) @MainActor struct MergeModelTests {
    private func eventually(_ condition: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(2)
        while !(await condition()), ContinuousClock.now < deadline { await Task.yield() }
        return await condition()
    }

    @Test func mergeRefusalSurvivesConfirmationRefresh() async throws {
        let latch = MergeLatch()
        let model = MergeModel(reads: .init(snapshot: { await latch.read() }))
        defer { model.teardown() }
        var confirmationOpen = false
        // Opening the confirmation through perform starts the background snapshot read.
        model.perform(commit: { _ in confirmationOpen = true }) {}
        let waiting = await eventually { await latch.waiting }
        guard waiting else { Issue.record("confirmation refresh never started"); return }
        #expect(confirmationOpen)
        #expect(!model.busy)

        let refusal = "The PR changed; review its current revision before merging."
        model.perform(failure: { confirmationOpen = false }) {
            throw ShepherdError.conflict(code: "merge_confirm_stale", message: refusal)
        }
        #expect(await eventually { !model.busy })
        #expect(!confirmationOpen)
        #expect(model.error == refusal)
        #expect(!model.settled)

        // The older read succeeds only after the 409 closed the confirmation.
        await latch.release(.init())
        #expect(await eventually { model.settled })
        #expect(model.actionError == refusal)
        #expect(model.error == refusal)

        // A deliberate new action, unlike a refresh, clears the spent refusal.
        model.perform {}
        #expect(model.actionError == nil)
        #expect(model.error == nil)
    }

    @Test func queuedWriteDoesNotStartAfterTeardown() async {
        let model = MergeModel(reads: .init(snapshot: { .init() }))
        var actionCalls = 0
        model.perform { actionCalls += 1 }
        model.teardown()
        // Let the already-scheduled main-actor task run, even though it was cancelled.
        for _ in 0..<20 { await Task.yield() }
        #expect(actionCalls == 0)
        #expect(!model.busy)
    }
    @Test(arguments: ["merge_confirm_required", "merge_confirm_stale"])
    func refusedMergeCanBeExplicitlyRetriedWithAFreshConfirmation(_ code: String) async throws {
        let model = MergeModel(reads: .init(snapshot: { .init() }))
        defer { model.teardown() }
        let first = try JSONDecoder().decode(GitState.self, from: Data(
            #"{"state":"open","checks":"success","number":7,"deployConfigured":false,"headSha":"old","baseRefName":"main"}"#.utf8))
        var current = first
        current.headSha = "new"; current.baseRefName = "release"
        var candidate: GitState? = first
        var confirmationOpen = true
        var attempts: [Components.Schemas.MergeConfirmation] = []
        let refusedPayload = MergeConfirmationRules.payload(first)
        model.perform(failure: { confirmationOpen = false; candidate = nil }) {
            attempts.append(refusedPayload)
            throw ShepherdError.conflict(code: code, message: "Review the changed PR")
        }
        #expect(await eventually { !model.busy })
        #expect(attempts.count == 1) // No automatic retry of a consequential write.
        #expect(!confirmationOpen && candidate == nil)
        await model.refresh()
        #expect(model.error == "Review the changed PR")

        // The next explicit opening reads Git again, exactly as the session button does.
        model.perform(commit: { git in candidate = git; confirmationOpen = true }) { current }
        #expect(await eventually { !model.busy })
        #expect(confirmationOpen && model.error == nil)
        let refreshed = try #require(candidate)
        let retryPayload = MergeConfirmationRules.payload(refreshed)
        model.perform(commit: { _ in confirmationOpen = false; candidate = nil }) {
            attempts.append(retryPayload)
        }
        #expect(await eventually { !model.busy })
        #expect(attempts.map(\.headSha) == ["old", "new"])
        #expect(attempts.map(\.baseRefName) == ["main", "release"])
        #expect(!confirmationOpen && candidate == nil && model.error == nil)
    }
    @Test func lateReadAfterTeardownCannotPublish() async {
        let latch = MergeLatch()
        let model = MergeModel(reads: .init(snapshot: { await latch.read() }))
        let pending = Task { await model.refresh() }
        while !(await latch.waiting) { await Task.yield() }
        model.teardown()
        await latch.release(.init())
        await pending.value
        #expect(!model.settled)
        #expect(!model.busy)
    }
    @Test func eventDuringSnapshotForcesAnotherReadWithoutPublishingOldData() async {
        let latch = MergeLatch()
        let model = MergeModel(reads:.init(snapshot:{await latch.read()}))
        let loading = Task {await model.refresh()}
        while await latch.calls < 1 {await Task.yield()}
        model.invalidate()
        await latch.release(.init())
        while await latch.calls < 2 {await Task.yield()}
        #expect(!model.settled)
        model.teardown(); await latch.release(.init()); await loading.value
        #expect(!model.settled)
    }
    @Test func pruneDropsQueuesButPreservesFrozenOwed() async throws {
        let owed = try JSONDecoder().decode(PostMergeSteps.self, from: Data(#"{"sessionId":"gone","desig":"TASK-1","repoPath":"/a","prNumber":7,"prTitle":"Ship","steps":[{"id":"one","text":"Check","postMerge":true,"doneAt":null}],"trackingIssueUrl":null,"trackingIssueNumber":null,"createdAt":1,"updatedAt":1,"clearedAt":null}"#.utf8))
        let queue = try JSONDecoder().decode(BuildQueue.self, from: Data(#"{"sessionId":"gone","steps":[],"approved":false}"#.utf8))
        let model = MergeModel(reads: .init(snapshot: { .init(queues: ["gone":queue], owed:[owed]) }))
        await model.refresh(); model.prune(liveIDs: [])
        #expect(model.snapshot.queues.isEmpty)
        #expect(model.outstanding == ["gone":1])
        #expect(MergeRules.owed(model.snapshot.owed, repos: ["/b"]).isEmpty)
        model.teardown()
    }
    @Test func externalAutomationFramesRefreshSessionRows() async {
        var rowsRead = 0
        let model = MergeModel(reads: .init(snapshot: { .init() }, sessionRows: { rowsRead += 1 }))
        defer { model.teardown() }
        for name in ["session:autopilot", "session:automerge", "session:manual-steps", "session:merging"] {
            let previous = rowsRead
            model.receive(name: name)
            while rowsRead == previous { await Task.yield() }
            #expect(rowsRead > previous)
        }
        model.teardown()
        let stoppedAt = rowsRead
        model.receive(name: "session:autopilot")
        await model.refresh()
        #expect(rowsRead == stoppedAt)
    }
    @Test func registrationNeverTouchesKeychain() {
        let suite = "MergeModelTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        app.register(MergeModel.self); app.register(MergeModel.self)
        #expect(app.extensionFactories.count == 1)
        #expect(app.extension(MergeModel.self) == nil)
        app.teardown()
    }
    @Test func isolatedProfileSwitchDropsLateReadAndBufferedEventAndFinishesWatcher() async throws {
        let suite = "MergeProfileSwitch-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown(); defaults.removePersistentDomain(forName: suite) }
        let first = try app.addRemoteProfile(name: "first", address: "https://first.example.test")
        let second = try app.addRemoteProfile(name: "second", address: "https://second.example.test")
        app.register(MergeModel.self)
        await app.activate(first)
        app.tearDownExtensions()
        let latch = MergeLatch()
        let outgoing = MergeModel(reads: .init(snapshot: { await latch.read() }))
        app.liveExtensions = [(ObjectIdentifier(MergeModel.self), outgoing)]
        let load = Task { await outgoing.refresh() }
        #expect(await eventually { await latch.waiting })
        // The next activation uses the real extension factory and watcher.
        await app.activate(second)
        let current = try #require(app.extension(MergeModel.self))
        #expect(current !== outgoing)
        #expect(await eventually { current.watching })
        let oldQueue = BuildQueue(sessionId: "old-profile", steps: [], approved: false)
        await latch.release(.init(queues: ["old-profile": oldQueue]))
        await load.value
        outgoing.receive(name: "queue:update") // A cancelled tap can still deliver this frame.
        for _ in 0..<20 { await Task.yield() }
        #expect(await latch.calls == 1)
        #expect(!outgoing.settled)
        #expect(current.snapshot.queues["old-profile"] == nil)
        #expect(app.activeProfile?.id == second.id)
        app.teardown()
        #expect(await eventually { !current.watching })
    }

}
