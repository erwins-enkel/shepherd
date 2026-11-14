import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

/// One repo on one server activation. An open sheet never follows a changed server selection.
@MainActor @Observable
final class IOSRepoSettingsControl: Identifiable {
    let id = UUID()
    let owner: AppModel
    let path: String
    private let activation: Int
    private let store: SessionStore?
    @ObservationIgnored private let read: (ShepherdClient, String) async throws -> RepoConfig
    @ObservationIgnored private let write: (ShepherdClient, String, RepoConfigPatch) async throws -> RepoConfig
    var config: RepoConfig?
    var busy = false
    var error: String?
    var current: Bool { store != nil && owner.store === store && owner.activationGeneration == activation }
    var writable: Bool { current && owner.liveRequestAudit == nil }
    var defaults: ComposeRunConfig.Defaults { ComposeRunConfig.defaults(from: store?.settings) }

    init(owner: AppModel, path: String,
         read: @escaping (ShepherdClient, String) async throws -> RepoConfig = { try await $0.getRepoConfig(repo: $1) },
         write: @escaping (ShepherdClient, String, RepoConfigPatch) async throws -> RepoConfig = {
             try await $0.putRepoConfig(repo: $1, body: $2)
         }) {
        self.owner = owner; self.path = path; activation = owner.activationGeneration; store = owner.store
        self.read = read; self.write = write
    }

    func load() async {
        guard current, !busy, let store else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let value = try await read(store.client, path)
            guard current, !Task.isCancelled else { return }
            config = value
        } catch { if current, !Task.isCancelled { self.error = ShepherdErrorCopy.message(error) } }
    }

    func select(_ level: RepoSettingsForm.AutonomyLevel) async {
        guard let config, !(RepoSettingsForm.isLightweight(config) && level.needsForge) else { return }
        await save(RepoSettingsForm.autonomyPatch(level))
    }

    func save(_ patch: RepoConfigPatch) async {
        guard writable, config != nil, !busy, let store else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let value = try await write(store.client, path, patch)
            guard current, !Task.isCancelled else { return }
            config = value
        } catch { if current, !Task.isCancelled { self.error = ShepherdErrorCopy.message(error) } }
    }

    var summary: String? {
        guard let config else { return nil }
        let provider = RepoSettingsForm.effectiveProvider(config, global: defaults.provider)
        return [RepoSettingsForm.autonomyLevel(config)?.name ?? L.t("reposettings_autonomy_custom"),
                L.t(provider == .claude ? "agent_provider_claude" : "agent_provider_codex"),
                Self.mergeName(RepoSettingsForm.effectiveMergeMode(config))].joined(separator: " · ")
    }

    var hints: [String] {
        guard let config else { return [] }
        var hints: [String] = []
        if config.noPrCi == true && !config.mergeWithoutCi && !RepoSettingsForm.isLightweight(config) {
            hints.append(L.t("automation_no_pr_ci_title"))
        }
        if config.autoDrainEnabled && !RepoSettingsForm.isLightweight(config)
            && RepoSettingsForm.effectiveSandbox(config) == "standard" {
            hints.append(L.t("reposettings_autonomy_sandbox_halt"))
        }
        return hints
    }

    static func mergeName(_ mode: RepoSettingsForm.MergeMode) -> String {
        switch mode {
        case .manual: L.t("reposettings_merge_mode_manual")
        case .draft: L.t("reposettings_merge_mode_draft")
        case .auto: L.t("automation_automerge_name")
        }
    }
}
