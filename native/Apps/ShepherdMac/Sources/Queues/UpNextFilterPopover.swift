import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// Up Next's default-filter popover (#3021). Every change writes the server-persisted
/// `issueFilter` setting; the per-option counts are the snapshot's `optionCounts`.
struct UpNextFilterPopover: View {
    let settings: IssueFilterSettingsModel
    let summary: UpNextFilterSummary?
    let snapshot: UpNextSnapshot?

    var body: some View {
        let filter = settings.effective
        let labels = UpNextFilterPresentation.labelOptions(snapshot, hidden: filter.hiddenLabels)
        let forkRepos = UpNextFilterPresentation.forkRepos(snapshot)
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(L.t("upnext_filter_title")).font(.headline)
                Text(verbatim: UpNextFilterPresentation.summary(filter))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Picker(L.t("upnext_filter_scope_heading"), selection: Binding(
                get: { filter.scope }, set: { _ = settings.update(.init(scope: $0)) })) {
                ForEach(IssueFilterSettings.Scope.allCases, id: \.self) { scope in
                    option(scope.label, count: summary?.count(scope)).tag(scope)
                }
            }
            .pickerStyle(.radioGroup)
            .accessibilityIdentifier("queues-upnext-filter-scope")
            Picker(L.t("upnext_filter_forks_heading"), selection: Binding(
                get: { filter.forks }, set: { _ = settings.update(.init(forks: $0)) })) {
                ForEach(IssueFilterSettings.Forks.allCases, id: \.self) { forks in
                    option(forks.label, count: summary?.count(forks)).tag(forks)
                }
            }
            .pickerStyle(.radioGroup)
            .accessibilityIdentifier("queues-upnext-filter-forks")
            if !forkRepos.isEmpty {
                Text(L.t("upnext_filter_forks_repos", forkRepos.joined(separator: ", ")))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(L.t("upnext_filter_labels_heading")).font(.subheadline.weight(.semibold))
            if labels.isEmpty {
                Text(L.t("upnext_filter_labels_none")).font(.caption).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(labels, id: \.self) { label in
                            Toggle(isOn: Binding(get: { filter.isHidden(label: label) }, set: { _ in
                                _ = settings.update(.init(hiddenLabels: settings.effective.toggledLabels(label)))
                            })) { Text(verbatim: label) }
                                .toggleStyle(.checkbox)
                                .accessibilityLabel(L.t("upnext_filter_label_toggle_aria", label))
                                .accessibilityIdentifier("queues-upnext-filter-label-\(label)")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 140)
            }
            Divider()
            HStack {
                Button(L.t("upnext_filter_reset")) { _ = settings.reset() }
                    .disabled(filter.scope == IssueFilterSettings.defaults.scope && filter.forks == .all
                              && filter.hiddenLabels.isEmpty)
                    .accessibilityIdentifier("queues-upnext-filter-reset")
                Spacer()
                Button(L.t("upnext_filter_repo_overrides")) { SettingsPresentation.shared.requestPane("workspace") }
                    .buttonStyle(.link)
                    .accessibilityIdentifier("queues-upnext-filter-overrides")
            }
        }
        .padding(14)
        .frame(width: 320)
        .accessibilityIdentifier("queues-upnext-filter-popover")
    }

    private func option(_ title: String, count: Int?) -> some View {
        Text(verbatim: count.map { "\(title)  ·  \($0)" } ?? title)
    }
}
