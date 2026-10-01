import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// Panel lenses retain their web meaning; iOS offers metadata, not session mutations.
struct IOSUpNextRows: View {
    let model: QueuesModel?
    let repos: Set<String>
    @State private var sort: UpNextSort = .newest
    @State private var expanded: Set<String> = []
    var body: some View {
        let groups = UpNextPresentation.groups(model?.upNext, sort: sort, repos: repos)
        Picker(L.t("upnext_sort_aria"), selection: $sort) {
            ForEach(UpNextSort.allCases, id: \.self) { Text(verbatim: $0.label).tag($0) }
        }
        .sessionFont().listRowBackground(SessionListStyle.panel)
        if model?.upNext == nil {
            Text(L.t("native_ios_next_waiting")).sessionFont().foregroundStyle(SessionListStyle.muted)
                .listRowBackground(SessionListStyle.background)
        } else {
            switch UpNextPresentation.phase(model?.upNext, failed: model?.upNextLoadFailed ?? false, groups: groups) {
            case .failed: Text(L.t("common_issues_load_failed"))
            case .empty: Text(repos.isEmpty ? L.t("upnext_empty")
                : L.t("upnext_repo_filter_empty", repos.sorted().map(DonePresentation.repoBasename).joined(separator: ", ")))
            case .computing: ProgressView(L.t("common_loading"))
            case .ready: EmptyView()
            }
            ForEach(groups) { group in
                Text(verbatim: group.title).sessionFont(weight: .semibold)
                    .foregroundStyle(SessionListStyle.bright).listRowBackground(SessionListStyle.background)
                ForEach(group.shown(expanded: expanded.contains(group.id)).map(IOSNextItem.init)) { row in
                    let item = row.item
                    VStack(alignment: .leading, spacing: 6) {
                        Text(verbatim: "#\(item.number) \(item.title)").sessionFont(weight: .semibold)
                        Text(verbatim: item.repoLabel).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                        if item.priority { Text(L.t("upnext_pill_priority")).sessionFont(label: true).foregroundStyle(SessionListStyle.amber) }
                    }
                    .padding(.vertical, 6).listRowBackground(SessionListStyle.panel)
                    .accessibilityIdentifier("queues-upnext-row-\(UpNextPresentation.key(item))")
                }
                if group.items.count > group.cap {
                    Button(expanded.contains(group.id) ? L.t("upnext_show_less") : L.t("upnext_show_all", String(group.totalCount))) {
                        if !expanded.insert(group.id).inserted { expanded.remove(group.id) }
                    }.sessionFont().listRowBackground(SessionListStyle.background)
                }
            }
        }
    }
}

private struct IOSNextItem: Identifiable {
    let item: UpNextItem
    var id: String { UpNextPresentation.key(item) }
}

struct IOSOwedRows: View {
    let records: [PostMergeSteps]
    let model: MergeModel?
    let select: (String) -> Void
    @Environment(AppModel.self) private var app
    var body: some View {
        if model?.settled != true { ProgressView(L.t("common_loading")) }
        if let error = model?.error { Text(verbatim: error).foregroundStyle(SessionListStyle.red) }
        if model?.settled == true, model?.error == nil, records.isEmpty {
            Text(L.t("owed_empty")).sessionFont().foregroundStyle(SessionListStyle.muted)
                .listRowBackground(SessionListStyle.background)
        }
        ForEach(records, id: \.sessionId) { record in
            VStack(alignment: .leading, spacing: 8) {
                if app.store?.session(id: record.sessionId) != nil {
                    Button { select(record.sessionId) } label: {
                        Text(verbatim: "\(record.desig) · \(record.prTitle)").sessionFont(weight: .semibold)
                    }.buttonStyle(.plain)
                } else { Text(verbatim: "\(record.desig) · \(record.prTitle)").sessionFont(weight: .semibold) }
                Text(verbatim: DonePresentation.repoBasename(record.repoPath)).sessionFont(label: true)
                    .foregroundStyle(SessionListStyle.muted)
                ForEach(record.steps, id: \.id) { step in
                    Label {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: step.text).strikethrough(step.doneAt != nil)
                            if step.postMerge { Text(L.t("owed_post_merge_badge")).foregroundStyle(SessionListStyle.blue) }
                        }
                    } icon: { Image(systemName: step.doneAt == nil ? "square" : "checkmark.square") }
                    .sessionFont()
                }
            }
            .padding(.vertical, 8).listRowBackground(SessionListStyle.panel)
            .accessibilityIdentifier("queues-owed-row-\(record.sessionId)")
        }
    }
}
