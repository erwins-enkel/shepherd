import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct IOSRepoResolutionSheet: View {
    @Bindable var model: IOSRepoSettingsModel
    let merging: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                if merging, let merge = model.merge {
                    Section {
                        Text(L.t("native_repo_merge_hint"))
                        if !merge.project.differences.complete { Text(L.t("native_repo_merge_incomplete")) }
                    }
                    ForEach(merge.differingFields, id: \.self) { field in
                        Section(IOSRepoSettingsView.fieldName(field)) {
                            Picker(IOSRepoSettingsView.fieldName(field), selection: Binding(
                                get: { model.merge?.selections[field] ?? "" },
                                set: { model.merge?.selections[field] = $0 })) {
                                Text(L.t("native_repo_choose_machine")).tag("")
                                ForEach(merge.project.machines.filter { merge.value(field, machine: $0.instanceId) != nil }, id: \.instanceId) { machine in
                                    Text(verbatim: "\(machine.name) · \(display(merge.value(field, machine: machine.instanceId)?.description ?? ""))")
                                        .tag(machine.instanceId)
                                }
                            }.pickerStyle(.inline)
                        }
                    }
                    DisclosureGroup(L.t("native_repo_equal_rules", String(merge.equalFields.count))) {
                        ForEach(merge.equalFields, id: \.self) { field in
                            LabeledContent(IOSRepoSettingsView.fieldName(field), value:
                                display(merge.value(field, machine: merge.project.referenceInstanceId ?? "")?.description ?? "—"))
                        }
                    }
                    if merge.needsLeader {
                        if merge.project.differences.multipleAutoDrain.count > 1 { Text(L.t("native_repo_multiple_drain")) }
                        leaderSection
                    }
                } else {
                    leaderSection
                }
                Section {
                    Text(L.t("native_repo_commit_effect"))
                    if let writer = model.project?.machines.first(where: { $0.instanceId == model.writerID }) {
                        Text(verbatim: L.t("native_repo_writer", writer.name))
                    }
                    if let error = model.error { Text(verbatim: error).foregroundStyle(SessionListStyle.red) }
                    Button(L.t(merging ? "native_repo_merge_save" : "native_repo_switch_save")) {
                        Task {
                            let saved = merging ? await model.saveMerge() : await model.saveLeader()
                            if saved { dismiss(); await model.load() }
                        }
                    }.disabled(model.busy || model.writerID == nil || !ready)
                }
            }
            .disabled(model.busy)
            .sessionFont().scrollContentBackground(.hidden).background(SessionListStyle.background)
            .tint(SessionListStyle.amber)
            .navigationTitle(L.t(merging ? "native_repo_merge" : "native_repo_switch_leader"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button(L.t("common_close")) { dismiss() }.disabled(model.busy)
            } }
            .interactiveDismissDisabled(model.busy)
        }.preferredColorScheme(.dark)
    }

    private var ready: Bool {
        merging ? model.merge?.ready == true : !model.selectedLeader.isEmpty && model.selectedLeader != model.project?.leitrechner?.instanceId
    }

    private var leaderSection: some View {
        Section(L.t("native_repo_leader")) {
            if model.project?.leitrechner?.reachable == false { Text(L.t("native_repo_jobs_paused")) }
            Picker(L.t("native_repo_leader"), selection: Binding(
                get: { merging ? model.merge?.leader ?? "" : model.selectedLeader },
                set: { if merging { model.merge?.leader = $0 } else { model.selectedLeader = $0 } })) {
                Text(L.t("native_repo_choose_machine")).tag("")
                ForEach(model.project?.machines.filter { $0.membership.value1 != .absent } ?? [], id: \.instanceId) { machine in
                    Text(verbatim: "\(machine.name) · \(model.reachability(machine))")
                        .tag(machine.instanceId).disabled(!machine.reachable || machine.config == nil)
                }
            }.pickerStyle(.inline)
            Text(L.t("native_repo_leader_returns"))
        }
    }

    private func display(_ value: String) -> String {
        if value == "1" { return L.t("native_repo_on") }
        if value == "0" { return L.t("native_repo_off") }
        return value
    }
}
