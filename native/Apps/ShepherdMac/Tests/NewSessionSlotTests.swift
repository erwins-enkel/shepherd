import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd

@MainActor
@Suite(.serialized)
struct NewSessionSlotTests {
    init() { resetStreamSeams() }

    private func base() -> CreateSessionRequest {
        CreateSessionRequest(repoPath: "/r", baseBranch: "main", prompt: "p")
    }

    @Test func anUntouchedExtrasBlockChangesNothing() {
        let extras = NewSessionExtras()
        var request = base()
        extras.apply(to: &request)
        // Every field stays nil/absent: an operator who never opens the extras section must send
        // byte-for-byte what Gate 2 sent, so the server's own defaults still apply.
        #expect(request.planGateEnabled == nil)
        #expect(request.autopilotEnabled == nil)
        #expect(request.sandboxProfile == nil)
        #expect(request.plain == nil)
        #expect(request.force == nil)
        #expect(request.images == nil)
    }

    @Test func setValuesReachTheRequest() {
        let extras = NewSessionExtras()
        extras.planGateEnabled = true
        extras.autopilotEnabled = false
        extras.sandboxProfile = .standard
        extras.plain = true
        extras.force = true
        extras.images = ["a.png"]
        var request = base()
        extras.apply(to: &request)
        #expect(request.planGateEnabled == true)
        #expect(request.autopilotEnabled == false)
        #expect(request.sandboxProfile == .standard)
        #expect(request.plain == true)
        #expect(request.force == true)
        #expect(request.images == ["a.png"])
    }

    @Test func anEmptyImageListIsNotSent() {
        let extras = NewSessionExtras()
        extras.images = []
        var request = base()
        extras.apply(to: &request)
        // `[]` and "absent" mean the same thing to the server, and sending `[]` would make an
        // attachmentNames length check trivially pass for the wrong reason (src/validate.ts:287).
        #expect(request.images == nil)
    }

    @Test func applyNeverOverwritesAFieldTheSheetAlreadySet() {
        let extras = NewSessionExtras()
        var request = base()
        request.planGateEnabled = false
        extras.apply(to: &request)
        // extras.planGateEnabled is still nil, so the sheet's own value survives. A blind
        // assignment here would silently undo whatever a replacement composer had decided.
        #expect(request.planGateEnabled == false)
    }

    @Test func resolutionFollowsTheContentSlot() {
        NewSessionSlot.reset()
        #expect(NewSessionSlot.resolution == .fallback)
        NewSessionSlot.content = { _ in AnyView(EmptyView()) }
        #expect(NewSessionSlot.resolution == .slot)
        NewSessionSlot.reset()
        #expect(NewSessionSlot.resolution == .fallback)
    }

    @Test func sharedResetClearsContentAndOptions() {
        defer { NewSessionSlot.reset() }
        NewSessionSlot.content = { _ in AnyView(EmptyView()) }
        NewSessionSlot.options = { _ in AnyView(EmptyView()) }

        resetStreamSeams()

        #expect(NewSessionSlot.content == nil)
        #expect(NewSessionSlot.options == nil)
        #expect(NewSessionSlot.resolution == .fallback)
    }

    private func scratchModel() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
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
