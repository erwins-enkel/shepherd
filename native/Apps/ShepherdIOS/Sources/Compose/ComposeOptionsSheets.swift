import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct ComposeContextSheet: View {
    @Bindable var model: ComposeModel
    let repos: [Repo]
    var body: some View {
        Form {
            Picker(L.t("newtask_repo_label"), selection: $model.repoPath) {
                ForEach(repos, id: \.path) { repo in Text(verbatim: repo.name).tag(repo.path) }
            }.accessibilityIdentifier("compose.repo")
            Picker(L.t("newtask_branch_label"), selection: Binding(get: { model.repoBranches.baseBranch }, set: { model.repoBranches.baseBranch = $0 })) {
                ForEach(model.repoBranches.baseOptions, id: \.self) { branch in Text(verbatim: branch).tag(branch) }
            }.accessibilityIdentifier("compose.branch")
            TextField(L.t("newtask_branch_placeholder"), text: Binding(get: { model.repoBranches.baseBranch }, set: { model.repoBranches.baseBranch = $0 })).textInputAutocapitalization(.never).autocorrectionDisabled()
            if model.repoBranches.baseMissing {
                Text(verbatim: L.t("newtask_readiness_base_missing"))
                Button(L.t("newtask_init_commit")) { Task { await model.repoBranches.repairInitialCommit() } }
                    .disabled(model.repoBranches.repairingBase)
            }
            if let error = model.repoBranches.error { Text(verbatim: error) }
        }.navigationTitle(L.t("newtask_repo_label"))
    }
}
struct ComposeEngineSheet: View {
    @Bindable var model: ComposeModel
    var body: some View {
        Form {
            Picker(L.t("newtask_agent_provider_label"), selection: Binding(get: { model.provider }, set: { model.selectProviderManually($0) })) {
                ForEach([AgentProvider.claude, .codex], id: \.self) { provider in
                    Text(verbatim: L.t(provider == .claude ? "agent_provider_claude" : "agent_provider_codex")).tag(provider).disabled(!model.allowsProvider(provider))
                }
            }.accessibilityIdentifier("compose.engine")
            Picker(L.t("newtask_model_label"), selection: $model.model) {
                ForEach(["default"] + ComposeRunConfig.providerModels(model.provider).filter { ComposeRunConfig.available($0, provider: model.provider, fableAvailable: model.runDefaults.fableAvailable) }, id: \.self) { value in
                    Text(verbatim: ModelGuidance.optionLabel(provider: model.provider, model: value)).tag(value)
                }
            }.accessibilityIdentifier("compose.model")
            Picker(L.t("newtask_effort_label"), selection: $model.effort) {
                ForEach(["default"] + ComposeRunConfig.providerEfforts(model.provider, model: model.model), id: \.self) { effort in
                    Text(verbatim: effortLabel(effort)).tag(effort)
                }
            }.accessibilityIdentifier("compose.effort")
            ForEach(Array(ComposeCapacity.rows(SessionSignals.usageLimits()).enumerated()), id: \.offset) { _, row in
                ForEach(row.windows, id: \.key) { window in
                    VStack(alignment: .leading) {
                        Text(verbatim: ComposeCapacity.code(row.provider, key: window.key) + " · " + window.copy())
                        ProgressView(value: window.remainingPct, total: 100).tint(window.tint)
                    }.opacity(row.opacity)
                }
            }
            Toggle(plain(L.t("newtask_guard_plan_gate")), isOn: Binding(get: { model.planGateEnabled }, set: { model.planGateEnabled = $0; model.planGateTouched = true }))
                .disabled(model.modeLocked).accessibilityIdentifier("compose.planGate")
            Toggle(plain(L.t("newtask_guard_autopilot")), isOn: Binding(get: { model.autopilotEnabled }, set: { model.autopilotEnabled = $0; model.autopilotTouched = true }))
                .disabled(model.modeLocked).accessibilityIdentifier("compose.autopilot")
            if let explanation = model.guardExplanation { Text(verbatim: plain(explanation)).font(.caption) }
            Picker(L.t("newtask_sandbox_label"), selection: $model.sandboxProfile) {
                Text(verbatim: L.t("newtask_sandbox_default")).tag(Optional<Components.Schemas.SandboxProfile>.none)
                Text(verbatim: L.t("sandbox_profile_trusted")).tag(Optional(Components.Schemas.SandboxProfile.trusted))
                Text(verbatim: L.t("sandbox_profile_standard")).tag(Optional(Components.Schemas.SandboxProfile.standard))
                Text(verbatim: L.t("sandbox_profile_autonomous")).tag(Optional(Components.Schemas.SandboxProfile.autonomous)).disabled(model.sandboxLocked)
            }.accessibilityIdentifier("compose.sandbox")
            Text(verbatim: L.t("newtask_sandbox_hint")).font(.caption)
            if model.provider == .codex { Text(verbatim: L.t("newtask_agent_provider_codex_alpha_note")).font(.caption) }
        }.navigationTitle(L.t("newtask_agent_provider_label"))
    }
    private func effortLabel(_ effort: String) -> String {
        switch effort {
        case "low": L.t("effort_label_low")
        case "medium": L.t("effort_label_medium")
        case "high": L.t("effort_label_high")
        case "xhigh": L.t("effort_label_xhigh")
        case "max": L.t("effort_label_max")
        case "ultra": L.t("effort_label_ultra")
        default: L.t("effort_default")
        }
    }
    private func plain(_ text: String) -> String { text.replacingOccurrences(of: #"\[\[[^|\[\]]+\|([^\[\]]+)\]\]"#, with: "$1", options: .regularExpression) }
}
struct ComposeSourceSheet: View {
    @Bindable var model: ComposeModel
    let commands: Bool
    let dismiss: () -> Void
    @State private var query = ""
    var body: some View {
        List {
            if !commands {
                DisclosureGroup(L.t("issue_filter_heading")) {
                    Toggle(L.t("issues_filter_mine_label"), isOn: $model.filter.hideOthers)
                    Toggle(L.t("issues_filter_active_label"), isOn: $model.filter.hideActive)
                    Toggle(L.t("issues_filter_subissues_label"), isOn: $model.filter.hideSubIssues)
                    Toggle(L.t("issues_filter_blocked_label"), isOn: $model.filter.hideBlocked)
                    Picker(L.t("issues_filter_author_heading"), selection: $model.filter.author) {
                        Text(verbatim: L.t("issues_filter_author_all")).tag(nil as String?)
                        ForEach(model.authors, id: \.self) { Text(verbatim: $0).tag(Optional($0)) }
                    }
                    ForEach(model.labels, id: \.self) { label in
                        Toggle(isOn: Binding(get: { model.filter.labels.contains(label) }, set: { if $0 { model.filter.labels.insert(label) } else { model.filter.labels.remove(label) } })) { Text(verbatim: label) }
                    }
                }
            }
            if model.loading { ProgressView().accessibilityLabel(L.t("common_loading")) }
            else if commands {
                if let error = model.commandsError { Text(verbatim: error) }
                let options = ComposeModel.commandMatches(model.commands, query: query)
                if options.isEmpty { Text(verbatim: L.t("promptsources_no_commands")) }
                ForEach(Array(options.enumerated()), id: \.offset) { _, command in
                    Button {
                        model.pickCommand(command, caret: model.prompt.endIndex); dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(verbatim: command.displayName ?? command.name)
                            Text(verbatim: command.description).font(.caption).foregroundStyle(.secondary)
                        }.frame(minHeight: 44)
                    }.disabled(!ComposeModel.isInsertable(command))
                    .accessibilityIdentifier("compose.command.\(command.name)")
                }
            } else if model.issuesFailed { Text(verbatim: L.t("common_issues_load_failed")) }
            else if model.listing?.slug == nil { Text(verbatim: L.t("promptsources_no_github")) }
            else {
                let visible = model.filteredIssues.visible.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || String($0.number).contains(query.replacingOccurrences(of: "#", with: "")) }
                if visible.isEmpty { Text(verbatim: model.filteredIssues.emptiedBy?.message ?? L.t("issuespanel_no_match")) }
                ForEach(visible, id: \.number) { issue in
                    Button {
                        if ComposeModel.trigger(in: model.prompt, caret: model.prompt.endIndex)?.symbol == "#" { model.pickIssueFromSearch(issue, caret: model.prompt.endIndex) }
                        else { model.pickIssue(issue) }
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(verbatim: "#\(issue.number) · \(issue.title)")
                            if model.epicParents.contains(issue.number) { Label(L.t("upnext_pill_epic"), systemImage: "square.stack.3d.up").font(.caption) }
                            Text(verbatim: issue.labels.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                        }.frame(minHeight: 44)
                    }.accessibilityIdentifier("compose.issue.\(issue.number)")
                }
            }
        }.searchable(text: $query, prompt: L.t(commands ? "promptsources_commands_filter" : "promptsources_filter_placeholder"))
            .navigationTitle(L.t("promptsources_title"))
            .task { await model.loadSources(); if commands { await model.loadCommands() } }
    }
}
