import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// Settings › Workspace: the server-persisted default issue filter and its per-repo exceptions (#3021).
struct SettingsIssueFilterSection: View {
    let settings: IssueFilterSettingsModel
    let repos: [Repo]
    @State private var newLabel = ""

    var body: some View {
        if let filter = settings.value {
            defaults(filter)
            overrides
        } else {
            Section {
                Text(L.t("settings_issue_filter_unavailable")).foregroundStyle(.secondary)
            } header: { Text(L.t("settings_issue_filter_title")) }
        }
    }

    private func defaults(_ filter: IssueFilterSettings) -> some View {
        Section {
            Text(L.t("settings_issue_filter_summary")).font(.caption).foregroundStyle(.secondary)
            Picker(L.t("upnext_filter_scope_heading"), selection: Binding(
                get: { filter.scope }, set: { _ = settings.update(.init(scope: $0)) })) {
                ForEach(IssueFilterSettings.Scope.allCases, id: \.self) { Text(verbatim: $0.label).tag($0) }
            }
            .help(L.t("settings_issue_filter_scope_desc"))
            .accessibilityIdentifier("settings-issue-filter-scope")
            Picker(L.t("upnext_filter_forks_heading"), selection: Binding(
                get: { filter.forks }, set: { _ = settings.update(.init(forks: $0)) })) {
                ForEach(IssueFilterSettings.Forks.allCases, id: \.self) { Text(verbatim: $0.label).tag($0) }
            }
            .help(L.t("settings_issue_filter_forks_desc"))
            .accessibilityIdentifier("settings-issue-filter-forks")
            Toggle(L.t("issues_filter_active_label"), isOn: Binding(
                get: { filter.hideActive }, set: { _ = settings.update(.init(hideActive: $0)) }))
                .help(L.t("issues_filter_active_title"))
                .accessibilityIdentifier("settings-issue-filter-hide-active")
            Toggle(L.t("issues_filter_subissues_label"), isOn: Binding(
                get: { filter.hideSubIssues }, set: { _ = settings.update(.init(hideSubIssues: $0)) }))
                .help(L.t("issues_filter_subissues_title"))
                .accessibilityIdentifier("settings-issue-filter-hide-subissues")
            Toggle(L.t("issues_filter_blocked_label"), isOn: Binding(
                get: { filter.hideBlocked }, set: { _ = settings.update(.init(hideBlocked: $0)) }))
                .help(L.t("issues_filter_blocked_title"))
                .accessibilityIdentifier("settings-issue-filter-hide-blocked")
            LabeledContent(L.t("upnext_filter_labels_heading")) {
                VStack(alignment: .leading, spacing: 6) {
                    if filter.hiddenLabels.isEmpty {
                        Text(L.t("settings_issue_filter_labels_none")).foregroundStyle(.secondary)
                    } else {
                        HStack(spacing: 6) {
                            ForEach(filter.hiddenLabels, id: \.self) { label in labelToken(label, filter: filter) }
                        }
                    }
                    HStack {
                        TextField(L.t("settings_issue_filter_label_placeholder"), text: $newLabel)
                            .accessibilityLabel(L.t("settings_issue_filter_label_input_aria"))
                            .accessibilityIdentifier("settings-issue-filter-label-input")
                            .onSubmit { addLabel(filter) }
                        Button(L.t("settings_issue_filter_add_label")) { addLabel(filter) }
                            .disabled(newLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("settings-issue-filter-label-add")
                    }
                }
            }
            .help(L.t("settings_issue_filter_labels_desc"))
        } header: { Text(L.t("settings_issue_filter_title")) }
    }

    private func labelToken(_ label: String, filter: IssueFilterSettings) -> some View {
        HStack(spacing: 3) {
            Text(verbatim: label)
            Button {
                _ = settings.update(.init(hiddenLabels: filter.hiddenLabels.filter { $0 != label }))
            } label: { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain)
                .accessibilityLabel(L.t("settings_issue_filter_remove_label", label))
        }
        .font(.caption)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(.quaternary, in: Capsule())
        .accessibilityIdentifier("settings-issue-filter-label-\(label)")
    }

    private func addLabel(_ filter: IssueFilterSettings) {
        let label = newLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { return }
        newLabel = ""
        guard !filter.isHidden(label: label) else { return }
        _ = settings.update(.init(hiddenLabels: filter.hiddenLabels + [label]))
    }

    private var overrides: some View {
        Section {
            Text(L.t("settings_repo_overrides_summary")).font(.caption).foregroundStyle(.secondary)
            if repos.isEmpty {
                Text(L.t("settings_repo_overrides_none")).foregroundStyle(.secondary)
            } else {
                HStack {
                    Text(L.t("settings_repo_overrides_col_repo"))
                    Spacer()
                    Text(L.t("settings_repo_overrides_col_rule"))
                }
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(repos, id: \.path) { repo in overrideRow(repo) }
            }
        } header: { Text(L.t("settings_repo_overrides_title")) }
    }

    private func overrideRow(_ repo: Repo) -> some View {
        let current = settings.override(for: repo)
        return HStack {
            Text(verbatim: repo.display)
            if repo.isFork {
                Text(L.t("upnext_filter_tag_fork")).font(.caption)
                    .padding(.horizontal, 5).background(.quaternary, in: Capsule())
            }
            Spacer()
            Picker(L.t("settings_repo_overrides_select_aria", repo.display), selection: Binding(
                get: { current }, set: { _ = settings.setOverride($0, for: repo) })) {
                Text(L.t("settings_repo_overrides_opt_standard")).tag(nil as IssueFilterSettings.RepoOverride?)
                ForEach(IssueFilterSettings.RepoOverride.allCases, id: \.self) {
                    Text(verbatim: $0.label).tag(Optional($0))
                }
            }
            .labelsHidden()
            .fixedSize()
        }
        .padding(.horizontal, 4).padding(.vertical, 2)
        .background(current == nil ? AnyShapeStyle(.clear) : AnyShapeStyle(.tint.opacity(0.12)),
                    in: RoundedRectangle(cornerRadius: 6))
        .help(current == nil ? "" : L.t("settings_repo_overrides_differs"))
        .accessibilityValue(current == nil ? "" : L.t("settings_repo_overrides_differs"))
        .accessibilityIdentifier("settings-repo-override-\(repo.path)")
    }
}
