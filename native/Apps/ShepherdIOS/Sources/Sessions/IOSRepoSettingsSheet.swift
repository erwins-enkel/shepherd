import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// Shared entry from Settings, repo chips and session rows; servers keep their own repo rows.
struct IOSRepoSettingsDirectory: View {
    let owners: [AppModel]
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                ForEach(owners, id: \.activeProfile?.id) { owner in
                    Section(owner.activeProfile?.name ?? "") {
                        ForEach(owner.store?.repos ?? [], id: \.path) { repo in
                            IOSRepoSettingsRow(owner: owner, repo: repo)
                        }
                    }
                }
            }
            .navigationTitle(L.t("reposettings_title"))
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L.t("common_close")) { dismiss() } } }
        }.tint(SessionListStyle.amber).preferredColorScheme(.dark)
    }
}

private struct IOSRepoSettingsRow: View {
    let repo: Repo
    @State private var control: IOSRepoSettingsControl
    init(owner: AppModel, repo: Repo) {
        self.repo = repo; _control = State(initialValue: IOSRepoSettingsControl(owner: owner, path: repo.path))
    }
    var body: some View {
        NavigationLink {
            IOSRepoSettingsContent(control: control)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: repo.name)
                Text(verbatim: repo.path).font(.caption).foregroundStyle(.secondary)
                if let summary = control.summary { Text(verbatim: summary).font(.caption).foregroundStyle(.secondary) }
                ForEach(control.hints, id: \.self) { Text(verbatim: $0).font(.caption).foregroundStyle(.orange) }
                if let error = control.error { Text(verbatim: error).font(.caption).foregroundStyle(.red) }
            }.frame(minHeight: 44)
        }.task { await control.load() }
    }
}

struct IOSRepoSettingsSheet: View {
    let control: IOSRepoSettingsControl
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            IOSRepoSettingsContent(control: control)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L.t("common_close")) { dismiss() } } }
        }.tint(SessionListStyle.amber).preferredColorScheme(.dark)
    }
}

struct IOSRepoSettingsContent: View {
    let control: IOSRepoSettingsControl
    var body: some View {
        Form {
            Section {
                Text(verbatim: control.path).font(.caption).textSelection(.enabled)
                if let name = control.owner.activeProfile?.name { Text(verbatim: name).font(.caption).foregroundStyle(.secondary) }
                if let summary = control.summary { Text(verbatim: summary).font(.caption) }
            }
            if let error = control.error {
                Section {
                    Text(verbatim: error).foregroundStyle(.red)
                    Button(L.t("common_retry")) { Task { await control.load() } }.disabled(control.busy || !control.current)
                }
            }
            if let config = control.config {
                autonomy(config)
                Section(L.t("reposettings_chain_name")) {
                    ForEach(RepoSettingsForm.AutonomyStep.allCases, id: \.self) { step in
                        LabeledContent(step.name, value: L.t(RepoSettingsForm.shepherdHandles(step, config: config)
                            ? "reposettings_chain_shepherd" : "guardtl_marker_you"))
                    }
                }
                Section(L.t("reposettings_section_agent")) {
                    Picker(L.t("automation_coding_cli_label"), selection: Binding(
                        get: { config.agentProvider ?? RepoSettingsForm.inherit },
                        set: { value in Task { await control.save(.init(agentProvider: value)) } })) {
                        Text(L.t("automation_coding_cli_inherit")).tag(RepoSettingsForm.inherit)
                        Text(L.t("agent_provider_claude")).tag("claude")
                        Text(L.t("agent_provider_codex")).tag("codex")
                    }
                    .disabled(!control.writable || control.busy)
                }
                Section(L.t("reposettings_section_merge")) {
                    Picker(L.t("reposettings_merge_mode_name"), selection: Binding(
                        get: { RepoSettingsForm.effectiveMergeMode(config) },
                        set: { value in Task { await control.save(RepoSettingsForm.mergePatch(value)) } })) {
                        ForEach(RepoSettingsForm.MergeMode.allCases, id: \.self) { mode in
                            Text(verbatim: IOSRepoSettingsControl.mergeName(mode)).tag(mode)
                                .selectionDisabled(mode == .draft && RepoSettingsForm.isLightweight(config))
                        }
                    }.disabled(!control.writable || control.busy)
                }
                if config.noPrCi == true && !config.mergeWithoutCi && !RepoSettingsForm.isLightweight(config) {
                    Section(L.t("automation_no_pr_ci_title")) { Text(L.t("automation_no_pr_ci_body")) }
                }
            } else if control.error == nil { ProgressView(L.t("common_loading")) }
            if control.busy && control.config != nil { ProgressView(L.t("common_loading")) }
        }
        .navigationTitle(L.t("reposettings_title"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await control.load() }
        .accessibilityIdentifier("repo-settings")
    }

    private func autonomy(_ config: RepoConfig) -> some View {
        Section {
            Text(L.t("reposettings_autonomy_desc")).font(.caption).foregroundStyle(.secondary)
            ForEach(RepoSettingsForm.AutonomyLevel.allCases, id: \.self) { level in
                let locked = RepoSettingsForm.isLightweight(config) && level.needsForge
                Button { Task { await control.select(level) } } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(verbatim: level.name).fontWeight(.medium)
                            Spacer()
                            if RepoSettingsForm.autonomyLevel(config) == level { Image(systemName: "checkmark") }
                        }
                        Text(verbatim: level.explanation).font(.caption).foregroundStyle(.secondary)
                        if locked { Text(L.t("automation_lightweight_unavailable")).font(.caption) }
                        if !locked && level.needsForge && RepoSettingsForm.effectiveSandbox(config) == "standard" {
                            Text(L.t("reposettings_autonomy_sandbox_halt")).font(.caption).foregroundStyle(.orange)
                        }
                    }.padding(.vertical, 4).frame(minHeight: 44)
                }
                .disabled(locked || control.busy || !control.writable)
                .accessibilityAddTraits(RepoSettingsForm.autonomyLevel(config) == level ? [.isSelected] : [])
                .accessibilityIdentifier("repo-autonomy-\(level.rawValue)")
            }
            if RepoSettingsForm.autonomyLevel(config) == nil {
                Text(L.t("reposettings_autonomy_custom_note")).font(.caption).foregroundStyle(.secondary)
            }
        } header: { Text(L.t("reposettings_section_autonomy")) }
    }
}

/// A hosted context-menu preview can load asynchronously; native menu labels cannot.
struct IOSRepoSettingsPreview: View {
    @State private var control: IOSRepoSettingsControl
    init(owner: AppModel, path: String) {
        _control = State(initialValue: IOSRepoSettingsControl(owner: owner, path: path))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L.t("reposettings_title")).font(.headline)
            Text(verbatim: control.path).font(.caption)
            if let name = control.owner.activeProfile?.name { Text(verbatim: name).font(.caption).foregroundStyle(.secondary) }
            if let summary = control.summary { Text(verbatim: summary) }
            else if let error = control.error { Text(verbatim: error).foregroundStyle(.red) }
            else { ProgressView(L.t("common_loading")) }
            ForEach(control.hints, id: \.self) { Text(verbatim: $0).font(.caption).foregroundStyle(.orange) }
        }.padding().frame(idealWidth: 320).fixedSize(horizontal: false, vertical: true)
            .task { await control.load() }
    }
}
