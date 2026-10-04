import SwiftUI
import ShepherdAppCore
import ShepherdKit

enum IOSMergedQueuePresentation {
    struct Source { let profile: ServerProfile; let snapshot: UpNextSnapshot? }
    struct Row: Identifiable {
        let profile: ServerProfile
        let item: UpNextItem
        var id: String { "\(profile.id):\(UpNextPresentation.key(item))" }
    }
    struct Group: Identifiable {
        let id: String
        let title: String
        var rows: [Row]
        var totalCount: Int
        let cap: Int
    }
    static func groups(_ sources: [Source], sort: UpNextSort, repos: Set<String>) -> [Group] {
        var order: [String] = [], result: [String: Group] = [:]
        for source in sources {
            for group in UpNextPresentation.groups(source.snapshot, sort: sort, repos: repos) {
                let id = sort == .recommended ? (group.id.hasSuffix(":priority") ? "priority" : "repo:\(group.items.first?.repoPath ?? group.id)") : group.id
                if result[id] == nil {
                    order.append(id)
                    result[id] = Group(id: id, title: group.title, rows: [], totalCount: 0, cap: group.cap)
                }
                result[id]?.rows += group.items.map { Row(profile: source.profile, item: $0) }
                result[id]?.totalCount += group.totalCount
            }
        }
        return order.sorted { a, b in
            if a == "priority" { return b != "priority" }; if b == "priority" { return false }
            return order.firstIndex(of: a)! < order.firstIndex(of: b)!
        }.compactMap { id in
            guard var group = result[id] else { return nil }
            if sort != .recommended {
                group.rows = group.rows.enumerated().sorted { left, right in
                    let a = left.element.item, b = right.element.item
                    switch sort {
                    case .newest where a.createdAt != b.createdAt: return a.createdAt > b.createdAt
                    case .oldest where a.createdAt != b.createdAt: return a.createdAt < b.createdAt
                    case .titleAscending, .titleDescending:
                        let comparison = a.title.localizedCompare(b.title)
                        if comparison != .orderedSame { return comparison == (sort == .titleAscending ? .orderedAscending : .orderedDescending) }
                    default: break
                    }
                    for (a, b) in [(a.repoLabel, b.repoLabel), (a.repoPath, b.repoPath)] {
                        let comparison = a.localizedCompare(b)
                        if comparison != .orderedSame { return comparison == .orderedAscending }
                    }
                    return a.number == b.number ? left.offset < right.offset : a.number < b.number
                }.map(\.element)
            }
            return group
        }
    }
}

struct IOSMergedNextRows: View {
    let hub: IOSServerHub
    let repos: Set<String>
    @State private var sort: UpNextSort = .newest
    @State private var expanded: Set<String> = []
    var body: some View {
        let sources = hub.connected.compactMap { app -> IOSMergedQueuePresentation.Source? in
            app.activeProfile.map { .init(profile: $0, snapshot: app.extension(QueuesModel.self)?.upNext) }
        }
        let groups = IOSMergedQueuePresentation.groups(sources, sort: sort, repos: repos)
        Picker(L.t("upnext_sort_aria"), selection: $sort) {
            ForEach(UpNextSort.allCases, id: \.self) { Text(verbatim: $0.label).tag($0) }
        }.sessionFont().listRowBackground(SessionListStyle.panel)
        if groups.isEmpty {
            if hub.connected.contains(where: { $0.extension(QueuesModel.self)?.upNextLoadFailed == true || (($0.extension(QueuesModel.self)?.upNext?.failedRepoCount ?? 0) > 0 && $0.extension(QueuesModel.self)?.upNext?.sections.isEmpty == true) }) {
                Text(L.t("common_issues_load_failed"))
            } else if sources.contains(where: { $0.snapshot == nil }) {
                Text(L.t("native_ios_next_waiting"))
            } else { Text(L.t("upnext_empty")) }
        }
        ForEach(groups) { group in
            Text(verbatim: group.title).sessionFont(weight: .semibold)
                .foregroundStyle(SessionListStyle.bright).listRowBackground(SessionListStyle.background)
            ForEach(expanded.contains(group.id) ? group.rows : Array(group.rows.prefix(group.cap))) { row in
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: "#\(row.item.number) \(row.item.title)").sessionFont(weight: .semibold)
                    Text(verbatim: row.item.repoLabel).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                    if row.item.priority { Text(L.t("upnext_pill_priority")).sessionFont(label: true).foregroundStyle(SessionListStyle.amber) }
                    if hub.connected.count > 1 { IOSServerHint(name: row.profile.name) }
                }.padding(.vertical, 6).listRowBackground(SessionListStyle.panel)
            }
            if group.rows.count > group.cap {
                Button(expanded.contains(group.id) ? L.t("upnext_show_less") : L.t("upnext_show_all", String(group.totalCount))) {
                    if !expanded.insert(group.id).inserted { expanded.remove(group.id) }
                }.sessionFont().listRowBackground(SessionListStyle.background)
            }
        }
    }
}

struct IOSMergedOwedRows: View {
    let rows: [IOSMergedSessionPresentation.OwedRow]
    let owners: [UUID: AppModel]
    let fallback: AppModel
    let showServers: Bool
    let select: (IOSSessionIdentity) -> Void
    var body: some View {
        let models = owners.isEmpty ? [fallback] : Array(owners.values)
        if models.contains(where: { $0.extension(MergeModel.self)?.settled != true }) { ProgressView(L.t("common_loading")) }
        ForEach(Array(models.enumerated()), id: \.offset) { _, app in
            if let error = app.extension(MergeModel.self)?.error { Text(verbatim: error).foregroundStyle(SessionListStyle.red) }
        }
        if rows.isEmpty, models.allSatisfy({ $0.extension(MergeModel.self)?.settled == true && $0.extension(MergeModel.self)?.error == nil }) {
            Text(L.t("owed_empty")).sessionFont().foregroundStyle(SessionListStyle.muted).listRowBackground(SessionListStyle.background)
        }
        ForEach(rows) { row in
            if showServers { IOSServerHint(name: row.profile.name).listRowBackground(SessionListStyle.background) }
            let app = owners[row.profile.id] ?? fallback
            IOSOwedRows(showState: false, records: [row.record], model: app.extension(MergeModel.self), select: { select(.init(profileID: row.profile.id, sessionID: $0)) })
                .environment(app)
        }
    }
}
