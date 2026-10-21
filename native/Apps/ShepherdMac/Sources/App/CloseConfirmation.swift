import AppKit
import ShepherdAppCore
import SwiftUI

@MainActor
enum CloseConfirmation {
    enum Choice { case cancel, keepBackend, stopBackend }

    static func makeAlert(quitting: Bool, canStop: Bool) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = L.t(quitting ? "native_quit_confirm_title" : "native_close_confirm_title")
        alert.informativeText = L.t(canStop ? "native_close_backend_choices" : "native_close_confirm_body")
        alert.addButton(withTitle: L.t(canStop ? "native_close_keep_backend" :
            (quitting ? "native_quit_confirm_action" : "common_close")))
        alert.addButton(withTitle: L.t("common_cancel"))
        if canStop {
            alert.addButton(withTitle: L.t("native_close_stop_backend"))
            alert.buttons[2].hasDestructiveAction = true
        }
        alert.buttons[0].keyEquivalent = "\r"
        alert.buttons[1].keyEquivalent = "\u{1b}"
        return alert
    }

    static func confirm(quitting: Bool) -> Choice {
        let canStop = LocalServerModel.shared.canStop
        switch makeAlert(quitting: quitting, canStop: canStop).runModal() {
        case .alertFirstButtonReturn: return .keepBackend
        case .alertThirdButtonReturn where canStop: return .stopBackend
        default: return .cancel
        }
    }

    static func stopBackend() async -> Bool {
        let local = LocalServerModel.shared
        // A lifecycle operation may have started while the modal dialog was open.
        guard local.canStop else { return false }
        await local.stop()
        return local.state == .stopped
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
    var confirmClose: () -> CloseConfirmation.Choice = { CloseConfirmation.confirm(quitting: false) }
    var stopBackend: () async -> Bool = { await CloseConfirmation.stopBackend() }
    var completeClose: (NSWindow) -> Void = { $0.performClose(nil) }
    private(set) var closeTask: Task<Void, Never>?
    private var backendStopped = false

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard closeTask == nil else { return false }
        if backendStopped {
            backendStopped = false
            return original?.windowShouldClose?(sender) ?? true
        }
        switch confirmClose() {
        case .cancel: return false
        case .keepBackend: return original?.windowShouldClose?(sender) ?? true
        case .stopBackend:
            closeTask = Task {
                let stopped = await stopBackend()
                closeTask = nil
                guard stopped else { return }
                backendStopped = true
                completeClose(sender)
            }
            return false
        }
    }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (original?.responds(to: selector) ?? false)
    }

    override func forwardingTarget(for selector: Selector!) -> Any? {
        if original?.responds(to: selector) == true { return original }
        return super.forwardingTarget(for: selector)
    }
}
