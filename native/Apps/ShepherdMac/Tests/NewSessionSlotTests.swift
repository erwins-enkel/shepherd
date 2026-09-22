import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
@MainActor
@Suite(.serialized)
struct NewSessionSlotTests {
    init() { resetStreamSeams() }

    private func base() -> CreateSessionRequest {
        CreateSessionRequest(repoPath: "/r", baseBranch: "main", prompt: "p")
    }

    private func scratchModel() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
    }

    @Test func sheetInvokesReplacementWithItsAppAndSkipsOptions() {
        defer { NewSessionSlot.reset() }
        let app = scratchModel()
        var receivedApp: AppModel?
        var optionsCalled = false
        NewSessionSlot.content = {
            receivedApp = $0
            return AnyView(EmptyView())
        }
        NewSessionSlot.options = { _ in
            optionsCalled = true
            return AnyView(EmptyView())
        }

        let body = NewSessionSheet.resolveBody(app: app, extras: NewSessionExtras())

        guard case .slot = body else {
            Issue.record("the sheet must choose the replacement body")
            return
        }
        #expect(receivedApp === app)
        #expect(!optionsCalled)
    }

    @Test func sheetInvokesOptionsWithTheExtrasMergedIntoCreate() {
        defer { NewSessionSlot.reset() }
        let extras = NewSessionExtras()
        var receivedExtras: NewSessionExtras?
        NewSessionSlot.options = {
            receivedExtras = $0
            $0.planGateEnabled = true
            $0.autopilotEnabled = false
            $0.sandboxProfile = .standard
            $0.plain = true
            $0.force = true
            $0.images = ["a.png"]
            return AnyView(EmptyView())
        }

        let body = NewSessionSheet.resolveBody(app: scratchModel(), extras: extras)

        guard case .fallback(let options) = body else {
            Issue.record("options must extend the built-in body")
            return
        }
        #expect(options != nil)
        #expect(receivedExtras === extras)
        let request = NewSessionSheet.createRequest(base(), extras: extras)
        #expect(request.repoPath == "/r")
        #expect(request.prompt == "p")
        #expect(request.planGateEnabled == true)
        #expect(request.autopilotEnabled == false)
        #expect(request.sandboxProfile == .standard)
        #expect(request.plain == true)
        #expect(request.force == true)
        #expect(request.images == ["a.png"])
    }

    @Test func sheetFallsBackWithoutRegisteredHooks() {
        let body = NewSessionSheet.resolveBody(app: scratchModel(), extras: NewSessionExtras())
        guard case .fallback(let options) = body else {
            Issue.record("an empty slot must choose the built-in body")
            return
        }
        #expect(options == nil)
    }
}
}
