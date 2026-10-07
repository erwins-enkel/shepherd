import AppKit
import ShepherdAppCore
import SwiftUI

@MainActor
enum CloseConfirmation {
    static func confirm(quitting: Bool) -> Bool {
        let alert = NSAlert()
        alert.messageText = L.t(quitting ? "native_quit_confirm_title" : "native_close_confirm_title")
        alert.informativeText = L.t("native_close_confirm_body")
        alert.addButton(withTitle: L.t("common_cancel"))
        alert.addButton(withTitle: L.t(quitting ? "native_quit_confirm_action" : "common_close"))
        alert.buttons[0].keyEquivalent = "\u{1b}"
        alert.buttons[1].keyEquivalent = "\r"
        return alert.runModal() == .alertSecondButtonReturn
    }
}

/// Intercept close requests while forwarding SwiftUI's other window delegate callbacks.
struct CloseConfirmationHost: NSViewRepresentable {
    func makeNSView(context: Context) -> CloseConfirmationView { CloseConfirmationView() }
    func updateNSView(_ nsView: CloseConfirmationView, context: Context) {}
}

final class CloseConfirmationView: NSView {
    private let closeDelegate = CloseConfirmationWindowDelegate()

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window, window.delegate !== closeDelegate else { return }
        closeDelegate.original = window.delegate
        window.delegate = closeDelegate
    }
}

@MainActor
final class CloseConfirmationWindowDelegate: NSObject, NSWindowDelegate {
    weak var original: (any NSWindowDelegate)?
    var confirmClose: () -> Bool = { CloseConfirmation.confirm(quitting: false) }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard confirmClose() else { return false }
        return original?.windowShouldClose?(sender) ?? true
    }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (original?.responds(to: selector) ?? false)
    }

    override func forwardingTarget(for selector: Selector!) -> Any? {
        if original?.responds(to: selector) == true { return original }
        return super.forwardingTarget(for: selector)
    }
}
