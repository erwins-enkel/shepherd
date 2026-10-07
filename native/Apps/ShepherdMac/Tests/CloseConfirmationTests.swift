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
        delegate.confirmClose = { false }
        #expect(!delegate.windowShouldClose(NSWindow()))
        #expect(original.calls == 0)
    }

    @Test func confirmationPreservesOriginalCloseDecisionAndCallbacks() {
        let original = OriginalDelegate()
        let delegate = CloseConfirmationWindowDelegate()
        delegate.original = original
        delegate.confirmClose = { true }
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
