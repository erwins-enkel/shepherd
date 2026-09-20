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

    // MARK: - M-2 (task-7-fix-brief.md): buttons stay put while busy

    /// `install()` sets `state` to `.installing` itself, synchronously, before
    /// its awaited work even starts — so Install must stay on screen
    /// (disabled) for that whole stretch rather than vanish because `busy` is
    /// true.
    @Test func installStaysVisibleButDisabledWhileInstalling() {
        let state = LocalServerPanelState(state: .installing, busy: true)
        #expect(state.showsInstall)
        #expect(state.canInstall == false)
    }

    /// `act()` (the shared path behind start/stop/restart) does not update
    /// `state` until the action finishes, so a `start()` in flight is still
    /// `.stopped` the whole time it is `busy` — Start must stay visible,
    /// merely disabled, instead of the row going empty mid-click.
    @Test func startStaysVisibleButDisabledWhileBusy() {
        let state = LocalServerPanelState(state: .stopped, busy: true)
        #expect(state.showsStart)
        #expect(state.canStart == false)
    }

    /// Same shape for a running server mid `stop()`/`restart()`: `state` is
    /// still `.running` throughout, so Stop and Restart stay on screen.
    @Test func stopAndRestartStayVisibleButDisabledWhileBusy() {
        let state = LocalServerPanelState(state: .running(pid: 1), busy: true)
        #expect(state.showsStop)
        #expect(state.showsRestart)
        #expect(state.canStop == false)
        #expect(state.canRestart == false)
    }

    /// Not busy: visibility and enablement agree, matching every pre-existing
    /// `canX` assertion above.
    @Test func visibilityAndEnablementAgreeWhenIdle() {
        let running = LocalServerPanelState(state: .running(pid: 1), busy: false)
        #expect(running.showsStop == running.canStop)
        #expect(running.showsRestart == running.canRestart)
        let stopped = LocalServerPanelState(state: .stopped, busy: false)
        #expect(stopped.showsStart == stopped.canStart)
    }
}
