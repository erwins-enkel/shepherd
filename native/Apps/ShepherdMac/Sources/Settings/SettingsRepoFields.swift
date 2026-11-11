import ShepherdAppCore
import SwiftUI
import Observation
import ShepherdKit

/// The repo settings (#3450), grouped like the web window: Agent environment, Start & flow,
/// Review, Merge, Epics, Display. Every write goes through `save` as one `RepoConfigPatch`.
struct SettingsRepoFields: View {
    let config: RepoConfig
    let defaults: ComposeRunConfig.Defaults
    let save: (RepoConfigPatch, @escaping @MainActor (RepoConfig) -> Void) -> Void

    var body: some View {
        Group {
            Section { textRow("native_settings_repo_repomode", value: { $0.repoMode }) { .init(repoMode: $0) } }
            Section(L.t("reposettings_section_agent")) { agent }
            Section(L.t("reposettings_section_start")) { start }
            Section(L.t("reposettings_section_review")) {
                toggle("native_settings_repo_criticenabled", \.criticEnabled) { .init(criticEnabled: $0) }
                toggle("native_settings_repo_autoaddressenabled", \.autoAddressEnabled) { .init(autoAddressEnabled: $0) }
                toggle("native_settings_repo_criticsmelllensenabled", \.criticSmellLensEnabled) { .init(criticSmellLensEnabled: $0) }
                toggle("native_settings_repo_criticallprs", \.criticAllPrs) { .init(criticAllPrs: $0) }
            }
            Section(L.t("reposettings_section_merge")) { merge }
            Section(L.t("reposettings_section_epics")) {
                toggle("native_settings_repo_epicstacksenabled", \.epicStacksEnabled) { .init(epicStacksEnabled: $0) }
                toggle("native_settings_repo_prewarmepiclandingci", \.preWarmEpicLandingCi) { .init(preWarmEpicLandingCi: $0) }
            }
            Section(L.t("reposettings_section_display")) {
                picker("automation_preview_open_mode_label", id: "previewOpenMode", value: config.previewOpenMode,
                       options: ["ask", "inline", "tab"], label: Self.previewName) { .init(previewOpenMode: $0) }
                textRow("native_settings_repo_previewstartscript", value: { $0.previewStartScript ?? "" }) { .init(previewStartScript: $0) }
                textRow("native_settings_repo_previewstartcommand", value: { $0.previewStartCommand ?? "" }) { .init(previewStartCommand: $0) }
                toggle("native_settings_repo_hidden", \.hidden) { .init(hidden: $0) }
            }
        }
    }

    @ViewBuilder private var agent: some View {
        let cli = RepoSettingsForm.effectiveProvider(config, global: defaults.provider)
        let model = RepoSettingsForm.shownModel(config.defaultModel, provider: cli)
        let effort = RepoSettingsForm.shownEffort(config.defaultEffort, provider: cli)
        picker("automation_coding_cli_label", id: "agentProvider", value: config.agentProvider ?? RepoSettingsForm.inherit,
               options: RepoSettingsForm.providerOptions, label: Self.providerName) { .init(agentProvider: $0) }
        picker("automation_default_model_label", id: "defaultModel", value: model,
               options: RepoSettingsForm.modelOptions(shown: model, provider: cli, fableAvailable: defaults.fableAvailable,
                                          mythosAvailable: defaults.mythosAvailable),
               label: { Self.modelName($0, provider: cli) }) { .init(defaultModel: $0) }
        picker("automation_default_effort_label", id: "defaultEffort", value: effort,
               options: RepoSettingsForm.effortOptions(provider: cli), label: Self.effortName) { .init(defaultEffort: $0) }
        picker("automation_sandbox_profile_label", id: "sandboxProfile", value: RepoSettingsForm.shownSandbox(config),
               options: RepoSettingsForm.sandboxOptions, label: sandboxName) { .init(sandboxProfile: $0) }
        if RepoSettingsForm.showsEgressHosts(config) {
            SettingsRepoHostList(hosts: config.egressExtraHosts) { hosts, adopt in
                save(.init(egressExtraHosts: hosts)) { _ in adopt() }
            }
        }
        toggle("native_settings_repo_sharedbrowserenabled", \.sharedBrowserEnabled) { .init(sharedBrowserEnabled: $0) }
        textRow("native_settings_repo_browserallowedhosts", value: { $0.browserAllowedHosts.joined(separator: ",") }) {
            .init(browserAllowedHosts: $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
        }
    }

    @ViewBuilder private var start: some View {
        toggle("native_settings_repo_autodrainenabled", \.autoDrainEnabled) { .init(autoDrainEnabled: $0) }
        toggle("native_settings_repo_plangateenabled", \.planGateEnabled) { .init(planGateEnabled: $0) }
        toggle("native_settings_repo_buildqueueenabled", \.buildQueueEnabled) { .init(buildQueueEnabled: $0) }
        toggle("native_settings_repo_autopilotenabled", \.autopilotEnabled) { .init(autopilotEnabled: $0) }
        textRow("native_settings_repo_maxauto", value: { String($0.maxAuto) }) {
            guard let value = Int($0) else { return nil }; return .init(maxAuto: value)
        }
        textRow("native_settings_repo_usageceilingpct", value: { String($0.usageCeilingPct) }) {
            guard let value = Double($0), value.isFinite else { return nil }
            return .init(usageCeilingPct: value)
        }
        textRow("native_settings_repo_autolabel", value: { $0.autoLabel }) { .init(autoLabel: $0) }
    }

    @ViewBuilder private var merge: some View {
        let lightweight = RepoSettingsForm.isLightweight(config)
        Picker(L.t("reposettings_merge_mode_name"), selection: Binding(
            get: { RepoSettingsForm.effectiveMergeMode(config) },
            set: { request(RepoSettingsForm.mergePatch($0)) })) {
            ForEach(RepoSettingsForm.MergeMode.allCases, id: \.self) { mode in
                Text(verbatim: Self.mergeName(mode)).tag(mode).selectionDisabled(mode == .draft && lightweight)
            }
        }
        .pickerStyle(.radioGroup)
        .accessibilityIdentifier("settings.repo.mergeMode")
        Text(verbatim: Self.mergeDescription(RepoSettingsForm.effectiveMergeMode(config)))
            .font(.caption).foregroundStyle(.secondary)
        if lightweight { Text(L.t("automation_lightweight_unavailable")).font(.caption).foregroundStyle(.secondary) }
        if RepoSettingsForm.effectiveMergeMode(config) == .draft {
            textRow("native_settings_repo_signoffauthority", value: { $0.signoffAuthority }) { .init(signoffAuthority: $0) }
        }
        toggle("native_settings_repo_manualstepsissueenabled", \.manualStepsIssueEnabled) { .init(manualStepsIssueEnabled: $0) }
    }

    private func request(_ patch: RepoConfigPatch) { save(patch, { _ in }) }

    private func toggle(_ title: StaticString, _ key: KeyPath<RepoConfig, Bool>,
                        patch: @escaping (Bool) -> RepoConfigPatch) -> some View {
        Toggle(L.t(title), isOn: Binding(get: { config[keyPath: key] }, set: { request(patch($0)) }))
    }

    private func picker(_ title: StaticString, id: String, value: String, options: [String],
                        label: @escaping (String) -> String,
                        patch: @escaping (String) -> RepoConfigPatch) -> some View {
        Picker(L.t(title), selection: Binding(get: { value }, set: { if $0 != value { request(patch($0)) } })) {
            ForEach(options, id: \.self) { Text(verbatim: label($0)).tag($0) }
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("settings.repo.\(id)")
    }

    private func textRow(_ title: StaticString, value: @escaping (RepoConfig) -> String,
                         patch: @escaping (String) -> RepoConfigPatch?) -> some View {
        SettingsRepoTextRow(title: title, value: value(config)) { text, adopt in
            guard let body = patch(text) else { return }
            save(body) { adopt(value($0)) }
        }
    }

    private func sandboxName(_ value: String) -> String {
        guard value == RepoSettingsForm.inherit else { return Self.profileName(value) }
        guard let resolved = config.sandboxDefaultProfile?.rawValue else { return L.t("automation_sandbox_inherit_unresolved") }
        return L.t("automation_sandbox_inherit", Self.profileName(resolved))
    }

    private static func profileName(_ value: String) -> String {
        switch value {
        case "trusted": L.t("sandbox_profile_trusted")
        case "standard": L.t("sandbox_profile_standard")
        default: L.t("sandbox_profile_autonomous")
        }
    }

    private static func providerName(_ value: String) -> String {
        switch value {
        case "claude": L.t("agent_provider_claude")
        case "codex": L.t("agent_provider_codex")
        default: L.t("automation_coding_cli_inherit")
        }
    }

    private static func modelName(_ value: String, provider: AgentProvider) -> String {
        switch value {
        case RepoSettingsForm.inherit: L.t("automation_default_model_inherit")
        case "auto": L.t("settings_default_model_auto")
        case "default": L.t("newtask_model_default")
        default: ModelGuidance.optionLabel(provider: provider, model: value)
        }
    }

    private static func effortName(_ value: String) -> String {
        switch value {
        case RepoSettingsForm.inherit: L.t("automation_default_effort_inherit")
        case "low": L.t("effort_label_low")
        case "medium": L.t("effort_label_medium")
        case "high": L.t("effort_label_high")
        case "xhigh": L.t("effort_label_xhigh")
        case "max": L.t("effort_label_max")
        case "ultra": L.t("effort_label_ultra")
        default: L.t("effort_default")
        }
    }

    private static func mergeName(_ mode: RepoSettingsForm.MergeMode) -> String {
        switch mode {
        case .manual: L.t("reposettings_merge_mode_manual")
        case .draft: L.t("reposettings_merge_mode_draft")
        case .auto: L.t("automation_automerge_name")
        }
    }

    private static func mergeDescription(_ mode: RepoSettingsForm.MergeMode) -> String {
        switch mode {
        case .manual: L.t("reposettings_merge_mode_manual_desc")
        case .draft: L.t("automation_draftmode_desc")
        case .auto: L.t("automation_automerge_desc")
        }
    }

    private static func previewName(_ value: String) -> String {
        switch value {
        case "inline": L.t("preview_open_mode_inline")
        case "tab": L.t("preview_open_mode_tab")
        default: L.t("preview_open_mode_ask")
        }
    }
}

/// The extra allowed hosts of an Autonomous sandbox: one row per host with Remove, plus an Add
/// field validated like the web (`checkEgressHost`).
struct SettingsRepoHostList: View {
    let hosts: [String]
    let save: ([String], @escaping @MainActor () -> Void) -> Void
    @State private var draft = ""
    @State private var error: RepoSettingsForm.HostError?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L.t("automation_egress_hosts_label"))
            if hosts.isEmpty {
                Text(L.t("automation_egress_hosts_empty")).font(.caption).foregroundStyle(.secondary)
            }
            ForEach(hosts, id: \.self) { host in
                HStack {
                    Text(verbatim: host)
                    Spacer()
                    Button(L.t("automation_egress_hosts_remove", host)) { save(hosts.filter { $0 != host }) {} }
                }
            }
            HStack {
                TextField(L.t("automation_egress_hosts_label"), text: $draft,
                          prompt: Text(L.t("automation_egress_hosts_placeholder")))
                    .labelsHidden().onSubmit(add).onChange(of: draft) { error = nil }
                    .accessibilityIdentifier("settings.repo.egressHost")
                Button(L.t("automation_egress_hosts_add"), action: add)
            }
            if let error { Text(verbatim: Self.message(error)).font(.caption).foregroundStyle(.red) }
            if hosts.contains(where: RepoSettingsForm.isWildcardEgressEntry) {
                Text(L.t("automation_egress_hosts_wildcard_warn")).font(.caption).foregroundStyle(.orange)
            }
            Text(L.t("automation_egress_hosts_hint")).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func add() {
        switch RepoSettingsForm.checkEgressHost(draft, existing: hosts) {
        case .success(let host): save(hosts + [host]) { draft = "" }
        case .failure(let failure): error = failure
        }
    }

    private static func message(_ error: RepoSettingsForm.HostError) -> String {
        switch error {
        case .empty: L.t("automation_egress_hosts_err_empty")
        case .invalid: L.t("automation_egress_hosts_err_invalid")
        case .duplicate: L.t("automation_egress_hosts_err_duplicate")
        }
    }
}

struct SettingsRepoTextRow: View {
    let title: StaticString
    let value: String
    let save: (String, @escaping @MainActor (String) -> Void) -> Void
    @State private var draft = SettingsRepoTextDraft()
    var body: some View {
        @Bindable var draft = draft
        HStack {
            TextField(L.t(title),text:$draft.text)
            Button(L.t("common_save")) { draft.submit(save) }.disabled(draft.text == value)
        }.onAppear {draft.text = value}.onChange(of:value) {draft.text = value}
    }
}
