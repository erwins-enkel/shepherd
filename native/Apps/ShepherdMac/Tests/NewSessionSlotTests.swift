import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd

@MainActor
struct NewSessionSlotTests {
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
}
