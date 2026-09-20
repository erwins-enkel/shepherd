import SwiftUI
import ShepherdKit

struct SettingsRepoFields: View {
    let config: RepoConfig
    let save: (RepoConfigPatch) -> Void
    var body: some View {
        Group {
            Toggle(L.t("native_settings_repo_criticenabled"),isOn:Binding(get:{config.criticEnabled},set:{save(.init(criticEnabled:$0))}))
            Toggle(L.t("native_settings_repo_criticallprs"),isOn:Binding(get:{config.criticAllPrs},set:{save(.init(criticAllPrs:$0))}))
            Toggle(L.t("native_settings_repo_criticsmelllensenabled"),isOn:Binding(get:{config.criticSmellLensEnabled},set:{save(.init(criticSmellLensEnabled:$0))}))
            Toggle(L.t("native_settings_repo_autoaddressenabled"),isOn:Binding(get:{config.autoAddressEnabled},set:{save(.init(autoAddressEnabled:$0))}))
            Toggle(L.t("native_settings_repo_learningsenabled"),isOn:Binding(get:{config.learningsEnabled},set:{save(.init(learningsEnabled:$0))}))
            Toggle(L.t("native_settings_repo_autopilotenabled"),isOn:Binding(get:{config.autopilotEnabled},set:{save(.init(autopilotEnabled:$0))}))
            Toggle(L.t("native_settings_repo_plangateenabled"),isOn:Binding(get:{config.planGateEnabled},set:{save(.init(planGateEnabled:$0))}))
            Toggle(L.t("native_settings_repo_autodrainenabled"),isOn:Binding(get:{config.autoDrainEnabled},set:{save(.init(autoDrainEnabled:$0))}))
            Toggle(L.t("native_settings_repo_automergeenabled"),isOn:Binding(get:{config.autoMergeEnabled},set:{save(.init(autoMergeEnabled:$0))}))
            Toggle(L.t("native_settings_repo_buildqueueenabled"),isOn:Binding(get:{config.buildQueueEnabled},set:{save(.init(buildQueueEnabled:$0))}))
            Toggle(L.t("native_settings_repo_draftmode"),isOn:Binding(get:{config.draftMode},set:{save(.init(draftMode:$0))}))
            Toggle(L.t("native_settings_repo_autooptimizeflagged"),isOn:Binding(get:{config.autoOptimizeFlagged},set:{save(.init(autoOptimizeFlagged:$0))}))
            Toggle(L.t("native_settings_repo_manualstepsissueenabled"),isOn:Binding(get:{config.manualStepsIssueEnabled},set:{save(.init(manualStepsIssueEnabled:$0))}))
            Toggle(L.t("native_settings_repo_prewarmepiclandingci"),isOn:Binding(get:{config.preWarmEpicLandingCi},set:{save(.init(preWarmEpicLandingCi:$0))}))
            Toggle(L.t("native_settings_repo_epicstacksenabled"),isOn:Binding(get:{config.epicStacksEnabled},set:{save(.init(epicStacksEnabled:$0))}))
            Toggle(L.t("native_settings_repo_hidden"),isOn:Binding(get:{config.hidden},set:{save(.init(hidden:$0))}))
            SettingsRepoTextRow(title:"native_settings_repo_maxauto",value:String(config.maxAuto)) { value in
                guard let parsed = Int(value) else {return}; save(.init(maxAuto:parsed))
            }
            SettingsRepoTextRow(title:"native_settings_repo_usageceilingpct",value:String(config.usageCeilingPct)) { value in
                guard let parsed = Double(value) else {return}; save(.init(usageCeilingPct:parsed))
            }
            SettingsRepoTextRow(title:"native_settings_repo_signoffauthority",value:config.signoffAuthority) {save(.init(signoffAuthority:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_autolabel",value:config.autoLabel) {save(.init(autoLabel:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_sandboxprofile",value:config.sandboxProfile) {save(.init(sandboxProfile:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_defaultmodel",value:config.defaultModel) {save(.init(defaultModel:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_defaulteffort",value:config.defaultEffort) {save(.init(defaultEffort:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_repomode",value:config.repoMode) {save(.init(repoMode:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_previewopenmode",value:config.previewOpenMode) {save(.init(previewOpenMode:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_previewstartscript",value:config.previewStartScript ?? "") {save(.init(previewStartScript:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_previewstartcommand",value:config.previewStartCommand ?? "") {save(.init(previewStartCommand:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_egressextrahosts",value:config.egressExtraHosts.joined(separator:",")) {
                save(.init(egressExtraHosts:$0.split(separator:",").map { $0.trimmingCharacters(in:.whitespaces) }))
            }
        }
    }
}
struct SettingsRepoTextRow: View {
    let title: StaticString
    let value: String
    let save: (String) -> Void
    @State private var draft = ""
    var body: some View {
        HStack {
            TextField(L.t(title),text:$draft)
            Button(L.t("common_save")) {save(draft)}.disabled(draft == value)
        }.onAppear {draft = value}.onChange(of:value) {draft = value}
    }
}
