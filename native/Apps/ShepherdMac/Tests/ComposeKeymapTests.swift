import Foundation
import ShepherdKit
import SwiftUI
import Testing
@testable import Shepherd

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
        submission.receive(.init(spawnId: "other", phase: .base, startedAt: 0, completed: []))
        #expect(submission.progress == nil)
        submission.receive(.init(spawnId: id, phase: .agent, startedAt: 0, completed: []))
        #expect(submission.progress?.phase == .agent)
        submission.teardown()
        submission.receive(.init(spawnId: id, phase: .base, startedAt: 0, completed: []))
        #expect(submission.progress == nil)
        pending?.resume(throwing: ShepherdError.cancelled)
        _ = await task.value
    }

    private func eventually(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        try #require(predicate())
    }

    @Test func holdPredictionUsesClaudeQuotaAndConfiguredThreshold() throws {
        var settings = try JSONDecoder().decode(ShepherdKit.Settings.self, from: Data(#"{"repoRoot":"/repo","repoRootDisplay":"repo","firstRunPending":false,"defaultModel":"auto","defaultEffort":"default","defaultAgentProvider":"claude","authMode":"subscription","operatorLanguage":"en","usageHoldEnabled":true,"usageHoldPct":80}"#.utf8))
        let limits = UsageLimits(session5h: .init(pct: 80, resetAt: 0), week: nil, perModelWeek: [],
                                 credits: nil, stale: false, calibratedAt: nil, subscriptionOnly: true)
        #expect(ComposeReadiness.holdLikely(limits: limits, settings: settings))
        #expect(!ComposeReadiness.holdLikely(limits: nil, settings: settings))
        settings.additionalProperties.value["usageHoldEnabled"] = false
        #expect(!ComposeReadiness.holdLikely(limits: limits, settings: settings))
    }

    @Test func installerFillsOnlyContentAndCanRestoreFallback() {
        let previous = NewSessionSlot.content
        defer { NewSessionSlot.content = previous }
        let suite = "ComposeInstallTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        ComposeStream.install(app)
        #expect(NewSessionSlot.resolution == .slot)
        NewSessionSlot.content = nil
        #expect(NewSessionSlot.resolution == .fallback)
    }

    @Test func forceIsExplicitAndHeldKeepsDraft() async {
        let model = composer()
        defer { model.teardown() }
        model.repoPath = "/repo"; model.prompt = "Fix"
        let submission = ComposeSubmission()
        defer { submission.teardown() }
        let result = await submission.submit(model: model, repoResolved: true, holdLikely: true, force: true,
            create: { request, _ in
                #expect(request.force == true)
                return .held(.init(held: true, id: "held", count: 1))
            }, isCurrent: { true })
        #expect(result == nil)
        #expect(submission.message == L.t("native_newsession_held"))
        #expect(!submission.busy)
        #expect(model.prompt == "Fix")
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

}
