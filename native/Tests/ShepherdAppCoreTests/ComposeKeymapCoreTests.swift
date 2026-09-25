import Foundation
import ShepherdKit
import SwiftUI
import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor @Suite struct ComposeKeymapTests {
    private func composer() -> ComposeModel {
        ComposeModel(defaults: UserDefaults(suiteName: "ComposeKeymapTests.\(UUID())")!,
            repoBranches: RepoBranchModel(loadBranches: { _ in .init(branches: ["main"]) },
                loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false, hasUpstream: true, localExists: true) },
                repair: { _, branch in .init(branch: branch) }),
            loadIssues: { _ in .init(issues: []) }, loadCommands: { _, _ in .init(commands: []) },
            loadEpics: { _ in .init(epics: [], subIssues: []) })
    }

    @Test func registryMatchesWebAndHasNoDuplicateChords() {
        #expect(ComposeKeymap.entries.count == 26)
        let chords = ComposeKeymap.entries.compactMap(\.chord)
        #expect(Set(chords).count == chords.count)
        #expect(ComposeKeymap.entry("model").chord == .init("m", .option))
        #expect(ComposeKeymap.entry("autopilot").chord == .init("a", .option))
        #expect(ComposeKeymap.entry("submit").cap == "⌘↵")
        #expect(!ComposeKeymap.canDispatch("sheet", editingText: true))
        #expect(ComposeKeymap.canDispatch("sheet", editingText: false))
        #expect(!ComposeKeymap.canDispatch("paste-image", editingText: true))
        #expect(!ComposeKeymap.canDispatch("dictate", editingText: false))
    }

    @Test func readinessPrecedenceAndExclusiveAdvisories() {
        var input = ComposeReadiness.Input(promptEmpty: true, issueSeeded: false, repoResolved: false,
            baseMissing: true, repairing: true, uploading: true, submitting: true,
            checking: true, diverged: true, behind: true, holdLikely: true, provider: .claude)
        for expected in ["submitting", "uploading", "repairing", "no_repo", "base_missing", "empty_prompt"] {
            let result = ComposeReadiness.derive(input)
            #expect(result.blocker == expected)
            #expect(!result.canSubmit)
            switch expected {
            case "submitting": input.submitting = false
            case "uploading": input.uploading = false
            case "repairing": input.repairing = false
            case "no_repo": input.repoResolved = true
            case "base_missing": input.baseMissing = false
            default: input.issueSeeded = true
            }
        }
        #expect(ComposeReadiness.derive(input).canSubmit)
        #expect(ComposeReadiness.derive(input).advisories == ["checking", "hold_likely"])
        input.checking = false
        #expect(ComposeReadiness.derive(input).advisories == ["diverged", "hold_likely"])
        input.diverged = false
        #expect(ComposeReadiness.derive(input).advisories == ["behind", "hold_likely"])
        input.provider = .codex
        #expect(ComposeReadiness.derive(input).advisories == ["behind"])
    }

    @Test func emptyPromptWithSameRepoIssueMaterializesAtSubmit() throws {
        let model = composer()
        defer { model.teardown() }
        model.repoPath = "/repo"
        model.pickIssue(.init(number: 12, title: "Fix", body: "Details", url: "https://example.com/12", labels: [], createdAt: 0, assignees: []))
        model.prompt = "  "
        let request = try #require(model.createRequest(baseBranch: "main"))
        #expect(request.prompt == L.t("newtask_issue_prompt_template", "12", "Fix"))
        model.repoPath = "/other"
        #expect(model.createRequest(baseBranch: "main") == nil)
    }

    @Test func pickingAnIssueSubmitsItsContextAndReturnsTheStartedSession() async throws {
        let model = composer()
        let submission = ComposeSubmission()
        defer { model.teardown(); submission.teardown() }
        model.repoPath = "/repo"
        model.pickIssue(.init(number: 12, title: "Fix", body: "Details",
                              url: "https://example.com/12", labels: [], createdAt: 0, assignees: []))
        let result = await submission.submit(model: model, repoResolved: true, holdLikely: false,
            create: { request, correlation in
                #expect(request.repoPath == "/repo")
                #expect(request.prompt == L.t("newtask_issue_prompt_template", "12", "Fix"))
                #expect(request.issueRef?.number == 12)
                #expect(request.issueRef?.url == "https://example.com/12")
                #expect(request.issueRef?.body == "Details")
                #expect(!correlation.isEmpty)
                return .created(PreviewData.session(id: "started-issue-12"))
            }, isCurrent: { true })
        #expect(try #require(result).id == "started-issue-12")
        #expect(!submission.busy)
    }

    @Test func submitDefaultsToHoldAndFencesLateCompletion() async throws {
        let model = composer()
        defer { model.teardown() }
        model.repoPath = "/repo"; model.prompt = "Fix"
        let submission = ComposeSubmission()
        var requests: [CreateSessionRequest] = []
        var pending: CheckedContinuation<CreateOutcome, any Error>?
        let task = Task {
            await submission.submit(model: model, repoResolved: true, holdLikely: true,
                create: { request, _ in
                    requests.append(request)
                    return try await withCheckedThrowingContinuation { pending = $0 }
                }, isCurrent: { true })
        }
        try await eventually { pending != nil }
        #expect(submission.busy)
        #expect(requests.first?.force == false)
        let second = await submission.submit(model: model, repoResolved: true, holdLikely: true,
            force: true, create: { _, _ in Issue.record("Duplicate submission"); throw ShepherdError.cancelled },
            isCurrent: { true })
        #expect(second == nil)
        submission.teardown()
        pending?.resume(throwing: ShepherdError.badRequest("late"))
        #expect(await task.value == nil)
        #expect(submission.message == nil)
        #expect(model.prompt == "Fix")
    }

    @Test func spawnFramesRequireActiveCorrelationAndGeneration() async throws {
        let submission = ComposeSubmission()
        let model = composer()
        defer { model.teardown() }
        model.repoPath = "/repo"; model.prompt = "Fix"
        var pending: CheckedContinuation<CreateOutcome, any Error>?
        let task = Task {
            await submission.submit(model: model, repoResolved: true, holdLikely: false,
                create: { _, _ in try await withCheckedThrowingContinuation { pending = $0 } },
                isCurrent: { true })
        }
        try await eventually { pending != nil }
        let id = submission.spawnID!
        submission.receive(.init(spawnId: "other", phase: .init(known: .base), startedAt: 0, completed: []))
        #expect(submission.progress == nil)
        submission.receive(.init(spawnId: id, phase: .init(known: .agent), startedAt: 0, completed: []))
        #expect(submission.progress?.phase.known == .agent)
        submission.teardown()
        submission.receive(.init(spawnId: id, phase: .init(known: .base), startedAt: 0, completed: []))
        #expect(submission.progress == nil)
        pending?.resume(throwing: ShepherdError.cancelled)
        _ = await task.value
    }

    @Test func teardownFinishesTheSpawnProgressConsumer() async throws {
        let submission = ComposeSubmission()
        let model = composer()
        defer { model.teardown(); submission.teardown() }
        model.repoPath = "/repo"; model.prompt = "Fix"
        let (events, continuation) = AsyncStream<ServerEvent>.makeStream()
        let (termination, finished) = AsyncStream<Void>.makeStream()
        continuation.onTermination = { _ in finished.yield(()); finished.finish() }
        var pending: CheckedContinuation<CreateOutcome, any Error>?
        let task = Task {
            await submission.submit(model: model, repoResolved: true, holdLikely: false, events: events,
                create: { _, _ in try await withCheckedThrowingContinuation { pending = $0 } },
                isCurrent: { true })
        }
        try await eventually { pending != nil }
        submission.teardown()
        // Bound the wait so a mutation that merely drops the task handle fails, not hangs.
        let timeout = Task {
            try? await Task.sleep(for: .seconds(2))
            finished.finish()
        }
        var iterator = termination.makeAsyncIterator()
        let terminated = await iterator.next() != nil
        timeout.cancel()
        #expect(terminated)
        if case .terminated = continuation.yield(.sessionNew(PreviewData.session())) {} else {
            Issue.record("The spawn progress watcher is still receiving events after teardown")
        }
        pending?.resume(throwing: ShepherdError.cancelled)
        _ = await task.value
    }

    @Test func unknownSpawnPhaseUsesLocalizedFallback() {
        #expect(ComposeSubmission.phaseCopy(.init(unknown: "future-phase")) == L.t("newtask_spawning"))
        #expect(ComposeSubmission.phaseCopy(.init(known: .agent)) == L.t("newtask_spawn_phase_agent"))
    }

    private func eventually(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        try #require(predicate())
    }

    @Test func holdPredictionUsesClaudeQuotaAndConfiguredThreshold() throws {
        var settings = try JSONDecoder().decode(ShepherdKit.Settings.self, from: Data(#"{"repoRoot":"/repo","repoRootDisplay":"repo","firstRunPending":false,"defaultModel":"auto","defaultEffort":"default","defaultAgentProvider":"claude","authMode":"subscription","operatorLanguage":"en","usageHoldEnabled":true,"usageHoldPct":80}"#.utf8))
        let limits = UsageLimits(session5h: .init(pct: 80, resetAt: 0), week: nil, perModelWeek: [],
                                 credits: nil, stale: false, calibratedAt: nil, subscriptionOnly: true)
        #expect(ComposeReadiness.holdLikely(limits: limits, settings: settings))
        #expect(!ComposeReadiness.holdLikely(limits: nil, settings: settings))
        settings.usageHoldPct = 81
        #expect(!ComposeReadiness.holdLikely(limits: limits, settings: settings))
        settings.usageHoldPct = nil
        #expect(ComposeReadiness.holdLikely(limits: limits, settings: settings))
        settings.usageHoldEnabled = false
        #expect(!ComposeReadiness.holdLikely(limits: limits, settings: settings))
    }

    @Test func forceIsExplicitAndHeldResetsDraft() async {
        let model = composer()
        defer { model.teardown() }
        model.repoPath = "/repo"; model.prompt = "Fix"
        let submission = ComposeSubmission()
        defer { submission.teardown() }
        var closed = false
        let result = await submission.submit(model: model, repoResolved: true, holdLikely: true, force: true,
            create: { request, _ in
                #expect(request.force == true)
                return .held(.init(held: true, id: "held", count: 1))
            }, onHeld: { closed = true }, isCurrent: { true })
        #expect(closed)
        #expect(result == nil)
        #expect(submission.message == L.t("native_newsession_held"))
        #expect(!submission.busy)
        #expect(model.prompt.isEmpty)
        _ = await submission.submit(model: model, repoResolved: true, holdLikely: true,
            create: { _, _ in Issue.record("Held task submitted twice"); throw ShepherdError.cancelled },
            isCurrent: { true })
    }

    @Test func aProfileSwitchDropsASuccessfulCreate() async {
        let model = composer()
        defer { model.teardown() }
        model.repoPath = "/repo"; model.prompt = "Fix"
        let submission = ComposeSubmission()
        defer { submission.teardown() }
        var current = true
        let result = await submission.submit(model: model, repoResolved: true, holdLikely: false,
            create: { _, _ in
                current = false
                return .created(PreviewData.session(id: "new"))
            }, isCurrent: { current })
        #expect(result == nil)
        #expect(submission.message == nil)
    }

    @Test func cancelRaceNeverDropsAnAgentThatAlreadyStarted() async throws {
        let model = composer()
        defer { model.teardown() }
        model.repoPath = "/repo"; model.prompt = "Fix"
        let submission = ComposeSubmission()
        defer { submission.teardown() }
        var pending: CheckedContinuation<CreateOutcome, any Error>?
        let task = Task {
            await submission.submit(model: model, repoResolved: true, holdLikely: false,
                create: { _, _ in try await withCheckedThrowingContinuation { pending = $0 } },
                isCurrent: { true })
        }
        try await eventually { pending != nil }
        await submission.cancel(using: { _ in false }, isCurrent: { true })
        #expect(submission.busy)
        #expect(!submission.cancelRequested)
        pending?.resume(returning: .created(PreviewData.session(id: "won-race")))
        #expect(await task.value?.id == "won-race")
    }

    @Test func failedCreatePreservesDraftAndDiagnosesWithoutResubmitting() async {
        let model = composer()
        model.repoPath = "/repo"; model.prompt = "preserve this draft"
        let recovery = BackendRecoveryModel(reads: .init(health: { false }, diagnostics: { throw ShepherdError.transport("offline") }))
        let submission = ComposeSubmission()
        var creates = 0
        _ = await submission.submit(model: model, repoResolved: true, holdLikely: false,
            recovery: recovery, create: { _, _ in creates += 1; throw ShepherdError.transport("offline") }, isCurrent: { true })
        #expect(creates == 1)
        #expect(model.prompt == "preserve this draft")
        #expect(submission.recoveryFailure == .serverUnavailable)
        #expect(!submission.busy)
        model.teardown(); submission.teardown(); recovery.teardown()
    }

}
}
