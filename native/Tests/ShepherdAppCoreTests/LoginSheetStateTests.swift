import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
/// LoginSheetState.canDismiss is the login sheet's Cancel-button and
/// interactive-dismissal gate: both must stay blocked while a sign-in request
/// is in flight, or the untracked Task in LoginSheet.submit() can outlive the
/// sheet that started it (see the doc comment on LoginSheetState).
struct LoginSheetStateTests {
    @Test func notDismissableWhileBusy() {
        var state = LoginSheetState()
        #expect(state.canDismiss)

        state.busy = true
        #expect(!state.canDismiss)

        state.busy = false
        #expect(state.canDismiss)
    }

    @Test func busyAndDismissalAreIndependentOfError() {
        var state = LoginSheetState()
        state.error = "wrong password"
        #expect(state.canDismiss)

        state.busy = true
        #expect(!state.canDismiss)
    }
}
}
