import Foundation
import ShepherdKit

/// The repo settings' choices (#3450), mirroring the web window (ui `repo-settings/`,
/// `merge-mode.ts`, `repo-cli.ts`, `list-entries.ts`). Pure: the Mac view reads a `RepoConfig`
/// through these and writes every change as one `RepoConfigPatch`.
public enum RepoSettingsForm {
    /// How a repo's finished PRs land: one choice over `draftMode` + `autoMergeEnabled`, so the two
    /// are never both on.
    public enum MergeMode: String, CaseIterable, Sendable { case manual, draft, auto }

    /// The merge mode a config holds. Draft wins over an auto-merge beside it, as on the server.
    public static func mergeMode(draftMode: Bool, autoMergeEnabled: Bool) -> MergeMode {
        draftMode ? .draft : (autoMergeEnabled ? .auto : .manual)
    }

    /// The merge mode that takes effect: a local-only repo has no draft PRs, so a stored draft means
    /// you merge.
    public static func effectiveMergeMode(_ config: RepoConfig) -> MergeMode {
        let mode = mergeMode(draftMode: config.draftMode, autoMergeEnabled: config.autoMergeEnabled)
        return mode == .draft && isLightweight(config) ? .manual : mode
    }

    /// The patch that sets a merge mode: always both fields, so one write switches cleanly.
    public static func mergePatch(_ mode: MergeMode) -> RepoConfigPatch {
        .init(autoMergeEnabled: mode == .auto, draftMode: mode == .draft)
    }

    public static func isLightweight(_ config: RepoConfig) -> Bool { config.repoMode == "lightweight" }

    // MARK: Coding CLI, model, effort

    public static let inherit = "inherit"
    public static let providerOptions = [inherit] + AgentProvider.allCases.map(\.rawValue)

    /// The CLI the repo's tasks start on: its own setting, else the global default.
    public static func effectiveProvider(_ config: RepoConfig, global: AgentProvider) -> AgentProvider {
        ComposeRunConfig.repoPinnedProvider(config.agentProvider) ?? global
    }

    /// The model setting the picker shows: a stored model the effective CLI cannot run is ignored at
    /// spawn time, so it reads as Inherit.
    public static func shownModel(_ stored: String, provider: AgentProvider) -> String {
        modelFits(stored, provider: provider) ? stored : inherit
    }

    public static func modelOptions(shown: String, provider: AgentProvider, fableAvailable: Bool,
                                    mythosAvailable: Bool) -> [String] {
        [inherit, "auto", "default"] + ComposeRunConfig.pickerModels(
            provider, current: shown, fableAvailable: fableAvailable, mythosAvailable: mythosAvailable)
    }

    public static func shownEffort(_ stored: String, provider: AgentProvider) -> String {
        effortFits(stored, provider: provider) ? stored : inherit
    }

    public static func effortOptions(provider: AgentProvider) -> [String] {
        [inherit, "default"] + efforts(provider)
    }

    static func modelFits(_ setting: String, provider: AgentProvider) -> Bool {
        [inherit, "auto", "default"].contains(setting) || ComposeRunConfig.providerModels(provider).contains(setting)
    }

    static func effortFits(_ setting: String, provider: AgentProvider) -> Bool {
        setting == inherit || setting == "default" || efforts(provider).contains(setting)
    }

    /// Mirrors ui `providerEfforts`: "ultra" is Codex-only.
    static func efforts(_ provider: AgentProvider) -> [String] {
        provider == .codex ? ComposeRunConfig.efforts : ComposeRunConfig.efforts.filter { $0 != "ultra" }
    }

    // MARK: Sandbox

    public static let sandboxProfiles = ["trusted", "standard", "autonomous"]
    public static let sandboxOptions = [inherit] + sandboxProfiles

    /// The stored sandbox setting as the picker shows it (an unknown value reads as Inherit).
    public static func shownSandbox(_ config: RepoConfig) -> String {
        sandboxProfiles.contains(config.sandboxProfile) ? config.sandboxProfile : inherit
    }

    /// The profile the repo's spawns run under; nil while an inherited default is unknown.
    public static func effectiveSandbox(_ config: RepoConfig) -> String? {
        let stored = shownSandbox(config)
        return stored == inherit ? config.sandboxDefaultProfile?.rawValue : stored
    }

    /// The extra allowed hosts only widen the Autonomous egress firewall, so the list shows there.
    public static func showsEgressHosts(_ config: RepoConfig) -> Bool { effectiveSandbox(config) == "autonomous" }

    // MARK: Extra allowed hosts

    public enum HostError: Error, Equatable, Sendable { case empty, invalid, duplicate }

    // swiftlint:disable:next force_try
    private static let hostname = try! NSRegularExpression(
        pattern: #"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$"#)

    // swiftlint:disable:next force_try
    private static let egressEntry = try! NSRegularExpression(
        pattern: #"^(\*\.)?([^:*]+)(?::([1-9][0-9]{0,4}))?$"#)

    // swiftlint:disable:next force_try
    private static let ipv4 = try! NSRegularExpression(pattern: #"^[0-9]+(\.[0-9]+)+$"#)

    private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// Mirrors ui `normalizeEgressEntry`: `host` exactly, `*.host` its subdomains, each optionally
    /// `:port` (that port only); `:443` is the default and dropped. Nil when invalid.
    static func normalizeEgressEntry(_ entry: String) -> String? {
        guard let match = egressEntry.firstMatch(in: entry, range: NSRange(entry.startIndex..., in: entry))
        else { return nil }
        func group(_ index: Int) -> String? {
            Range(match.range(at: index), in: entry).map { String(entry[$0]) }
        }
        let wildcard = group(1) ?? ""
        guard let host = group(2), matches(hostname, host) else { return nil }
        if !wildcard.isEmpty && matches(ipv4, host) { return nil }
        let port = group(3).flatMap { Int($0) } ?? 443
        if port > 65535 { return nil }
        return port == 443 ? wildcard + host : "\(wildcard)\(host):\(port)"
    }

    /// Mirrors ui `checkEgressHost`: trimmed, lower-cased, then `normalizeEgressEntry`.
    public static func checkEgressHost(_ raw: String, existing: [String]) -> Result<String, HostError> {
        let entry = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if entry.isEmpty { return .failure(.empty) }
        guard let value = normalizeEgressEntry(entry) else { return .failure(.invalid) }
        if existing.contains(value) { return .failure(.duplicate) }
        return .success(value)
    }

    /// Mirrors ui `isWildcardEgressEntry`: a `*.` entry opens every subdomain, so Settings warns.
    public static func isWildcardEgressEntry(_ entry: String) -> Bool { entry.hasPrefix("*.") }
}
