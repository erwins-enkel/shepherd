import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

@MainActor struct MergeQueueTests {
    private func step(_ id: String) -> BuildStep {
        .init(id: id, title: id, detail: "", status: .init(known: .pending), position: 0)
    }
    private func eventually(_ condition: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(2)
        while !(await condition()), ContinuousClock.now < deadline { await Task.yield() }
        return await condition()
    }
    @Test func addBeforeInitialSnapshotSendsNothing() async {
        let latch = MergeLatch()
        let model = MergeModel(reads: .init(snapshot: { await latch.read() }))
        let load = Task { await model.refresh() }
        #expect(await eventually { await latch.waiting })
        var writes = 0
        model.editQueue(id: "a", edit: { $0.append(step("new")) }) { _ in
            writes += 1
            return .init(sessionId: "a", steps: [], approved: false)
        }
        #expect(await eventually { !model.busy })
        #expect(writes == 0)
        guard case .unloaded = model.queueState(id: "a") else {
            Issue.record("initial queue must be unloaded")
            model.teardown(); await latch.release(.init()); await load.value; return
        }
        model.teardown(); await latch.release(.init()); await load.value
    }
    @Test func addAfterFailedSnapshotSendsNothing() async {
        let model = MergeModel(reads: .init(snapshot: { throw ShepherdError.notFound }))
        defer { model.teardown() }
        await model.refresh()
        var writes = 0
        model.editQueue(id: "a", edit: { $0.append(step("new")) }) { _ in
            writes += 1
            return .init(sessionId: "a", steps: [], approved: false)
        }
        #expect(await eventually { !model.busy })
        #expect(writes == 0)
        guard case .failed = model.queueState(id: "a") else {
            Issue.record("failed queue must not be treated as empty"); return
        }
    }
    @Test func successiveRemovalsUsePutResponseWhileRefreshIsDelayed() async {
        let initial = BuildQueue(sessionId: "a", steps: [step("A"), step("B")], approved: false)
        let latch = MergeLatch()
        let model = MergeModel(reads: .init(snapshot: { await latch.read() }))
        let load = Task { await model.refresh() }
        #expect(await eventually { await latch.waiting })
        await latch.release(.init(queues: ["a": initial])); await load.value
        var sent: [[String]] = []
        func remove(_ id: String) {
            model.editQueue(id: "a", edit: { $0.removeAll { $0.id == id } }) { body in
                sent.append(body.steps.compactMap(\.id))
                return .init(sessionId: "a", steps: body.steps.map {
                    step($0.id!)
                }, approved: true)
            }
        }
        remove("A")
        #expect(await eventually { !model.busy && model.snapshot.queues["a"]?.steps.count == 1 })
        #expect(await eventually { await latch.waiting })
        #expect(model.snapshot.queues["a"]?.approved == true)
        remove("B")
        #expect(await eventually { !model.busy })
        #expect(sent == [["B"], []])
        #expect(model.snapshot.queues["a"]?.steps.isEmpty == true)
        // The GET started after the first PUT, but before the second. Its stale
        // response must trigger reconciliation rather than resurrecting either row.
        await latch.release(.init(queues: ["a": initial]))
        #expect(await eventually { await latch.calls == 3 })
        #expect(model.snapshot.queues["a"]?.steps.isEmpty == true)
        model.teardown(); await latch.release(.init())
    }
    @Test func successfulMissingQueueIsEditableEmpty() async {
        let model = MergeModel(reads: .init(snapshot: { .init() }))
        defer { model.teardown() }
        await model.refresh()
        guard case .loaded(let queue) = model.queueState(id: "a") else {
            Issue.record("successful absence must allow the first step"); return
        }
        #expect(queue.steps.isEmpty)
        var sent: [String] = []
        model.editQueue(id: "a", edit: { $0.append(step("new")) }) { body in
            sent = body.steps.compactMap(\.id)
            return .init(sessionId: "a", steps: [step("new")], approved: false)
        }
        #expect(await eventually { !model.busy })
        #expect(sent == ["new"])
    }
    @Test func approvalPublishesBeforeUnlockingAndCannotSteerTwiceDuringDelayedRefresh() async {
        let initial = BuildQueue(sessionId: "a", steps: [step("A")], approved: false)
        let latch = MergeLatch()
        let model = MergeModel(reads: .init(snapshot: { await latch.read() }))
        let load = Task { await model.refresh() }
        #expect(await eventually { await latch.waiting })
        await latch.release(.init(queues: ["a": initial])); await load.value
        // A read already in flight must not undo the approval response, either.
        let staleRead = Task { await model.refresh() }
        #expect(await eventually { await latch.waiting })
        var sends = 0
        func approve() {
            model.approveQueue(id: "a") {
                sends += 1
                var approved = initial; approved.approved = true
                return approved
            }
        }
        approve()
        #expect(await eventually { !model.busy })
        #expect(model.snapshot.queues["a"]?.approved == true)
        approve()
        #expect(await eventually { !model.busy })
        #expect(sends == 1)
        await latch.release(.init(queues: ["a": initial]))
        #expect(await eventually { await latch.calls == 3 })
        #expect(model.snapshot.queues["a"]?.approved == true)
        model.teardown(); await latch.release(.init()); await staleRead.value
    }
}
