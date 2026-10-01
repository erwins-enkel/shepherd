import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
struct ReadOnlySidebarRecoveryTests {
    @Test func concurrentRecoveryCallsCoalesceAndTeardownRejectsFurtherReads() async {
        let gate = LoadGate()
        var reads = 0
        let recovery = ReadOnlySidebarRecovery {
            reads += 1
            await gate.wait()
        }
        let first = Task { await recovery.refresh() }
        #expect(await settleDetail(until: { gate.isWaiting }))
        let second = Task { await recovery.refresh() }
        for _ in 0..<20 { await Task.yield() }
        #expect(reads == 1)
        gate.open()
        await first.value
        await second.value
        await recovery.refresh()
        #expect(reads == 2)
        recovery.teardown()
        await recovery.refresh()
        #expect(reads == 2)
    }

    @Test func supersededActivationRejectsRecoveryBeforeReadsStart() async {
        var current = true
        var reads = 0
        let recovery = ReadOnlySidebarRecovery(isCurrent: { current }) { reads += 1 }
        let work = Task { await recovery.refresh() }
        current = false
        await work.value
        #expect(reads == 0)
    }

    @Test func teardownDuringRecoveryDropsSuspendedQueueSnapshot() async {
        let gate = LoadGate()
        let queues = QueuesModel(reads: .init(held: { [] }, done: { [] }, recaps: { [:] }, stranded: { [] },
            refreshUpNext: { Issue.record("read-only recovery must not recompute") }, peekUpNext: {
                await gate.wait()
                return UpNextSnapshot(generatedAt: 42, sections: [], repoCount: 1, fallback: nil, failedRepoCount: 0)
            }))
        let recovery = ReadOnlySidebarRecovery {
            await ReadOnlySidebarRecovery.readSnapshots(sidebar: nil, herd: nil, plan: nil,
                queues: queues, merge: nil, actions: nil)
        }
        let work = Task { await recovery.refresh() }
        #expect(await settleDetail(until: { gate.isWaiting }))
        recovery.teardown()
        gate.open()
        await work.value
        #expect(queues.upNext == nil)
    }

    @Test func recoveryRepairsAllInstalledSnapshotsWithoutQueueComputation() async {
        let sidebar = SidebarModel(reads: .stub, now: { 0 })
        let git = GitState(state: .init(known: .open), checks: .init(known: .failure), deployConfigured: false)
        let herd = HerdSignals(reads: .init(git: { ["s1": git] }, activity: { [:] },
            claudeAlive: { ["s1": true] }, verdicts: { [:] }, reviewing: { [] }), now: { 0 })
        let plan = PlanModel(reads: .init(gates: { [:] }, inflight: { [] }))
        let done = PreviewData.session(id: "archived", status: .init(known: .archived))
        let cache = UpNextSnapshot(generatedAt: 42, sections: [], repoCount: 1, fallback: nil, failedRepoCount: 0)
        let queues = QueuesModel(reads: .init(held: { [] }, done: { [done] }, recaps: { [:] }, stranded: { [] },
            refreshUpNext: { Issue.record("read-only recovery must not recompute") }, peekUpNext: { cache }))
        let owed = PostMergeSteps(sessionId: "s1", desig: "TASK-1", repoPath: "/repo", prNumber: 1,
            prTitle: "Owed", steps: [], trackingIssueUrl: nil, trackingIssueNumber: nil,
            createdAt: 1, updatedAt: 1, clearedAt: nil)
        let merge = MergeModel(reads: .init(snapshot: { MergeSnapshot(owed: [owed]) }))
        let recovery = ReadOnlySidebarRecovery {
            await ReadOnlySidebarRecovery.readSnapshots(sidebar: sidebar, herd: herd, plan: plan,
                queues: queues, merge: merge, actions: nil)
        }
        // No connection transition or event is needed to repair missed snapshots.
        await recovery.refresh()
        #expect(sidebar.workingBlocked["s1"] == true)
        #expect(herd.git["s1"] == git)
        #expect(plan.hasLoadedSnapshot)
        #expect(queues.finishedSessions.map(\.id) == ["archived"])
        #expect(queues.upNext == cache)
        #expect(merge.snapshot.owed.map(\.sessionId) == ["s1"])
    }
}
}
