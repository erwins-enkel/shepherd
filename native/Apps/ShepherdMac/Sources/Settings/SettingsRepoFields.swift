import SwiftUI
import Observation
import ShepherdKit

struct SettingsRepoFields: View {
    let config: RepoConfig
    let save: (RepoConfigPatch, @escaping @MainActor (RepoConfig) -> Void) -> Void
    var body: some View {
        Group {
            Toggle(L.t("native_settings_repo_criticenabled"),isOn:Binding(get:{config.criticEnabled},set:{request(.init(criticEnabled:$0))}))
            Toggle(L.t("native_settings_repo_criticallprs"),isOn:Binding(get:{config.criticAllPrs},set:{request(.init(criticAllPrs:$0))}))
            Toggle(L.t("native_settings_repo_criticsmelllensenabled"),isOn:Binding(get:{config.criticSmellLensEnabled},set:{request(.init(criticSmellLensEnabled:$0))}))
            Toggle(L.t("native_settings_repo_autoaddressenabled"),isOn:Binding(get:{config.autoAddressEnabled},set:{request(.init(autoAddressEnabled:$0))}))
            Toggle(L.t("native_settings_repo_learningsenabled"),isOn:Binding(get:{config.learningsEnabled},set:{request(.init(learningsEnabled:$0))}))
            Toggle(L.t("native_settings_repo_autopilotenabled"),isOn:Binding(get:{config.autopilotEnabled},set:{request(.init(autopilotEnabled:$0))}))
            Toggle(L.t("native_settings_repo_plangateenabled"),isOn:Binding(get:{config.planGateEnabled},set:{request(.init(planGateEnabled:$0))}))
            Toggle(L.t("native_settings_repo_autodrainenabled"),isOn:Binding(get:{config.autoDrainEnabled},set:{request(.init(autoDrainEnabled:$0))}))
            Toggle(L.t("native_settings_repo_automergeenabled"),isOn:Binding(get:{config.autoMergeEnabled},set:{request(.init(autoMergeEnabled:$0))}))
            Toggle(L.t("native_settings_repo_buildqueueenabled"),isOn:Binding(get:{config.buildQueueEnabled},set:{request(.init(buildQueueEnabled:$0))}))
            Toggle(L.t("native_settings_repo_draftmode"),isOn:Binding(get:{config.draftMode},set:{request(.init(draftMode:$0))}))
            Toggle(L.t("native_settings_repo_autooptimizeflagged"),isOn:Binding(get:{config.autoOptimizeFlagged},set:{request(.init(autoOptimizeFlagged:$0))}))
            Toggle(L.t("native_settings_repo_manualstepsissueenabled"),isOn:Binding(get:{config.manualStepsIssueEnabled},set:{request(.init(manualStepsIssueEnabled:$0))}))
            Toggle(L.t("native_settings_repo_prewarmepiclandingci"),isOn:Binding(get:{config.preWarmEpicLandingCi},set:{request(.init(preWarmEpicLandingCi:$0))}))
            Toggle(L.t("native_settings_repo_epicstacksenabled"),isOn:Binding(get:{config.epicStacksEnabled},set:{request(.init(epicStacksEnabled:$0))}))
            Toggle(L.t("native_settings_repo_hidden"),isOn:Binding(get:{config.hidden},set:{request(.init(hidden:$0))}))
            textRow("native_settings_repo_maxauto", value: { String($0.maxAuto) }) {
                guard let value = Int($0) else { return nil }; return .init(maxAuto: value)
            }
            textRow("native_settings_repo_usageceilingpct", value: { String($0.usageCeilingPct) }) {
                guard let value = Double($0), value.isFinite else { return nil }
                return .init(usageCeilingPct: value)
            }
            textRow("native_settings_repo_signoffauthority", value: { $0.signoffAuthority }) { .init(signoffAuthority: $0) }
            textRow("native_settings_repo_autolabel", value: { $0.autoLabel }) { .init(autoLabel: $0) }
            textRow("native_settings_repo_sandboxprofile", value: { $0.sandboxProfile }) { .init(sandboxProfile: $0) }
            textRow("native_settings_repo_defaultmodel", value: { $0.defaultModel }) { .init(defaultModel: $0) }
            textRow("native_settings_repo_defaulteffort", value: { $0.defaultEffort }) { .init(defaultEffort: $0) }
            textRow("native_settings_repo_repomode", value: { $0.repoMode }) { .init(repoMode: $0) }
            textRow("native_settings_repo_previewopenmode", value: { $0.previewOpenMode }) { .init(previewOpenMode: $0) }
            textRow("native_settings_repo_previewstartscript", value: { $0.previewStartScript ?? "" }) { .init(previewStartScript: $0) }
            textRow("native_settings_repo_previewstartcommand", value: { $0.previewStartCommand ?? "" }) { .init(previewStartCommand: $0) }
            textRow("native_settings_repo_egressextrahosts", value: { $0.egressExtraHosts.joined(separator: ",") }) {
                .init(egressExtraHosts: $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
            }
        }
    }
    private func request(_ patch: RepoConfigPatch) { save(patch, { _ in }) }

    private func textRow(_ title: StaticString, value: @escaping (RepoConfig) -> String,
                         patch: @escaping (String) -> RepoConfigPatch?) -> some View {
        SettingsRepoTextRow(title: title, value: value(config)) { text, adopt in
            guard let body = patch(text) else { return }
            save(body) { adopt(value($0)) }
        }
    }
}

@Observable @MainActor final class SettingsRepoTextDraft {
    var text = ""
    func submit(_ save: (String, @escaping @MainActor (String) -> Void) -> Void) {
        save(text) { [weak self] in self?.text = $0 }
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
