import AppKit
import Foundation

@MainActor
final class AppInstallationPrompt {
    private var launchTask: Task<Bool, Never>?
    private let isIsolated: Bool
    private let bundle: Bundle

    init(isIsolated: Bool, bundle: Bundle = .main) {
        self.isIsolated = isIsolated
        self.bundle = bundle
    }

    /// True only after the installed copy has launched; the caller must stop startup.
    func runIfNeeded() async -> Bool {
        if let launchTask { return await launchTask.value }
        let task = Task { await self.offerInstallation() }
        launchTask = task
        return await task.value
    }

    private func offerInstallation() async -> Bool {
        #if DEBUG
        return false
        #else
        let system = URL(fileURLWithPath: "/Applications", isDirectory: true)
        let user = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
        guard AppUpdater.isConfigured(info: bundle.infoDictionary ?? [:], isIsolated: isIsolated),
              !AppInstallation.isInstalled(bundle.bundleURL, roots: [system, user]) else { return false }
        let prompt = NSAlert()
        prompt.messageText = L.t("native_install_title")
        prompt.informativeText = L.t("native_install_body")
        prompt.addButton(withTitle: L.t("native_install_all_users"))
        prompt.addButton(withTitle: L.t("native_install_current_user"))
        prompt.addButton(withTitle: L.t("native_install_later")).keyEquivalent = "\u{1b}"
        let response = prompt.runModal()
        guard response != .alertThirdButtonReturn else { return false }
        guard response == .alertFirstButtonReturn || response == .alertSecondButtonReturn else { return false }
        let target = (response == .alertFirstButtonReturn ? system : user).appendingPathComponent("Shepherd.app")
        do {
            // An existing app is never overwritten, whether running or stopped.
            // The user may explicitly switch to it instead of installing.
            if FileManager.default.fileExists(atPath: target.path) {
                guard Bundle(url: target)?.bundleIdentifier == bundle.bundleIdentifier else {
                    showError(target: target)
                    return false
                }
                let existing = NSAlert()
                existing.messageText = L.t("native_install_existing_title")
                existing.informativeText = L.t("native_install_existing_body") + "\n\n" + target.path
                existing.addButton(withTitle: L.t("native_install_open_existing"))
                existing.addButton(withTitle: L.t("common_cancel"))
                guard existing.runModal() == .alertFirstButtonReturn else { return false }
            } else {
                let source = bundle.bundleURL
                try await Task.detached(priority: .userInitiated) {
                    try AppInstallation.copy(source: source, to: target)
                }.value
            }
            let resolvedTarget = target.resolvingSymlinksInPath().standardizedFileURL
            if let running = NSWorkspace.shared.runningApplications.first(where: {
                $0.processIdentifier != ProcessInfo.processInfo.processIdentifier &&
                $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == resolvedTarget
            }) {
                running.activate()
            } else {
                let configuration = NSWorkspace.OpenConfiguration()
                // Without this, Launch Services can return this source instance
                // because its bundle identifier matches the installed copy.
                configuration.createsNewApplicationInstance = true
                let running = try await NSWorkspace.shared.openApplication(at: target, configuration: configuration)
                guard running.processIdentifier != ProcessInfo.processInfo.processIdentifier,
                      running.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == resolvedTarget else {
                    showError(target: target)
                    return false
                }
            }
            NSApplication.shared.terminate(nil)
            return true
        } catch {
            showError(target: target)
            return false
        }
        #endif
    }

    private func showError(target: URL) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L.t("native_install_failed_title")
        alert.informativeText = L.t("native_install_failed_body") + "\n\n" + target.path
        alert.addButton(withTitle: L.t("common_close"))
        alert.runModal()
    }
}
