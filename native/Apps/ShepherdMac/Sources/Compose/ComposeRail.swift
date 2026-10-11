import ShepherdAppCore
import ShepherdKit
import SwiftUI

struct ComposeRail: View {
    @Bindable var model: ComposeModel
    let holdLikely: Bool
    let repoConfig: RepoConfig?
    let repoConfigLoading: Bool
    let retryRepoDefaults: () -> Void
    let openAutomation: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                ComposeSectionLabel(key: "newtask_group_mode")
                ModeTabs(model: model)
                    .modifier(ComposeKeycap(ids: ["mode-code", "mode-research", "mode-epic", "mode-plain"]))
                Text(verbatim: ModeTabs.caption(model.mode)).font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).help(ModeTabs.caption(model.mode))
            }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                ComposeSectionLabel(key: "newtask_group_engine")
                EnginePicker(model: model).modifier(ComposeKeycap(ids: ["engine"]))
                CapacityLine(provider: model.provider)
                ModelPicker(model: model).modifier(ComposeKeycap(ids: ["model"]))
                HStack(alignment: .top, spacing: 12) {
                    EffortPicker(model: model).frame(maxWidth: .infinity)
                    SandboxPicker(model: model).frame(maxWidth: .infinity)
                }
                if model.research {
                    Text(verbatim: L.t("newtask_research_sandbox_note")).font(.caption).foregroundStyle(.secondary)
                }
                CodexAlphaWarning(provider: model.provider, holdLikely: holdLikely).font(.caption)
            }
            if !model.modeLocked {
                Divider()
                GuardToggles(model: model, repoConfig: repoConfig, repoConfigLoading: repoConfigLoading, retryRepoDefaults: retryRepoDefaults, openAutomation: openAutomation)
            }
        }
        .pickerStyle(.menu)
    }
}

struct ComposeSectionLabel: View {
    let key: StaticString
    var body: some View {
        Text(verbatim: L.t(key).uppercased()).font(.caption.weight(.semibold))
            .tracking(1.5).foregroundStyle(.secondary)
    }
}
