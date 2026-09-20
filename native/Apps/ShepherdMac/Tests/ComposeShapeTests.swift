import Foundation
import ShepherdKit
import Testing
@testable import Shepherd

/// The create payload matrix is independent of the later POST /api/shape integration.
@MainActor @Suite struct ComposeShapeTests {
    @Test func guardControlsPreserveInheritanceUntilEachControlIsTouched() throws {
        let m = ComposeModelTests.composer()
        defer { m.teardown() }
        m.repoPath = "/repo"; m.prompt = "Do the task"
        let controls = GuardToggles(model: m)
        _ = controls.planGate.wrappedValue
        _ = controls.autopilot.wrappedValue
        var request = try #require(m.createRequest(baseBranch: "main"))
        #expect(request.planGateEnabled == nil && request.autopilotEnabled == nil)

        controls.planGate.wrappedValue = true
        request = try #require(m.createRequest(baseBranch: "main"))
        #expect(request.planGateEnabled == true && request.autopilotEnabled == nil)
        controls.planGate.wrappedValue = false
        controls.autopilot.wrappedValue = false
        request = try #require(m.createRequest(baseBranch: "main"))
        #expect(request.planGateEnabled == false && request.autopilotEnabled == false)
        controls.autopilot.wrappedValue = true
        let json = try encodedRequest(m)
        #expect(json["planGateEnabled"] as? Bool == false)
        #expect(json["autopilotEnabled"] as? Bool == true)
    }

    @Test(arguments: ComposeMode.allCases)
    func sandboxControlSerializesProfilesAndOmitsRepoDefault(_ mode: ComposeMode) throws {
        let m = ComposeModelTests.composer()
        defer { m.teardown() }
        m.repoPath = "/repo"; m.prompt = "Do the task"
        m.setMode(mode)
        let picker = SandboxPicker(model: m, holdLikely: false)
        for profile in [Components.Schemas.SandboxProfile.trusted, .standard, .autonomous] {
            picker.selection.wrappedValue = profile
            let json = try encodedRequest(m)
            if profile == .autonomous && (mode == .research || mode == .epic) {
                #expect(json["sandboxProfile"] as? String == "standard")
            } else {
                #expect(json["sandboxProfile"] as? String == profile.rawValue)
            }
        }
        picker.selection.wrappedValue = nil
        #expect(try encodedRequest(m)["sandboxProfile"] == nil)
    }

    private func encodedRequest(_ model: ComposeModel) throws -> [String: Any] {
        let request = try #require(model.createRequest(baseBranch: "main"))
        return try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
    }

    @Test(arguments: ComposeMode.allCases, [false, true])
    func eachModeSerializesEveryFlagAndGuard(_ mode: ComposeMode, touched: Bool) throws {
        let m = ComposeModelTests.composer()
        defer { m.teardown() }
        m.repoPath = "/repo"; m.prompt = "Do the task"
        m.planGateEnabled = true; m.autopilotEnabled = true
        m.planGateTouched = touched; m.autopilotTouched = touched
        m.setMode(mode)
        let request = try #require(m.createRequest(baseBranch: "main"))
        #expect(request.research == (mode == .research))
        #expect(request.epicAuthoring == (mode == .epic))
        #expect(request.plain == (mode == .plain))
        let guardValue: Bool? = mode == .code ? (touched ? true : nil) : false
        #expect(request.planGateEnabled == guardValue)
        #expect(request.autopilotEnabled == guardValue)
        #expect(request.sandboxProfile == nil)
        #expect(m.shapingOffered == (mode == .code))
        let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        #expect(json["research"] as? Bool == (mode == .research))
        #expect(json["epicAuthoring"] as? Bool == (mode == .epic))
        #expect(json["plain"] as? Bool == (mode == .plain))
        #expect(json["planGateEnabled"] as? Bool == guardValue)
        #expect(json["autopilotEnabled"] as? Bool == guardValue)
    }

    @Test(arguments: ComposeMode.allCases)
    func sandboxMatrixPreservesEveryAllowedProfile(_ mode: ComposeMode) throws {
        let profiles: [Components.Schemas.SandboxProfile?] = [nil, .trusted, .standard, .autonomous]
        for profile in profiles {
            let m = ComposeModelTests.composer()
            defer { m.teardown() }
            m.repoPath = "/repo"; m.prompt = "Do the task"
            m.sandboxProfile = profile
            m.setMode(mode)
            let expected = (mode == .research || mode == .epic) && profile == .autonomous ? nil : profile
            #expect(m.sandboxProfile == expected)
            let request = try #require(m.createRequest(baseBranch: "main"))
            #expect(request.sandboxProfile == expected)
        }
    }

    @Test func codeGuardsCarryIndependentTouchedValuesIncludingExplicitFalse() throws {
        let m = ComposeModelTests.composer()
        defer { m.teardown() }
        m.repoPath = "/repo"; m.prompt = "Do the task"
        for planTouched in [false, true] {
            for autoTouched in [false, true] {
                for value in [false, true] {
                    m.planGateTouched = planTouched; m.autopilotTouched = autoTouched
                    m.planGateEnabled = value; m.autopilotEnabled = !value
                    let request = try #require(m.createRequest(baseBranch: "main"))
                    #expect(request.planGateEnabled == (planTouched ? value : nil))
                    #expect(request.autopilotEnabled == (autoTouched ? !value : nil))
                }
            }
        }
    }

    @Test func reselectingSuggestedPlainPreservesBothGuardsWhenReturningToCode() throws {
        let m = ComposeModelTests.composer()
        defer { m.teardown() }
        m.repoPath = "/repo"
        let controls = GuardToggles(model: m)
        controls.planGate.wrappedValue = true
        controls.autopilot.wrappedValue = true
        m.prompt = "/design"
        #expect(m.mode == .plain)
        m.setMode(.plain)
        #expect(m.modeTouched)
        m.setMode(.code)
        let request = try #require(m.createRequest(baseBranch: "main"))
        #expect(request.planGateEnabled == true)
        #expect(request.autopilotEnabled == true)
    }

    @Test func designPreselectionDisablesWireGuardsWithoutLosingCodePreferences() throws {
        let m = ComposeModelTests.composer()
        defer { m.teardown() }
        m.repoPath = "/repo"; m.prompt = "/design layout"
        m.planGateEnabled = true; m.autopilotEnabled = true
        m.planGateTouched = true
        let plain = try #require(m.createRequest(baseBranch: "main"))
        #expect(plain.plain == true && plain.research == false && plain.epicAuthoring == false)
        #expect(plain.planGateEnabled == false && plain.autopilotEnabled == false)
        #expect(!m.autopilotTouched && m.planGateEnabled && m.autopilotEnabled)
        m.prompt = "implement the layout"
        let code = try #require(m.createRequest(baseBranch: "main"))
        #expect(code.plain == false && code.research == false && code.epicAuthoring == false)
        #expect(code.planGateEnabled == true && code.autopilotEnabled == nil)
    }
}

@MainActor @Suite struct ComposeShapingRoundTests {
    static func round(_ problem: String = "Problem") -> ShapeRound {
        .init(draft: .init(problem: problem, outcome: "Outcome", constraints: ["Keep API"], nonGoals: ["Rewrite"]),
              block: .init(_type: .questionForm, id: "shape-questions", questions: [
                .init(id: "single", prompt: "Scope?", kind: .init(known: .single), options: ["A", "B"]),
                .init(id: "multi", prompt: "Checks?", kind: .init(known: .multi), options: ["X", "Y"]),
                .init(id: "text", prompt: "Detail?", kind: .init(known: .freeform))
              ]))
    }
    static let request = ShapeRequest(repoPath: "/repo", prompt: "Rough", provider: .claude)

    @Test func blockersHaveTheRequiredPrecedence() {
        #expect(ShapeRoundModel.blocker(running: true, mode: .epic, repoPath: "", prompt: "") == "running")
        for mode in [ComposeMode.research, .epic, .plain] {
            #expect(ShapeRoundModel.blocker(running: false, mode: mode, repoPath: "", prompt: "") == "wrong_mode")
        }
        #expect(ShapeRoundModel.blocker(running: false, mode: .code, repoPath: "", prompt: "") == "no_repo")
        #expect(ShapeRoundModel.blocker(running: false, mode: .code, repoPath: "/repo", prompt: " \n") == "empty_prompt")
        #expect(ShapeRoundModel.blocker(running: false, mode: .code, repoPath: "/repo", prompt: "go") == nil)
    }

    @Test func answersAreGeneratedAndDraftOnlyRoundsCanBeUsed() async throws {
        let model = ShapeRoundModel(shape: { _ in Self.round() }, brief: { _ in "Brief" })
        await model.start(Self.request)
        #expect(!model.canUseBrief)
        model.single["single"] = 1
        model.freeform["text"] = "Keep latency"
        #expect(model.canUseBrief)
        #expect(model.answers == [
            RawAnswer(blockId: "shape-questions", questionId: "single", optionIndices: [1]),
            RawAnswer(blockId: "shape-questions", questionId: "multi", optionIndices: []),
            RawAnswer(blockId: "shape-questions", questionId: "text", text: "Keep latency")
        ])
        model.multi["multi"] = [1, 0]
        #expect(model.answers[1].optionIndices == [0, 1])
        model.single["single"] = 99
        #expect(!model.canUseBrief)
        var futureRound = Self.round()
        futureRound.block.questions[0].kind = .init(unknown: "future-kind")
        let future = ShapeRoundModel(shape: { _ in futureRound }, brief: { _ in "Brief" })
        await future.start(Self.request)
        #expect(!future.canUseBrief)
        #expect(!future.answers.contains { $0.questionId == "single" })
        var round = Self.round()
        round.block.questions = []
        let draftOnly = ShapeRoundModel(shape: { _ in round }, brief: { _ in "Brief" })
        await draftOnly.start(Self.request)
        #expect(draftOnly.canUseBrief)
        #expect(await draftOnly.useBrief([]) == "Brief")
    }

    @Test func supersededRoundAndLateFailureCannotReplaceTheCurrentRound() async throws {
        var pending: [CheckedContinuation<ShapeRound, any Error>] = []
        let model = ShapeRoundModel(shape: { _ in
            try await withCheckedThrowingContinuation { pending.append($0) }
        }, brief: { _ in "Brief" })
        let first = Task { await model.start(Self.request) }
        try await eventually { pending.count == 1 }
        model.discard()
        let second = Task { await model.start(Self.request) }
        try await eventually { pending.count == 2 }
        pending[1].resume(returning: Self.round("New"))
        await second.value
        pending[0].resume(throwing: ComposeShapeError.failed("timeout"))
        await first.value
        #expect(model.round?.draft.problem == "New")
        #expect(model.errorKey == nil)
        #expect(!model.running)
    }

    @Test func discardAndTeardownDropBufferedResults() async throws {
        for teardown in [false, true] {
            var pending: CheckedContinuation<ShapeRound, any Error>?
            let model = ShapeRoundModel(shape: { _ in
                try await withCheckedThrowingContinuation { pending = $0 }
            }, brief: { _ in "Brief" })
            let task = Task { await model.start(Self.request) }
            try await eventually { pending != nil }
            if teardown { model.teardown() } else { model.discard() }
            pending?.resume(returning: Self.round())
            await task.value
            #expect(model.round == nil)
            #expect(!model.running)
        }
    }

    @Test func allErrorSlugsUseExistingCopyAndComposeFailuresKeepTheRound() async {
        for slug in ["empty-prompt", "spawn-failed", "timeout", "unavailable", "future-slug"] {
            let model = ShapeRoundModel(shape: { _ in throw ComposeShapeError.failed(slug) }, brief: { _ in "" })
            await model.start(Self.request)
            let expected = slug == "future-slug" ? "timeout" : slug.replacingOccurrences(of: "-", with: "_")
            #expect(model.errorKey == "shape_err_\(expected)")
        }
        let model = ShapeRoundModel(shape: { _ in Self.round() }, brief: { _ in throw ShepherdError.badRequest("invalid round") })
        await model.start(Self.request)
        #expect(await model.useBrief([]) == nil)
        #expect(model.errorKey == "shape_err_compose")
        #expect(model.round != nil)
    }

    @Test func useBriefReplacesWholePromptAndContextChangesInvalidatePendingWork() async throws {
        var pending: CheckedContinuation<String, any Error>?
        var captured: ShapeRequest?
        let shape = ShapeRoundModel(shape: { request in captured = request; return Self.round() }, brief: { _ in
            try await withCheckedThrowingContinuation { pending = $0 }
        })
        let composer = ComposeModelTests.composer(shaping: shape)
        composer.repoPath = "/repo"; composer.prompt = "Rough prompt"
        await composer.startShaping()
        #expect(captured?.model == nil)
        let first = Task { await composer.useBrief([]) }
        try await eventually { pending != nil }
        pending?.resume(returning: "Whole brief")
        await first.value
        #expect(composer.prompt == "Whole brief")
        #expect(shape.round == nil)
        await composer.startShaping()
        pending = nil
        let stale = Task { await composer.useBrief([]) }
        try await eventually { pending != nil }
        composer.prompt = "New operator edit"
        pending?.resume(returning: "Stale brief")
        await stale.value
        #expect(composer.prompt == "New operator edit")
        for change in [{ composer.repoPath = "/other" }, { composer.provider = .codex },
                       { composer.model = "gpt-6-astra" },
                       { composer.setMode(.research) }] {
            await composer.startShaping()
            change()
            #expect(shape.round == nil)
        }
        composer.teardown()
    }

    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(condition())
    }
}
