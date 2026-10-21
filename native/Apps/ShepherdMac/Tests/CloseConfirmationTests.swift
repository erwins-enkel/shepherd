import AppKit
import Testing

@testable import Shepherd

extension MacSeamTests {
@MainActor
struct CloseConfirmationTests {
    private final class OriginalDelegate: NSObject, NSWindowDelegate {
        var calls = 0
        var allowsClose = true
        func windowShouldClose(_ sender: NSWindow) -> Bool {
            calls += 1
            return allowsClose
        }
        func windowWillClose(_ notification: Notification) {}
    }

    @Test func hostInstallsCloseInterceptorOnItsWindow() {
        let window = NSWindow()
        let original = OriginalDelegate()
        window.delegate = original
        window.contentView = CloseConfirmationView()
        let delegate = window.delegate as? CloseConfirmationWindowDelegate
        #expect(delegate != nil)
        #expect(delegate?.original === original)
    }

    @Test func cancellationKeepsWindowOpenWithoutCallingOriginal() {
        let original = OriginalDelegate()
        let delegate = CloseConfirmationWindowDelegate()
        delegate.original = original
        delegate.confirmClose = { .cancel }
        #expect(!delegate.windowShouldClose(NSWindow()))
        #expect(original.calls == 0)
    }

    @Test func stopFinishesBeforeClosingAndDoesNotAskAgain() async {
        let original = OriginalDelegate()
        let delegate = CloseConfirmationWindowDelegate()
        delegate.original = original
        var confirmations = 0
        var stopFinished = false
        var closed = false
        delegate.confirmClose = { confirmations += 1; return .stopBackend }
        delegate.stopBackend = { stopFinished = true; return true }
        delegate.completeClose = { window in
            #expect(stopFinished)
            closed = delegate.windowShouldClose(window)
        }
        #expect(!delegate.windowShouldClose(NSWindow()))
        #expect(!closed)
        #expect(original.calls == 0)
        #expect(!delegate.windowShouldClose(NSWindow()))
        #expect(confirmations == 1)
        await delegate.closeTask?.value
        #expect(closed)
        #expect(confirmations == 1)
        #expect(original.calls == 1)
    }

    @Test func unsuccessfulStopKeepsWindowOpen() async {
        let delegate = CloseConfirmationWindowDelegate()
        delegate.confirmClose = { .stopBackend }
        delegate.stopBackend = { false }
        var closed = false
        delegate.completeClose = { _ in closed = true }
        #expect(!delegate.windowShouldClose(NSWindow()))
        await delegate.closeTask?.value
        #expect(!closed)
        #expect(delegate.closeTask == nil)
    }

    @Test func backendChoiceIsOnlyOfferedWhenStoppingIsAvailable() {
        for quitting in [false, true] {
            let managed = CloseConfirmation.makeAlert(quitting: quitting, canStop: true)
            #expect(managed.buttons.count == 3)
            #expect(managed.buttons[2].hasDestructiveAction)
            #expect(managed.buttons[0].keyEquivalent == "\r")
            #expect(managed.buttons[1].keyEquivalent == "\u{1b}")
            let unmanaged = CloseConfirmation.makeAlert(quitting: quitting, canStop: false)
            #expect(unmanaged.buttons.count == 2)
        }
    }

    @Test func confirmationPreservesOriginalCloseDecisionAndCallbacks() {
        let original = OriginalDelegate()
        let delegate = CloseConfirmationWindowDelegate()
        delegate.original = original
        delegate.confirmClose = { .keepBackend }
        let window = NSWindow()
        #expect(delegate.windowShouldClose(window))
        original.allowsClose = false
        #expect(!delegate.windowShouldClose(window))
        #expect(original.calls == 2)
        let selector = #selector(NSWindowDelegate.windowWillClose(_:))
        #expect(delegate.responds(to: selector))
        #expect(delegate.forwardingTarget(for: selector) as? OriginalDelegate === original)
    }
}
}
