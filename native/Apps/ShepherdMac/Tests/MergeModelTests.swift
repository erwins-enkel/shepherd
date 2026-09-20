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
}
