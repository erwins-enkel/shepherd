import AppKit
import SwiftUI

/// The stream's single entry point. The integration lane calls this once from
/// `ShepherdApp.init()` — see "Integration handoff"; this stream never edits
/// `ShepherdApp.swift` itself. Idempotent: a second call replaces the slot
/// closure and does not add a second termination observer.
@MainActor
enum LocalServerFeature {
    private static var installed = false

    static func install() {
        WelcomeSlots.localPanel = { app in
            AnyView(LocalServerPanel(model: LocalServerModel.shared, app: app))
        }
        guard !installed else { return }
        installed = true
        // The child server lives exactly as long as the app (design spec: "keep
        // running after quit" is out of scope). The observer lives in this
        // stream's own file so no shared lifecycle file is touched.
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { LocalServerModel.shared.terminateForQuit() }
        }
        Log.app.info("local server feature installed")
    }
}
