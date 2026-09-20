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
