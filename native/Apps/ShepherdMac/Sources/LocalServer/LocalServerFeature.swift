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
        SettingsPaneRegistry.register(LocalServerSettingsPane())
        guard !installed else { return }
        installed = true
        // The child server lives exactly as long as the app (design spec: "keep
        // running after quit" is out of scope). The observer lives in this
        // stream's own file so no shared lifecycle file is touched.
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                // The installer first: cancelling it signals `install.sh` and
                // its subtree synchronously, and an install in flight is the
                // one thing `terminateForQuit()` cannot reach.
                LocalServerModel.shared.cancelInstallForQuit()
                LocalServerModel.shared.cancelBunUpgradeForQuit()
                LocalServerModel.shared.cancelUpdateForQuit()
                LocalServerModel.shared.terminateForQuit()
            }
        }
        Log.app.info("local server feature installed")
    }
}

/// Available before and after connecting; local maintenance needs no server login.
struct LocalServerSettingsPane: SettingsPane {
    let id = "local-server"
    var title: String { L.t("native_settings_local_server_title") }
    let systemImage = "server.rack"
    let order = 80
    @MainActor func makeView(app: AppModel) -> AnyView {
        AnyView(ScrollView {
            LocalServerPanel(model: .shared, app: app)
                .padding(24).frame(maxWidth: .infinity, alignment: .leading)
        }.frame(minWidth: 640))
    }
}
