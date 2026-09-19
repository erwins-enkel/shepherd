import Testing
import ShepherdKit
@testable import Shepherd

/// The panel's enablement logic, pulled out of the view so it is testable without
/// hosting SwiftUI — same pattern as LoginSheetState.
@Suite @MainActor struct LocalServerPanelStateTests {
    @Test func aMissingCheckoutOffersOnlyInstall() {
        let state = LocalServerPanelState(state: .notInstalled, busy: false)
        #expect(state.canInstall)
        #expect(state.canStart == false)
        #expect(state.canConnect == false)
    }

    @Test func anInstalledStoppedServerOffersStart() {
        let state = LocalServerPanelState(state: .stopped, busy: false)
        #expect(state.canStart)
        #expect(state.canInstall == false)
        #expect(state.canStop == false)
    }

    @Test func aRunningServerOffersStopRestartAndConnect() {
        let state = LocalServerPanelState(state: .running(pid: 1234), busy: false)
        #expect(state.canStop)
        #expect(state.canRestart)
        #expect(state.canConnect)
        #expect(state.canStart == false)
    }

    /// A server the operator started themselves is connectable but must not be
    /// stoppable or restartable from here.
    @Test func anExternalServerIsConnectableOnly() {
        let state = LocalServerPanelState(state: .externallyManaged, busy: false)
        #expect(state.canConnect)
        #expect(state.canStop == false)
        #expect(state.canRestart == false)
        #expect(state.canStart == false)
    }

    @Test func aFailedServerOffersStartAndInstallAgain() {
        let state = LocalServerPanelState(state: .failed(.crashLoop(restarts: 3)), busy: false)
        #expect(state.canStart)
        #expect(state.canInstall)
        #expect(state.canConnect == false)
    }

    /// Nothing is clickable mid-action: a second Install, or a Start racing a
    /// Stop, would leave two children behind.
    @Test func busyDisablesEverything() {
        let state = LocalServerPanelState(state: .running(pid: 1), busy: true)
        #expect(state.canStop == false)
        #expect(state.canRestart == false)
        #expect(state.canConnect == false)
        #expect(state.isBusyState)
    }

    @Test func theStatusLineIsAlwaysTheStatesSentence() {
        #expect(LocalServerPanelState(state: .stopped, busy: false).statusText
                == LocalServerCopy.label(for: .stopped))
    }
}
