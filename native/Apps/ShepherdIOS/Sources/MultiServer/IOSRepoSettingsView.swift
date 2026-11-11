import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct IOSRepoSettingsView: View {
    @State var model: IOSRepoSettingsModel
    @State private var confirming = false

    var body: some View {
        Form {
            if let project = model.project {
                Section(L.t("native_repo_machines")) {
                    ForEach(project.machines, id: \.instanceId) { machine in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(verbatim: machine.name).foregroundStyle(SessionListStyle.bright)
                            Text(verbatim: machine.reachable ? L.t("native_repo_online") : L.t("native_repo_offline"))
                            if project.leitrechner?.instanceId == machine.instanceId { Text(L.t("native_repo_leader")) }
                            if let commit = machine.config?.repoConfigCommit {
                                Text(verbatim: String(commit.prefix(12)))
                            } else { Text(L.t(machine.reachable ? "native_repo_not_shared" : "native_repo_status_unavailable")) }
                        }.sessionFont(label: true).accessibilityElement(children: .combine)
                    }
                }
                if model.draft != nil && !model.isLocalOnly {
                    Section(L.t("native_repo_every_machine")) {
                        ruleHeading("reposettings_section_review")
                        rule("native_settings_repo_criticenabled", \.criticEnabled)
                        rule("native_settings_repo_autoaddressenabled", \.autoAddressEnabled)
                        ruleHeading("reposettings_section_agent")
                        rule("native_settings_repo_autopilotenabled", \.autopilotEnabled)
                        rule("native_settings_repo_plangateenabled", \.planGateEnabled)
                        textRule("automation_default_model_label", \.defaultModel)
                        Picker(L.t("automation_default_effort_label"), selection: Binding(
                            get: { model.draft?.rules.defaultEffort ?? "inherit" },
                            set: { model.draft?.rules.defaultEffort = $0 })) {
                            ForEach(RepoSettingsForm.effortOptions(provider: .codex), id: \.self) {
                                Text(verbatim: Self.effortName($0)).tag($0)
                            }
                        }.disabled(model.busy)
                        ForEach(project.machines, id: \.instanceId) { machine in
                            if let defaults = machine.config?.inheritedRunDefaults {
                                Text(verbatim: L.t("native_repo_inherited", machine.name,
                                    defaults.model ?? "—", Self.effortName(defaults.effort ?? "default")))
                                    .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                            }
                        }
                        ruleHeading("reposettings_section_merge")
                        rule("native_settings_repo_automergeenabled", \.autoMergeEnabled)
                        rule("native_settings_repo_draftmode", \.draftMode)
                        Picker(L.t("native_settings_repo_signoffauthority"), selection: Binding(
                            get: { model.draft?.rules.signoffAuthority ?? "human" },
                            set: { model.draft?.rules.signoffAuthority = $0 })) {
                            Text(L.t("signoff_authority_human")).tag("human")
                            Text(L.t("signoff_authority_critic")).tag("critic")
                            Text(L.t("signoff_authority_either")).tag("either")
                        }.disabled(model.busy)
                        DisclosureGroup(L.t("native_repo_more_rules")) {
                            rule("native_settings_repo_criticsmelllensenabled", \.criticSmellLensEnabled)
                            rule("native_settings_repo_buildqueueenabled", \.buildQueueEnabled)
                            rule("native_settings_repo_manualstepsissueenabled", \.manualStepsIssueEnabled)
                            rule("native_settings_repo_prewarmepiclandingci", \.preWarmEpicLandingCi)
                            rule("native_settings_repo_epicstacksenabled", \.epicStacksEnabled)
                            textRule("native_settings_repo_autolabel", \.autoLabel)
                        }
                    }
                    if let writerID = model.writerID { IOSRepoRolesSection(client: model.client, slug: model.slug, instanceID: writerID).id(writerID) }
                    Section(L.t("native_repo_leader")) {
                        Picker(L.t("native_repo_leader"), selection: Binding(
                            get: { model.draft?.leader ?? "" }, set: { model.draft?.leader = $0.isEmpty ? nil : $0 })) {
                            Text(L.t("native_repo_no_leader")).tag("")
                            ForEach(project.machines.filter { $0.config != nil || $0.instanceId == project.leitrechner?.instanceId }, id: \.instanceId) {
                                Text(verbatim: $0.name).tag($0.instanceId)
                            }
                        }
                        rule("native_settings_repo_autodrainenabled", \.autoDrainEnabled)
                        rule("native_settings_repo_criticallprs", \.criticAllPrs)
                    }
                    if !model.changes.isEmpty {
                        Button(L.t("native_repo_review_changes", String(model.changes.count))) { confirming = true }
                            .disabled(model.busy || model.writerID == nil)
                    }
                }
                Section {
                    Picker(L.t("native_repo_machine"), selection: $model.machineID) {
                        ForEach(project.machines, id: \.instanceId) { Text(verbatim: $0.name).tag($0.instanceId) }
                    }
                    if let machine = model.machine, let config = machine.config {
                        IOSRepoMachineFields(config: config) { patch in Task { await model.saveMachine(patch) } }
                            .disabled(model.busy || !machine.reachable)
                    } else { Text(L.t("native_repo_machine_unavailable")) }
                } header: { Text(L.t("native_repo_this_machine")) }
                  footer: { Text(L.t("native_repo_machine_footer")) }
            } else if model.busy { ProgressView() }
            if let receipt = model.receipt {
                Section {
                    if let pending = receipt.pendingRepoConfig, let url = URL(string: pending.url) {
                        Link(L.t("native_repo_pending_pr", String(pending.number)), destination: url)
                    } else if let commit = receipt.repoConfigCommit {
                        Text(verbatim: L.t("native_repo_saved_commit", String(commit.prefix(12))))
                    }
                    ForEach(receipt.notifications, id: \.instanceId) { notice in
                        Text(verbatim: L.t(notice.ok ? "native_repo_adopted" : "native_repo_adopt_later", notice.name))
                    }
                }
            }
            if let pending = model.project?.pendingRepoConfig, model.receipt == nil, let url = URL(string: pending.url) {
                Link(L.t("native_repo_pending_pr", String(pending.number)), destination: url)
            }
            if let error = model.error { Text(verbatim: error).foregroundStyle(SessionListStyle.red) }
            Button(L.t("native_repo_reload")) { Task { await model.load() } }.disabled(model.busy)
        }
        .sessionFont().scrollContentBackground(.hidden).background(SessionListStyle.background)
        .tint(SessionListStyle.amber).navigationTitle(model.slug)
        .task { await model.load() }
        .sheet(isPresented: $confirming) { confirmation }
    }

    private func ruleHeading(_ title: StaticString) -> some View {
        Text(L.t(title)).sessionFont(label: true).foregroundStyle(SessionListStyle.amber)
            .accessibilityAddTraits(.isHeader)
    }
    private func rule(_ title: StaticString, _ key: WritableKeyPath<RepoRules, Bool>) -> some View {
        Toggle(L.t(title), isOn: Binding(get: { model.draft?.rules[keyPath: key] ?? false },
                                        set: { value in
                                            model.draft?.rules[keyPath: key] = value
                                            if value, key == \RepoRules.autoMergeEnabled { model.draft?.rules.draftMode = false }
                                            if value, key == \RepoRules.draftMode { model.draft?.rules.autoMergeEnabled = false }
                                        }))
            .disabled(model.busy)
    }
    private func textRule(_ title: StaticString, _ key: WritableKeyPath<RepoRules, String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L.t(title)).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            TextField(L.t(title), text: Binding(get: { model.draft?.rules[keyPath: key] ?? "" },
                                              set: { model.draft?.rules[keyPath: key] = $0 }))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
        }.disabled(model.busy)
    }
    private var confirmation: some View {
        NavigationStack {
            Form {
                Section(L.t("native_repo_review_changes", String(model.changes.count))) {
                    ForEach(model.changes) { change in
                        VStack(alignment: .leading) {
                            Text(verbatim: IOSRepoSettingsView.fieldName(change.id))
                            Text(verbatim: "\(display(change.before, field: change.id)) → \(display(change.after, field: change.id))")
                        }.accessibilityElement(children: .combine)
                    }
                }
                Section(L.t("native_repo_commit_message")) { Text(verbatim: "chore(shepherd): set repo rules") }
                Section {
                    Text(L.t("native_repo_commit_effect"))
                    if let writer = model.project?.machines.first(where: { $0.instanceId == model.writerID }) {
                        Text(verbatim: L.t("native_repo_writer", writer.name))
                    }
                    ForEach(model.project?.machines ?? [], id: \.instanceId) { machine in
                        Text(verbatim: L.t(machine.reachable ? "native_repo_adoption_ready" : "native_repo_adopt_later", machine.name))
                    }
                }
                if let error = model.error { Text(verbatim: error).foregroundStyle(SessionListStyle.red) }
                Button(L.t("native_repo_confirm")) {
                    Task { if await model.save() { confirming = false; await model.load() } }
                }.disabled(model.busy)
            }.sessionFont().tint(SessionListStyle.amber)
                .navigationTitle(L.t("native_repo_confirm_title"))
                .toolbar { ToolbarItem(placement: .cancellationAction) {
                    Button(L.t("common_close")) { confirming = false }.disabled(model.busy)
                } }
                .interactiveDismissDisabled(model.busy)
        }.preferredColorScheme(.dark)
    }
    private func display(_ value: String, field: String) -> String {
        if field == "leitrechner" {
            return model.project?.machines.first { $0.instanceId == value }?.name ?? L.t("native_repo_no_leader")
        }
        if value == "1" { return L.t("native_repo_on") }
        if value == "0" { return L.t("native_repo_off") }
        return value
    }
    private static func effortName(_ value: String) -> String {
        switch value {
        case "inherit": L.t("automation_default_effort_inherit")
        case "low": L.t("effort_label_low")
        case "medium": L.t("effort_label_medium")
        case "high": L.t("effort_label_high")
        case "xhigh": L.t("effort_label_xhigh")
        case "max": L.t("effort_label_max")
        case "ultra": L.t("effort_label_ultra")
        default: L.t("effort_default")
        }
    }
    static func fieldName(_ field: String) -> String {
        switch field {
        case "leitrechner": L.t("native_repo_leader")
        case "defaultModel": L.t("automation_default_model_label")
        case "defaultEffort": L.t("automation_default_effort_label")
        case "criticEnabled": L.t("native_settings_repo_criticenabled")
        case "criticAllPrs": L.t("native_settings_repo_criticallprs")
        case "criticSmellLensEnabled": L.t("native_settings_repo_criticsmelllensenabled")
        case "autoAddressEnabled": L.t("native_settings_repo_autoaddressenabled")
        case "autopilotEnabled": L.t("native_settings_repo_autopilotenabled")
        case "planGateEnabled": L.t("native_settings_repo_plangateenabled")
        case "autoDrainEnabled": L.t("native_settings_repo_autodrainenabled")
        case "autoMergeEnabled": L.t("native_settings_repo_automergeenabled")
        case "buildQueueEnabled": L.t("native_settings_repo_buildqueueenabled")
        case "draftMode": L.t("native_settings_repo_draftmode")
        case "signoffAuthority": L.t("native_settings_repo_signoffauthority")
        case "manualStepsIssueEnabled": L.t("native_settings_repo_manualstepsissueenabled")
        case "preWarmEpicLandingCi": L.t("native_settings_repo_prewarmepiclandingci")
        case "epicStacksEnabled": L.t("native_settings_repo_epicstacksenabled")
        case "autoLabel": L.t("native_settings_repo_autolabel")
        default: field
        }
    }
}

struct IOSRepoMachineFields: View {
    let config: RepoConfig
    let save: (RepoMachinePatch) -> Void
    var body: some View {
        Stepper(L.t("native_settings_repo_maxauto") + ": \(config.maxAuto)", value: Binding(
            get: { config.maxAuto }, set: { save(.init(maxAuto: $0)) }), in: 1...20)
        Stepper(L.t("native_settings_repo_usageceilingpct") + ": \(Int(config.usageCeilingPct))%", value: Binding(
            get: { config.usageCeilingPct }, set: { save(.init(usageCeilingPct: $0)) }), in: 0...100, step: 5)
        Picker(L.t("automation_sandbox_profile_label"), selection: Binding(
            get: { config.sandboxProfile }, set: { save(.init(sandboxProfile: $0)) })) {
            ForEach(RepoSettingsForm.sandboxOptions, id: \.self) { option in
                Text(verbatim: option == "inherit" ? L.t("native_repo_inherit_sandbox", config.sandboxDefaultProfile?.rawValue ?? "—") : option).tag(option)
            }
        }
        Toggle(L.t("native_settings_repo_sharedbrowserenabled"), isOn: Binding(
            get: { config.sharedBrowserEnabled }, set: { save(.init(sharedBrowserEnabled: $0)) }))
        Toggle(L.t("native_settings_repo_hidden"), isOn: Binding(
            get: { config.hidden }, set: { save(.init(hidden: $0)) }))
        Picker(L.t("automation_preview_open_mode_label"), selection: Binding(
            get: { config.previewOpenMode }, set: { save(.init(previewOpenMode: $0)) })) {
            Text(L.t("preview_open_mode_ask")).tag("ask")
            Text(L.t("preview_open_mode_inline")).tag("inline")
            Text(L.t("preview_open_mode_tab")).tag("tab")
        }
    }
}
