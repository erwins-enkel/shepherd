import ShepherdAppCore
import AppKit
import SwiftUI

/// The stream's single entry point. The integration lane calls this once from
/// `StreamRegistrations.installAll(into:)` — see "Integration handoff"; this
/// stream never edits `ShepherdApp.swift` or `StreamRegistrations.swift` itself.
/// Idempotent: a second call replaces the slot closure, re-registers the
/// extension (itself idempotent, keyed by type) and does not add a second
/// termination observer.
@MainActor
enum LocalServerFeature {
    private static var installed = false

    static func install(_ app: AppModel) {
        WelcomeSlots.localPanel = { app in
            AnyView(LocalServerPanel(model: LocalServerModel.shared, app: app))
        }
        // Gives a live local session its own per-store lifecycle hook (see
        // LocalServerSessionExtension). `register` is idempotent per type and
        // also builds an instance immediately if a store is already active,
        // exactly like `StreamRegistrations` expects.
        app.register(LocalServerSessionExtension.self)
        guard !installed else { return }
        installed = true
        // Resume supervision even when saved profiles bypass the Welcome panel.
        Task { await LocalServerModel.shared.refresh() }
        // The server survives quit and is adopted on the next launch. Only
        // Stop/Restart signal it; quit cancels supervision and install/upgrade
        // work without interrupting sessions.
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                // The installer first: cancelling it signals `install.sh` and
                // its subtree synchronously, and an install in flight is the
                // one thing `terminateForQuit()` cannot reach.
                LocalServerModel.shared.cancelInstallForQuit()
                LocalServerModel.shared.cancelBunUpgradeForQuit()
                LocalServerModel.shared.terminateForQuit()
            }
        }
        Log.app.info("local server feature installed")
    }
}
