import Foundation
import ShepherdKit
import Testing
@testable import Shepherd

@MainActor @Suite struct ComposeModelTests {
    private func model(
        branches: @escaping (String) async throws -> BranchListing = { _ in .init(branches: []) },
        status: @escaping (String, String) async throws -> BranchStatus = { _, _ in
            .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: false)
        },
        repair: @escaping (String, String) async throws -> InitEmptyCommitResponse = { _, branch in .init(branch: branch) },
        sleep: @escaping (Duration) async throws -> Void = { _ in }
    ) -> RepoBranchModel {
        RepoBranchModel(loadBranches: branches, loadStatus: status, repair: repair, debounce: sleep)
    }

    private func eventually(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        #expect(predicate())
    }

    @Test func baseChoiceUsesExactWebFallbackOrder() {
        #expect(RepoBranchModel.pickBaseBranch(.init(branches: ["recent"], current: "checkout", _default: "trunk")) == "trunk")
        #expect(RepoBranchModel.pickBaseBranch(.init(branches: ["recent"], current: "checkout")) == "checkout")
        #expect(RepoBranchModel.pickBaseBranch(.init(branches: ["recent"])) == "recent")
        #expect(RepoBranchModel.pickBaseBranch(.init(branches: [])) == "main")
        #expect(RepoBranchModel.pickBaseBranch(.init(branches: ["recent"], current: "", _default: "")) == "")
    }

    @Test func missingBaseRequiresAllFourTerms() async throws {
        for hasBranches in [false, true] {
            for local in [false, true] {
                for upstream in [false, true] {
                    let m = model(branches: { _ in .init(branches: hasBranches ? ["main"] : []) }, status: { _, _ in
                        .init(behind: 0, ahead: 0, diverged: false, hasUpstream: upstream, localExists: local)
                    })
                    #expect(!m.baseMissing)
                    m.selectRepo("/repo")
                    try await eventually { m.upstream != nil }
                    #expect(m.baseMissing == (!hasBranches && !local && !upstream))
                    m.teardown()
                }
            }
        }
    }

    @Test func statusDebounces300msAndDropsLateAnswersEvenAfterReturningToSameBranch() async throws {
        var delays: [Duration] = []
        var sleeps: [CheckedContinuation<Void, Never>] = []
        var statuses: [CheckedContinuation<BranchStatus, Never>] = []
        let m = model(status: { _, _ in await withCheckedContinuation { statuses.append($0) } }, sleep: { duration in
            delays.append(duration)
            await withCheckedContinuation { sleeps.append($0) }
        })
        m.selectRepo("/repo")
        try await eventually { sleeps.count == 1 }
        #expect(delays == [.milliseconds(300)])
        #expect(statuses.isEmpty)
        sleeps[0].resume()
        try await eventually { statuses.count == 1 }
        m.baseBranch = "other"
        try await eventually { sleeps.count == 2 }
        m.baseBranch = "main"
        try await eventually { sleeps.count == 3 }
        sleeps[1].resume(); sleeps[2].resume()
        try await eventually { statuses.count == 2 }
        statuses[1].resume(returning: .init(behind: 2, ahead: 0, diverged: false, hasUpstream: true, localExists: true))
        try await eventually { m.upstream?.behind == 2 }
        statuses[0].resume(returning: .init(behind: 99, ahead: 0, diverged: false, hasUpstream: true, localExists: true))
        // Let the resumed, cancelled task run before observing its guarded write.
        for _ in 0..<20 { await Task.yield() }
        #expect(m.upstream?.behind == 2)
        m.teardown()
    }

    @Test func lateRepoListingAndFailureCannotReplaceCurrentSelection() async throws {
        var pending: CheckedContinuation<BranchListing, any Error>?
        let m = model(branches: { repo in
            if repo == "/slow" { return try await withCheckedThrowingContinuation { pending = $0 } }
            return .init(branches: ["trunk"], _default: "origin-default")
        })
        m.selectRepo("/slow")
        try await eventually { pending != nil }
        m.selectRepo("/fast")
        try await eventually { m.baseBranch == "origin-default" }
        #expect(m.baseOptions == ["origin-default", "trunk"])
        pending?.resume(throwing: ShepherdError.badRequest("late"))
        for _ in 0..<20 { await Task.yield() }
        #expect(m.branches == ["trunk"])
        #expect(m.error == nil)
        m.teardown()
    }

    @Test func repairInvalidatesPreRepairStatusAndRefreshesBranches() async throws {
        var oldStatus: CheckedContinuation<BranchStatus, Never>?
        var repaired = false
        var repairs = 0
        let m = model(branches: { _ in .init(branches: repaired ? ["main"] : []) }, status: { _, _ in
            if !repaired { return await withCheckedContinuation { oldStatus = $0 } }
            return .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: true)
        }, repair: { _, branch in repairs += 1; repaired = true; return .init(branch: branch) })
        m.selectRepo("/repo")
        try await eventually { oldStatus != nil }
        await m.repairInitialCommit()
        #expect(repairs == 1)
        #expect(m.branches == ["main"])
        #expect(m.upstream?.localExists == true)
        oldStatus?.resume(returning: .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: false))
        for _ in 0..<20 { await Task.yield() }
        #expect(!m.baseMissing)
        #expect(m.upstream?.localExists == true)
        #expect(!m.repairingBase)
        m.teardown()
    }

    @Test func repairRejectsDuplicatesAndLateCompletionAfterRepoChange() async throws {
        var pending: CheckedContinuation<InitEmptyCommitResponse, Never>?
        var calls = 0
        let m = model(repair: { _, _ in calls += 1; return await withCheckedContinuation { pending = $0 } })
        m.selectRepo("/a")
        let first = Task { await m.repairInitialCommit() }
        try await eventually { pending != nil }
        await m.repairInitialCommit()
        #expect(calls == 1)
        m.selectRepo("/b")
        pending?.resume(returning: .init(branch: "stale"))
        await first.value
        #expect(m.repoPath == "/b" && m.baseBranch == "main")
        #expect(!m.repairingBase)
        m.teardown()
    }

    @Test func repairFailureCanBeRetriedAndTeardownDropsLateWork() async throws {
        var calls = 0
        let m = model(repair: { _, branch in
            calls += 1
            if calls == 1 { throw ShepherdError.unprocessable("failed") }
            return .init(branch: branch)
        })
        m.selectRepo("/repo")
        await m.repairInitialCommit()
        #expect(m.error != nil && !m.repairingBase)
        await m.repairInitialCommit()
        #expect(calls == 2 && m.error == nil)
        m.teardown()
        #expect(!m.upstreamLoading)
        #expect(!m.loadingBranches)
    }

    @Test func missingBaseRepairFailureKeepsTheRetryActionAvailable() async throws {
        let m = model(repair: { _, _ in throw ShepherdError.unprocessable("failed") })
        m.selectRepo("/repo")
        try await eventually { m.baseMissing }
        await m.repairInitialCommit()
        #expect(m.baseMissing && m.error != nil && !m.repairingBase)
        m.teardown()
    }

    @Test func teardownFencesLateStatusAndRepairResults() async throws {
        var status: CheckedContinuation<BranchStatus, Never>?
        var repair: CheckedContinuation<InitEmptyCommitResponse, Never>?
        let m = model(status: { _, _ in await withCheckedContinuation { status = $0 } },
                      repair: { _, _ in await withCheckedContinuation { repair = $0 } })
        m.selectRepo("/repo")
        try await eventually { status != nil }
        let task = Task { await m.repairInitialCommit() }
        try await eventually { repair != nil }
        m.teardown()
        status?.resume(returning: .init(behind: 99, ahead: 0, diverged: false, hasUpstream: true, localExists: true))
        repair?.resume(returning: .init(branch: "late"))
        await task.value
        for _ in 0..<20 { await Task.yield() }
        #expect(m.upstream == nil && m.baseBranch == "main")
        #expect(!m.repairingBase && !m.upstreamLoading)
    }

    @Test func lateListingDoesNotOverwriteTypedBaseAndUnknownStatusIsNotMissing() async throws {
        var listing: CheckedContinuation<BranchListing, Never>?
        let m = model(branches: { _ in await withCheckedContinuation { listing = $0 } },
                      status: { _, _ in throw ShepherdError.transport("offline") })
        m.selectRepo("/repo")
        try await eventually { listing != nil }
        m.baseBranch = "typed"
        listing?.resume(returning: .init(branches: [], _default: "trunk"))
        try await eventually { !m.loadingBranches && !m.upstreamLoading }
        #expect(m.baseBranch == "typed" && !m.baseMissing && m.upstream == nil)
        m.teardown()
    }

    @Test func repoActionsWrapAndExcludeHiddenRepos() {
        func repo(_ path: String, hidden: Bool = false) -> Repo {
            .init(name: path, path: path, display: path, realPath: path, isFork: false, hidden: hidden)
        }
        let prefs = UserDefaults(suiteName: "ComposeModelTests.\(UUID())")!
        let m = ComposeModel(defaults: prefs, repoBranches: model(), loadIssues: { _ in .init(issues: []) },
                             loadCommands: { _, _ in .init(commands: []) }, loadEpics: { _ in .init(epics: [], subIssues: []) })
        let repos = [repo("/a"), repo("/hidden", hidden: true), repo("/b")]
        m.cycleRepo(1, repos: repos); #expect(m.repoPath == "/a")
        m.cycleRepo(-1, repos: repos); #expect(m.repoPath == "/b")
        m.cycleRepo(1, repos: repos); #expect(m.repoPath == "/a")
        m.openRepoPicker(); #expect(m.repoBranches.presentedPicker == .repo)
        m.openBranchPicker(); #expect(m.repoBranches.presentedPicker == .branch)
        m.teardown()
    }
}
