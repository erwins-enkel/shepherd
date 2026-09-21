import Combine
import Sparkle
import SwiftUI

/// One updater for the running app bundle, independent of the connected server.
/// Development bundles without a release key and isolated test launches never start it.
@MainActor
final class AppUpdater: ObservableObject {
    @Published private(set) var canCheckForUpdates = false
    @Published private(set) var isAvailable = false
    @Published private(set) var automaticallyChecks = false
    @Published private(set) var automaticallyInstalls = false
    private var controller: SPUStandardUpdaterController?

    static func isConfigured(info: [String: Any], isIsolated: Bool) -> Bool {
        guard !isIsolated,
              let key = info["SUPublicEDKey"] as? String,
              Data(base64Encoded: key)?.count == 32,
              let feed = info["SUFeedURL"] as? String,
              let url = URL(string: feed), url.scheme == "https", url.host != nil
        else { return false }
        return true
    }

    private let isIsolated: Bool
    private let bundle: Bundle

    init(isIsolated: Bool, bundle: Bundle = .main, startImmediately: Bool = true) {
        self.isIsolated = isIsolated
        self.bundle = bundle
        if startImmediately { start() }
    }

    func start() {
        guard controller == nil else { return }
        guard Self.isConfigured(info: bundle.infoDictionary ?? [:], isIsolated: isIsolated) else { return }
        let controller = SPUStandardUpdaterController(
            startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)
        self.controller = controller
        let updater = controller.updater
        updater.publisher(for: \.canCheckForUpdates).receive(on: RunLoop.main)
            .assign(to: &$canCheckForUpdates)
        updater.publisher(for: \.automaticallyChecksForUpdates).receive(on: RunLoop.main)
            .assign(to: &$automaticallyChecks)
        updater.publisher(for: \.automaticallyDownloadsUpdates).receive(on: RunLoop.main)
            .assign(to: &$automaticallyInstalls)
        do {
            try updater.start()
            isAvailable = true
            // Only at startup: subsequent checks belong to Sparkle's scheduler.
            if updater.automaticallyChecksForUpdates { updater.checkForUpdatesInBackground() }
        } catch {
            Log.app.error("App updater could not start: \(error.localizedDescription, privacy: .public)")
        }
    }

    func checkForUpdates() {
        guard isAvailable, canCheckForUpdates else { return }
        controller?.checkForUpdates(nil)
    }

    func setAutomaticChecks(_ enabled: Bool) {
        controller?.updater.automaticallyChecksForUpdates = enabled
    }

    func setAutomaticInstallation(_ enabled: Bool) {
        controller?.updater.automaticallyDownloadsUpdates = enabled
    }
}

struct AppUpdateMenu: View {
    @ObservedObject var updater: AppUpdater
    var body: some View {
        Button(L.t("native_updates_check")) { updater.checkForUpdates() }
            .disabled(!updater.canCheckForUpdates)
    }
}

struct AppUpdateSettingsPane: SettingsPane {
    let updater: AppUpdater
    let id = "app-updates"
    var title: String { L.t("native_updates_title") }
    let systemImage = "arrow.down.circle"
    let order = 90
    @MainActor func makeView(app: AppModel) -> AnyView {
        AnyView(AppUpdateSettings(updater: updater))
    }
}

struct AppUpdateSettings: View {
    @ObservedObject var updater: AppUpdater
    var body: some View {
        Form {
            if updater.isAvailable {
                Toggle(L.t("native_updates_automatic_check"), isOn: Binding(
                    get: { updater.automaticallyChecks }, set: { updater.setAutomaticChecks($0) }))
                Toggle(L.t("native_updates_automatic_install"), isOn: Binding(
                    get: { updater.automaticallyInstalls }, set: { updater.setAutomaticInstallation($0) }))
                    .disabled(!updater.automaticallyChecks)
                Text(L.t("native_updates_install_note"))
                    .foregroundStyle(.secondary)
                AppUpdateMenu(updater: updater)
            } else {
                Text(L.t("native_updates_unavailable"))
            }
        }
        .padding(24)
    }
}
