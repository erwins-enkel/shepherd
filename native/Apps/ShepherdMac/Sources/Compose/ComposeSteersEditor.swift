import ShepherdKit
import SwiftUI

/// Edits generated values, preserving every scope field when saving the whole list.
struct ComposeSteersEditor: View {
    @Bindable var actions: ComposeActions
    let repos: [Repo]

    var body: some View {
        VStack(alignment: .leading) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if actions.steers.isEmpty { Text(verbatim: L.t("steerseditor_empty")) }
                    ForEach(actions.steers.indices, id: \.self) { index in
                        row(index)
                    }
                }
            }.frame(minHeight: 200, maxHeight: 450)
            Button(L.t("steerseditor_add")) {
                actions.steers.append(.init(id: UUID().uuidString, label: "", text: "", inSteerBar: true, onIssues: false))
            }.disabled(actions.steers.count >= 40)
        }
        .disabled(actions.busy)
    }

    private func row(_ index: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField(L.t("steerseditor_field_emoji"), text: Binding(
                    get: { actions.steers[index].emoji ?? "" },
                    set: { actions.steers[index].emoji = $0.isEmpty ? nil : $0 }))
                    .frame(width: 70)
                TextField(L.t("steerseditor_label_aria"), text: $actions.steers[index].label)
                Button { actions.steers.swapAt(index, index - 1) } label: { Image(systemName: "arrow.up") }
                    .disabled(index == 0).accessibilityLabel(L.t("native_compose_steer_up"))
                Button { actions.steers.swapAt(index, index + 1) } label: { Image(systemName: "arrow.down") }
                    .disabled(index == actions.steers.count - 1).accessibilityLabel(L.t("native_compose_steer_down"))
                Button(role: .destructive) { actions.steers.remove(at: index) } label: { Image(systemName: "trash") }
                    .accessibilityLabel(L.t("steerseditor_remove"))
            }
            TextEditor(text: $actions.steers[index].text).frame(height: 85)
                .accessibilityLabel(L.t("steerseditor_text_aria"))
            HStack {
                Toggle(L.t("steerseditor_placement_bar"), isOn: $actions.steers[index].inSteerBar)
                Toggle(L.t("steerseditor_placement_issues"), isOn: $actions.steers[index].onIssues)
            }
            if !actions.steers[index].inSteerBar && !actions.steers[index].onIssues {
                Text(verbatim: L.t("steerseditor_scope_none_error")).foregroundStyle(.red).font(.caption)
            }
            HStack {
                Menu(L.t("newtask_repo_label")) {
                    Button(L.t("steerseditor_repos_all")) { actions.steers[index].repos = nil }
                    ForEach(Array(Set(repos.map(\.name) + (actions.steers[index].repos ?? []))).sorted(), id: \.self) { name in
                        Toggle(isOn: Binding(get: { actions.steers[index].repos?.contains(name) ?? false }, set: { enabled in
                            var names = actions.steers[index].repos ?? []
                            names.removeAll { $0 == name }; if enabled { names.append(name) }
                            actions.steers[index].repos = names.isEmpty ? nil : names
                        })) { Text(verbatim: name) }
                    }
                }
                Text(verbatim: actions.steers[index].repos?.joined(separator: ", ") ?? L.t("steerseditor_repos_all"))
                    .font(.caption)
                Picker(L.t("newtask_agent_provider_label"), selection: Binding(
                    get: { actions.steers[index].agentProviders?.count == 1 ? actions.steers[index].agentProviders![0].rawValue : "all" },
                    set: { value in actions.steers[index].agentProviders = value == "all" ? nil : [value == "codex" ? .codex : .claude] })) {
                    Text(verbatim: L.t("steerseditor_scope_all_short")).tag("all")
                    Text(verbatim: EnginePicker.name(.claude)).tag("claude")
                    Text(verbatim: EnginePicker.name(.codex)).tag("codex")
                }
            }
        }
        .padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }
}
