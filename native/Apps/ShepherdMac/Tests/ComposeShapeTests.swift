import Foundation
import ShepherdKit
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
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

    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(condition())
    }
}
