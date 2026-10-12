import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

/// Run on in New Task (#2776): the native composer leaves the machine to the server unless the
/// operator names one, reads the task's requirements while that can matter, and keys every create
/// while the machine choice is available. Mirrors `NewTask.svelte`'s run-on logic.
@MainActor
private final class FakeReads {
    var preview: (PlacementRequest) throws -> PlacementPreview = { _ in try wire(#"{"active":false}"#) }
    var derive: (RequirementsDeriveRequest) throws -> RequirementsDerivation = { _ in try wire(#"{"status":"skipped"}"#) }
    var previews: [PlacementRequest] = []
    var derives: [RequirementsDeriveRequest] = []
}

private func wire<T: Decodable>(_ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

private let linuxJSON = #"{"instanceId":"linux","name":"moes-tavern","platform":"linux"}"#
private let macJSON = #"{"instanceId":"mac","name":"MacBook","platform":"macos"}"#

/// An active preview from moes-tavern that offers both machines and places on `target`.
private func activePreview(target: String = linuxJSON, requirements: String = "[]", basis: String = "preference",
                           derive: Bool = false, wait: String? = nil) throws -> PlacementPreview {
    try wire(#"""
        {"active":true,"deriveRequirements":\#(derive),"machines":[\#(linuxJSON),\#(macJSON)],
         "placement":{"mode":"auto","target":\#(target),"requirements":\#(requirements),"basis":"\#(basis)",
          "preferred":"linux","by":{"instanceId":"linux","name":"moes-tavern"},"decidedAt":1}
         \#(wait.map { #","wait":\#($0)"# } ?? "")}
        """#)
}

extension CoreSeamTests {
@MainActor @Suite struct RunOnModelTests {
    private func composer(_ fake: FakeReads) -> ComposeModel {
        let runOn = RunOnModel(reads: .init(
            preview: { request in try await MainActor.run { fake.previews.append(request); return try fake.preview(request) } },
            derive: { request in try await MainActor.run { fake.derives.append(request); return try fake.derive(request) } }))
        runOn.previewDelay = .zero
        runOn.deriveDelay = .zero
        let model = ComposeModel(defaults: UserDefaults(suiteName: "RunOnModelTests.\(UUID())")!,
            repoBranches: RepoBranchModel(loadBranches: { _ in .init(branches: ["main"]) },
                loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false, hasUpstream: true, localExists: true) },
                repair: { _, branch in .init(branch: branch) }),
            loadIssues: { _ in .init(issues: []) }, loadCommands: { _, _ in .init(commands: []) },
            loadEpics: { _ in .init(epics: [], subIssues: []) }, runOn: runOn)
        model.repoPath = "/repo"
        return model
    }

    private func body(_ request: CreateSessionRequest?) throws -> [String: Any] {
        let data = try JSONEncoder().encode(try #require(request))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func automaticSendsNoMachineAndOnlyAnOfferedPickIsNamed() async throws {
        let fake = FakeReads()
        fake.preview = { _ in try activePreview() }
        let model = composer(fake)
        defer { model.teardown() }
        model.prompt = "Restyle the settings page"
        await model.refreshPlacement()
        #expect(model.runOn.active)
        #expect(model.runOn.machines.map(\.instanceId) == ["linux", "mac"])
        #expect(fake.previews.last?.target == nil)

        let automatic = try body(model.createRequest(baseBranch: "main"))
        #expect(automatic["target"] == nil, "Automatic leaves the machine to the server")
        #expect(automatic["requirements"] == nil)
        #expect(model.runOn.remoteTarget == nil, "placed on the server it is submitted to")

        model.runOn.pick = "mac"
        await model.refreshPlacement()
        #expect(fake.previews.last?.target?.instanceId == "mac")
        let named = try body(model.createRequest(baseBranch: "main"))
        #expect((named["target"] as? [String: Any])?["instanceId"] as? String == "mac")
        #expect(model.runOn.remoteTarget?.name == "MacBook")

        // A machine this repo cannot run on is no pick at all.
        model.runOn.pick = "box"
        #expect(model.runOn.pickedID == nil)
        #expect(try body(model.createRequest(baseBranch: "main"))["target"] == nil)
    }

    @Test func requirementsAreReadFromTheTaskAndTheQuestionBlocksTheStart() async throws {
        let fake = FakeReads()
        fake.preview = { _ in try activePreview(derive: true) }
        fake.derive = { request in
            if request.prompt.contains("Xcode") { return try wire(#"{"status":"derived","requirements":["xcode"]}"#) }
            if request.prompt.contains("app") { return try wire(#"{"status":"unclear","options":[["xcode"],[]]}"#) }
            throw ShepherdError.transport("down")
        }
        let model = composer(fake)
        defer { model.teardown() }
        model.prompt = "Fix the Xcode build"
        await model.refreshPlacement()
        #expect(model.readiness().blocker == "requirements_pending", "nothing starts before the answer")
        await model.deriveRequirements()
        #expect(fake.derives.last?.prompt == "Fix the Xcode build")
        #expect(model.runOn.requirements == ["xcode"])
        #expect(model.readiness().canSubmit)
        let derived = try body(model.createRequest(baseBranch: "main"))
        #expect(derived["requirements"] as? [String] == ["xcode"])
        #expect(derived["target"] == nil)

        model.prompt = "Fix the app"
        #expect(model.readiness().blocker == "requirements_pending")
        await model.deriveRequirements()
        #expect(model.runOn.requirements.isEmpty, "a chip read from an older text never stays")
        #expect(model.derivation?.options?.count == 2)
        #expect(model.readiness().blocker == "requirements_unclear")
        model.runOn.setRequirements([])
        #expect(model.runOn.requirementsTouched)
        #expect(model.readiness().canSubmit, "answering the question unblocks the start")
        model.prompt = "Fix the Xcode app"
        await model.deriveRequirements()
        #expect(model.runOn.requirements.isEmpty, "the operator's chips are never overwritten")

        let failing = composer(fake)
        defer { failing.teardown() }
        failing.prompt = "Something else"
        await failing.refreshPlacement()
        await failing.deriveRequirements()
        #expect(failing.derivation?.status.rawValue == "failed")
        #expect(failing.runOn.requirements.isEmpty, "nothing is guessed")
        #expect(failing.readiness().canSubmit)
    }

    @Test func theReadStartsWhenThePreviewSaysItMattersAfterTheLastEdit() async throws {
        let fake = FakeReads()
        fake.preview = { _ in try activePreview(derive: true) }
        fake.derive = { _ in try wire(#"{"status":"derived","requirements":["xcode"]}"#) }
        let model = composer(fake)
        defer { model.teardown() }
        model.prompt = "Fix the Xcode build"
        let typed = model.deriveKey
        await model.deriveRequirements()
        #expect(fake.derives.isEmpty, "nothing to read before the preview answers")
        await model.refreshPlacement()
        #expect(model.deriveKey != typed, "the view's read runs again once it applies")
        await model.deriveRequirements()
        #expect(model.runOn.requirements == ["xcode"])
    }

    @Test func aPickOrChipsSkipTheReading() async throws {
        let fake = FakeReads()
        fake.preview = { request in try activePreview(derive: request.target == nil) }
        let model = composer(fake)
        defer { model.teardown() }
        model.prompt = "Fix the Xcode build"
        model.runOn.pick = "mac"
        await model.refreshPlacement()
        await model.refreshPlacement()
        #expect(model.runOn.pickedID == "mac")
        #expect(!model.runOn.deriveApplies)
        #expect(model.readiness().canSubmit)
        await model.deriveRequirements()
        #expect(fake.derives.isEmpty)
    }

    @Test func withoutTheChoiceTheComposerIsAsItWas() async throws {
        let fake = FakeReads()
        let model = composer(fake)
        defer { model.teardown() }
        model.prompt = "Fix"
        await model.refreshPlacement()
        #expect(!model.runOn.active)
        #expect(model.runOn.machines.isEmpty)
        #expect(model.readiness().canSubmit)
        model.runOn.pick = "mac"
        #expect(try body(model.createRequest(baseBranch: "main"))["target"] == nil)
        let request = try #require(model.createRequest(baseBranch: "main"))
        #expect(model.runOn.send(for: request) == nil, "no key without the choice")

        // A server that predates the choice answers 404: inactive, not a failure.
        fake.preview = { _ in throw ShepherdError.notFound }
        model.repoPath = "/other"
        await model.refreshPlacement()
        #expect(!model.runOn.available)
        #expect(!model.runOn.previewFailed)
        #expect(model.readiness().canSubmit)
    }

    @Test func theFirstPreviewForARepoHoldsTheStartUntilItAnswers() async throws {
        let fake = FakeReads()
        fake.preview = { _ in try activePreview() }
        let model = composer(fake)
        defer { model.teardown() }
        model.prompt = "Fix"
        model.runOn.previewDelay = .seconds(60)
        let asking = Task { await model.refreshPlacement() }
        for _ in 0..<100 where !model.requirementsPending { await Task.yield() }
        #expect(model.readiness().blocker == "requirements_pending")
        asking.cancel()
        await asking.value
        model.runOn.previewDelay = .zero
        await model.refreshPlacement()
        #expect(model.readiness().canSubmit)
    }

    @Test func anUnansweredSendKeepsItsKeyAndAnythingElseGetsANewOne() async throws {
        let fake = FakeReads()
        fake.preview = { _ in try activePreview(target: macJSON, requirements: #"["xcode"]"#, basis: "requirements") }
        let model = composer(fake)
        defer { model.teardown() }
        model.prompt = "Fix the iOS build"
        await model.refreshPlacement()
        let submission = ComposeSubmission()
        defer { submission.teardown() }
        var keys: [String?] = []
        func attempt(_ error: (any Error)?) async {
            _ = await submission.submit(model: model, repoResolved: true, holdLikely: false, send: { _, call in
                keys.append(call.idempotencyKey)
                if let error { throw error }
                return .created(PreviewData.session(id: "s"))
            }, isCurrent: { true })
        }
        await attempt(ShepherdError.upstreamFailure(code: "remote_dispatch_unknown", message: "no answer"))
        #expect(submission.message == L.t("newtask_runon_unknown", "MacBook"))
        await attempt(ShepherdError.transport("reset"))
        #expect(keys[0] != nil)
        #expect(keys[1] == keys[0], "a retry of the unanswered task is the same dispatch")
        model.prompt = "Fix the iOS build, please"
        await attempt(MachineRefusal(code: "no_suitable_machine", missing: [.init(capability: "xcode")]))
        #expect(keys[2] != keys[1], "a changed task is a new submission")
        #expect(submission.message == PlacementCopy.refusal(.init(code: "no_suitable_machine", missing: [.init(capability: "xcode")])))
        await attempt(nil)
        #expect(keys[3] != keys[2], "a refusal is final for its key")
    }

    @Test func aHoldSaysWhereTheTaskWaitsAndAMachineHoldsNoUsageHoldHere() async throws {
        let fake = FakeReads()
        fake.preview = { _ in try activePreview(target: macJSON, basis: "requirements",
                                                 wait: #"{"status":"timeout","alternatives":[]}"#) }
        let model = composer(fake)
        defer { model.teardown() }
        model.prompt = "Fix the iOS build"
        await model.refreshPlacement()
        #expect(model.runOn.remoteTarget?.name == "MacBook")
        #expect(!model.readiness(holdLikely: true).dualCTA, "the usage hold is this server's")
        let submission = ComposeSubmission()
        defer { submission.teardown() }
        let waiting: HeldTask = try wire(#"{"held":true,"id":"d1","count":1,"waiting":true,"host":\#(macJSON)}"#)
        _ = await submission.submit(model: model, repoResolved: true, holdLikely: false,
                                    send: { _, _ in .held(waiting) }, isCurrent: { true })
        #expect(submission.message == L.t("toast_task_waiting_for", "MacBook"))

        let local = composer(FakeReads())
        defer { local.teardown() }
        local.prompt = "Fix"
        #expect(local.readiness(holdLikely: true).dualCTA)
    }
}

@MainActor @Suite struct PlacementCopyTests {
    private func placement(basis: String, requirements: String = "[]", mode: String = "auto",
                           preferred: String = "null") throws -> MachinePlacement {
        try wire(#"""
            {"mode":"\#(mode)","target":\#(macJSON),"requirements":\#(requirements),"basis":"\#(basis)",
             "preferred":\#(preferred),"by":{"instanceId":"linux","name":"moes-tavern"},"decidedAt":1}
            """#)
    }

    @Test func theReasonFollowsWhatDecided() throws {
        let xcode = PlacementCopy.capabilityList(["xcode"])
        #expect(try PlacementCopy.reason(placement(basis: "requirements", requirements: #"["xcode"]"#))
            == L.t("placement_basis_requirements", xcode))
        #expect(try PlacementCopy.reason(placement(basis: "preference", preferred: #""linux""#))
            == L.t("placement_basis_preference_none", L.t("settings_machines_platform_linux")))
        #expect(try PlacementCopy.reason(placement(basis: "preference", requirements: #"["xcode"]"#, preferred: #""macos""#))
            == L.t("placement_basis_preference", xcode, L.t("settings_machines_platform_macos")))
        #expect(try PlacementCopy.reason(placement(basis: "manual", mode: "manual")) == L.t("placement_basis_manual"))
        #expect(try PlacementCopy.reason(placement(basis: "only_candidate")) == L.t("placement_basis_only"))
        let manual = try PlacementCopy.explanation(placement(basis: "manual", mode: "manual"))
        #expect(manual.title == L.t("tooltip_placement_title", "MacBook"))
        #expect(manual.sections.map(\.text) == [L.t("tooltip_placement_needs_none"), L.t("tooltip_placement_how_manual"), "moes-tavern"])
    }

    @Test func aWaitNamesTheMachinesThatFitNow() throws {
        let p = try placement(basis: "requirements", requirements: #"["xcode"]"#)
        let wait: PlacementWait = try wire(#"{"status":"timeout","alternatives":[\#(linuxJSON)]}"#)
        #expect(PlacementCopy.waits(p, wait) == L.t("placement_waits_for", "MacBook", PlacementCopy.reason(p))
            + " " + L.t("placement_refusal_alternatives", "moes-tavern"))
        let explained = PlacementCopy.waitExplanation(p, wait)
        #expect(explained.sections.first?.text == L.t("settings_machines_status_unreachable"))
        #expect(explained.sections.last?.text == L.t("tooltip_waiting_fallback_body", "moes-tavern"))
    }

    @Test func refusalsSayWhatIsMissingOrOutOfReach() throws {
        let mac: SessionHost = try wire(macJSON)
        let none = MachineRefusal(code: "no_suitable_machine", together: true, elsewhere: [mac],
                                  missing: [.init(capability: "xcode"), .init(capability: "sdk:ios")])
        #expect(PlacementCopy.refusal(none) == L.t("placement_refusal_none_together", PlacementCopy.capabilityList(["xcode", "sdk:ios"]))
            + " " + L.t("placement_refusal_elsewhere", "MacBook"))
        #expect(PlacementCopy.refusal(.init(code: "no_suitable_machine")) == L.t("placement_refusal_none_any"))
        let missing = MachineRefusal(code: "missing_capabilities", host: mac,
                                     missing: [.init(capability: "xcode", reason: "license_not_accepted")])
        let lacks = "\(L.t("settings_machines_cap_xcode")) (\(L.t("settings_machines_cap_reason_license_not_accepted")))"
        #expect(PlacementCopy.refusal(missing) == L.t("placement_refusal_missing", "MacBook", lacks))
        #expect(PlacementCopy.failure(missing, machine: nil) == L.t("placement_refusal_missing", "MacBook", lacks))
        #expect(PlacementCopy.failure(MachineRefusal(code: "remote_rejected", error: "busy", host: mac), machine: nil)
            == L.t("newtask_runon_rejected", "MacBook", "busy"))
        #expect(PlacementCopy.failure(ShepherdError.conflict(code: "remote_target_unavailable", message: "x"), machine: "MacBook")
            == L.t("newtask_runon_unavailable", "MacBook"))
        #expect(PlacementCopy.failure(ShepherdError.upstreamFailure(code: "remote_upload_failed", message: "photo"), machine: "MacBook")
            == L.t("newtask_runon_upload_failed", "MacBook", "photo"))
        #expect(PlacementCopy.failure(ShepherdError.transport("reset"), machine: nil) == nil, "here: the generic message")
        #expect(PlacementCopy.failure(ShepherdError.badRequest("bad"), machine: "MacBook") == nil)
    }

    @Test func labelsReadUnknownIDsAsThemselvesAndGlossaryMarkersAsTheirLabel() {
        #expect(PlacementCopy.capabilityLabel("xcode") == L.t("settings_machines_cap_xcode"))
        #expect(PlacementCopy.capabilityLabel("quantum") == "quantum")
        #expect(PlacementCopy.reasonLabel("not_verified") == L.t("settings_machines_cap_reason_not_verified"))
        #expect(PlacementCopy.offlineLabel("unauthorized") == L.t("settings_machines_status_unauthorized"))
        #expect(PlacementCopy.offlineLabel("timeout") == L.t("settings_machines_status_unreachable"))
        #expect(PlacementCopy.plain("[[requirement|Requirements]]:") == "Requirements:")
        #expect(PlacementCopy.requirementOptions.count == 12)
        #expect(!PlacementCopy.requirementOptions.contains("platform:windows"))
    }
}
}
