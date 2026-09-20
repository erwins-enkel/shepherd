import Foundation
import Observation
import ShepherdKit
import SwiftUI

enum UpNextSort: String, CaseIterable {
    case recommended, newest, oldest
    case titleAscending = "title-asc"
    case titleDescending = "title-desc"

    static let storageKey = "run.shepherd.mac.upnext.sort"

    var label: String {
        switch self {
        case .recommended: L.t("upnext_sort_recommended")
        case .newest: L.t("upnext_sort_newest")
        case .oldest: L.t("upnext_sort_oldest")
        case .titleAscending: L.t("upnext_sort_title_asc")
        case .titleDescending: L.t("upnext_sort_title_desc")
        }
    }
}

struct UpNextGroup: Identifiable {
    let id: String
    let title: String
    let items: [UpNextItem]
    let totalCount: Int
    let cap: Int

    func shown(expanded: Bool) -> [UpNextItem] {
        expanded ? items : Array(items.prefix(cap))
    }
}

enum UpNextPresentation {
    enum Phase { case computing, failed, empty, ready }

    static func updated(_ milliseconds: Int, now: Date) -> String {
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .abbreviated
        formatter.allowedUnits = [.hour, .minute, .second]
        formatter.maximumUnitCount = 1
        let age = max(0, now.timeIntervalSince1970 - Double(milliseconds) / 1_000)
        return L.t("upnext_updated_ago", formatter.string(from: age) ?? "—")
    }

    static func key(_ item: UpNextItem) -> String { "\(item.repoPath)#\(item.number)" }

    static func labels(_ item: UpNextItem) -> [String] {
        item.labels.filter { $0 != "shepherd:priority" && !(item.kind.rawValue == "epic" && $0 == "epic") }
    }

    static func phase(_ snapshot: UpNextSnapshot?, failed: Bool, groups: [UpNextGroup]) -> Phase {
        if groups.contains(where: { !$0.items.isEmpty }) { return .ready }
        if failed || ((snapshot?.failedRepoCount ?? 0) > 0 && snapshot?.sections.isEmpty == true) {
            return .failed
        }
        return snapshot == nil ? .computing : .empty
    }

    static func groups(_ snapshot: UpNextSnapshot?, sort: UpNextSort,
                       repos: Set<String> = []) -> [UpNextGroup] {
        let sections = (snapshot?.sections ?? []).compactMap { section -> UpNextSection? in
            guard !repos.isEmpty else { return section }
            if section.kind.rawValue == "repo" {
                return section.repoPath.map(repos.contains) == true ? section : nil
            }
            var filtered = section
            filtered.items = section.items.filter { repos.contains($0.repoPath) }
            filtered.totalCount = filtered.items.count
            return filtered.items.isEmpty ? nil : filtered
        }
        if sort == .recommended {
            return sections.enumerated().map { index, section in
                let priority = section.kind.rawValue == "priority"
                return UpNextGroup(id: "section:\(index):\(section.repoPath ?? "priority")",
                    title: priority ? L.t("upnext_priority_section")
                        : section.repoLabel ?? DonePresentation.repoBasename(section.repoPath ?? ""),
                    items: section.items, totalCount: section.totalCount, cap: priority ? 10 : 5)
            }
        }
        let all = sections.flatMap(\.items)
        return [true, false].compactMap { priority in
            let items = all.filter { $0.priority == priority }.sorted { less($0, $1, sort: sort) }
            guard !items.isEmpty else { return nil }
            return UpNextGroup(id: priority ? "priority" : "normal",
                title: priority ? L.t("upnext_priority_section") : L.t("upnext_normal_section"),
                items: items, totalCount: items.count, cap: priority ? 10 : 5)
        }
    }

    private static func less(_ a: UpNextItem, _ b: UpNextItem, sort: UpNextSort) -> Bool {
        switch sort {
        case .newest where a.createdAt != b.createdAt: return a.createdAt > b.createdAt
        case .oldest where a.createdAt != b.createdAt: return a.createdAt < b.createdAt
        case .titleAscending, .titleDescending:
            let comparison = a.title.localizedCompare(b.title)
            if comparison != .orderedSame {
                return comparison == (sort == .titleAscending ? .orderedAscending : .orderedDescending)
            }
        default: break
        }
        for (left, right) in [(a.repoLabel, b.repoLabel), (a.repoPath, b.repoPath)] {
            let comparison = left.localizedCompare(right)
            if comparison != .orderedSame { return comparison == .orderedAscending }
        }
        return a.number < b.number
    }
}

struct UpNextNotice: Identifiable {
    enum Kind { case created, held, errors }
    let kind: Kind
    let count: Int
    var id: Kind { kind }
    var message: String {
        switch kind {
        case .created: L.t("upnext_started", String(count))
        case .held: L.t("upnext_held", String(count))
        case .errors: L.t("upnext_start_failed", String(count))
        }
    }
}

@MainActor
struct UpNextCommands {
    var start: ([UpNextStartItem], UpNextStartChoice?) async throws -> UpNextStartResult

    static func live(_ client: ShepherdClient) -> Self {
        Self(start: { try await client.startUpNext(items: $0, choice: $1) })
    }
}

/// Selection and presentation only; SessionCommandState owns the shared busy/error gate.
@Observable
@MainActor
final class UpNextPanelState {
    private(set) var sort: UpNextSort
    private(set) var selected: Set<String> = []
    var expanded: Set<String> = []
    private(set) var confirmation: [UpNextStartItem]?
    var notices: [UpNextNotice] = []
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        sort = defaults.string(forKey: UpNextSort.storageKey).flatMap(UpNextSort.init(rawValue:)) ?? .newest
    }

    func setSort(_ mode: UpNextSort) {
        sort = mode
        defaults.set(mode.rawValue, forKey: UpNextSort.storageKey)
        confirmation = nil
    }

    func toggle(_ item: UpNextItem) {
        let key = UpNextPresentation.key(item)
        if !selected.insert(key).inserted { selected.remove(key) }
        confirmation = nil
    }

    func selectedItems(in items: [UpNextItem]) -> [UpNextItem] {
        var seen: Set<String> = []
        return items.filter { selected.contains(UpNextPresentation.key($0))
            && seen.insert(UpNextPresentation.key($0)).inserted }
    }

    func reconcile(_ items: [UpNextItem]) {
        selected.formIntersection(items.map(UpNextPresentation.key))
        confirmation = nil
    }

    func cancelConfirmation() { confirmation = nil }
    func clearSelection() { selected.removeAll(); confirmation = nil }

    func reset() {
        clearSelection()
        expanded.removeAll()
        notices.removeAll()
    }

    @discardableResult
    func requestStart(_ items: [UpNextItem], choice: UpNextStartChoice? = nil,
                      commands: UpNextCommands, gate: SessionCommandState,
                      isCurrent: () -> Bool) async -> Bool {
        guard !items.isEmpty, !gate.busy, isCurrent(), !Task.isCancelled else { return false }
        let requests = items.map { UpNextStartItem(repoPath: $0.repoPath, issueRef: $0.issueRef) }
        if items.count > 3, confirmation != requests {
            confirmation = requests
            return false
        }
        confirmation = nil
        notices.removeAll()
        return await gate.run({
            let result = try await commands.start(requests, choice)
            guard isCurrent(), !Task.isCancelled else { return }
            // The HTTP outcome does not select an array. Mixed results matter for every status.
            if !result.created.isEmpty { notices.append(.init(kind: .created, count: result.created.count)) }
            if !result.held.isEmpty { notices.append(.init(kind: .held, count: result.held.count)) }
            if !result.errors.isEmpty { notices.append(.init(kind: .errors, count: result.errors.count)) }
            if notices.isEmpty { notices.append(.init(kind: .errors, count: items.count)) }
            selected.subtract(items.map(UpNextPresentation.key))
        }, failureCopy: { L.t("upnext_start_failed", String(items.count)) + "\n" + $0 },
           isCurrent: { isCurrent() && !Task.isCancelled })
    }
}

/// Mounted by the queues registry/integration lane. Cached snapshots are filtered locally;
/// a refresh's 202 only starts computation and never stands in for an empty snapshot.
struct UpNextView: View {
    @Environment(AppModel.self) private var app
    @State private var state = UpNextPanelState()
    @State private var command = SessionCommandState()
    @State private var presentationGeneration = 0

    private var model: QueuesModel? { app.extension(QueuesModel.self) }
    private var repos: Set<String> { app.extension(SidebarModel.self)?.activeRepos ?? [] }
    private var groups: [UpNextGroup] {
        UpNextPresentation.groups(model?.upNext, sort: state.sort, repos: repos)
    }
    private var items: [UpNextItem] { groups.flatMap(\.items) }

    var body: some View {
        let run = startRunner()
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L.t("upnext_title")).font(.title2.weight(.semibold))
                Spacer()
                Picker(L.t("upnext_sort_aria"), selection: Binding(
                    get: { state.sort }, set: { state.setSort($0) })) {
                    ForEach(UpNextSort.allCases, id: \.self) { mode in
                        Text(verbatim: mode.label).tag(mode)
                    }
                }
                .fixedSize()
                .accessibilityIdentifier("queues-upnext-sort")
                Button(L.t("upnext_refresh")) {
                    Task { await model?.refresh() }
                }
                .disabled(model == nil || model?.isRefreshing == true)
            }
            if let snapshot = model?.upNext {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(verbatim: UpNextPresentation.updated(snapshot.generatedAt, now: context.date))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let message = command.message {
                NoticeBar(message: message, onDismiss: command.clear)
            }
            ForEach(state.notices) { notice in
                NoticeBar(message: notice.message, tone: notice.kind == .errors ? .warning : .success,
                          onDismiss: { state.notices.removeAll { $0.id == notice.id } })
                    .accessibilityIdentifier("queues-upnext-notice-\(notice.kind)")
            }
            content(run: run)
            batchActions(run: run)
        }
        .padding(16)
        .accessibilityIdentifier("queues-upnext-panel")
        .task(id: app.activationGeneration) {
            if let model, !model.isRefreshing { await model.refresh() }
        }
        .onChange(of: model?.upNext) { _, _ in state.reconcile(items) }
        .onChange(of: repos) { _, _ in state.reconcile(items) }
        .onChange(of: app.activationGeneration) { _, _ in
            presentationGeneration &+= 1
            state.reset()
            command.clear()
        }
        .onDisappear {
            presentationGeneration &+= 1
            state.cancelConfirmation()
        }
    }

    @ViewBuilder
    private func content(run: @escaping @MainActor ([UpNextItem]) async -> Void) -> some View {
        switch UpNextPresentation.phase(model?.upNext, failed: model?.upNextLoadFailed ?? false, groups: groups) {
        case .computing:
            ProgressView(L.t("common_loading")).accessibilityIdentifier("queues-upnext-computing")
        case .failed:
            Text(L.t("common_issues_load_failed")).accessibilityIdentifier("queues-upnext-failed")
        case .empty:
            Text(repos.isEmpty ? L.t("upnext_empty")
                 : L.t("upnext_repo_filter_empty", repos.sorted().map(DonePresentation.repoBasename).joined(separator: ", ")))
                .foregroundStyle(.secondary).accessibilityIdentifier("queues-upnext-empty")
        case .ready:
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(verbatim: group.title).font(.headline)
                            ForEach(group.shown(expanded: state.expanded.contains(group.id)), id: \.queueKey) { item in
                                row(item, run: run)
                            }
                            if group.items.count > group.cap {
                                Button(state.expanded.contains(group.id) ? L.t("upnext_show_less")
                                       : L.t("upnext_show_all", String(group.totalCount))) {
                                    if !state.expanded.insert(group.id).inserted { state.expanded.remove(group.id) }
                                }
                                .accessibilityIdentifier("queues-upnext-expand-\(group.id)")
                            }
                        }
                    }
                }
            }
        }
    }

    private func row(_ item: UpNextItem,
                     run: @escaping @MainActor ([UpNextItem]) async -> Void) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Toggle(L.t("upnext_select_aria", String(item.number), item.title), isOn: Binding(
                get: { state.selected.contains(UpNextPresentation.key(item)) }, set: { _ in state.toggle(item) }))
                .labelsHidden().toggleStyle(.checkbox)
            VStack(alignment: .leading, spacing: 4) {
                if let url = SessionBadges.safeURL(item.url) {
                    Link(destination: url) { Text(verbatim: "#\(item.number) \(item.title)") }
                        .font(.body.weight(.medium))
                } else {
                    Text(verbatim: "#\(item.number) \(item.title)").font(.body.weight(.medium))
                }
                if let parent = item.epicParent {
                    Label("#\(parent.number) \(parent.title)", systemImage: "square.stack.3d.up")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(verbatim: item.repoLabel.isEmpty ? DonePresentation.repoBasename(item.repoPath) : item.repoLabel)
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    if item.priority { Text(L.t("upnext_pill_priority")).foregroundStyle(.orange) }
                    if item.kind.rawValue == "epic" { Text(L.t("upnext_pill_epic")) }
                    ForEach(UpNextPresentation.labels(item), id: \.self) { label in
                        Text(verbatim: label).padding(.horizontal, 5).background(.quaternary, in: Capsule())
                    }
                }
                .font(.caption)
            }
            Spacer()
            Button(L.t("upnext_start")) { Task { await run([item]) } }
        }
        .disabled(command.busy)
        .accessibilityIdentifier("queues-upnext-row-\(UpNextPresentation.key(item))")
    }

    private func batchActions(run: @escaping @MainActor ([UpNextItem]) async -> Void) -> some View {
        let selected = state.selectedItems(in: items)
        return HStack {
            if command.busy { ProgressView().controlSize(.small) }
            if let confirmation = state.confirmation {
                Text(L.t("upnext_confirm", String(confirmation.count)))
                Button(L.t("upnext_confirm_yes")) { Task { await run(selected) } }
                    .accessibilityIdentifier("queues-upnext-confirm")
                Button(L.t("common_cancel")) { state.cancelConfirmation() }
            } else {
                Button(L.t("upnext_start_selected", String(selected.count))) { Task { await run(selected) } }
                    .disabled(selected.isEmpty)
                    .accessibilityIdentifier("queues-upnext-start-selected")
            }
            Button(L.t("upnext_clear_selection")) { state.clearSelection() }.disabled(selected.isEmpty)
        }
        .disabled(command.busy)
        .accessibilityLabel(L.t("upnext_batch_aria"))
    }

    private func startRunner() -> @MainActor ([UpNextItem]) async -> Void {
        let activation = app.activationGeneration
        let presentation = presentationGeneration
        let client = app.store?.client
        return { items in
            guard let client else { return }
            await state.requestStart(items, commands: .live(client), gate: command,
                isCurrent: { app.activationGeneration == activation && presentationGeneration == presentation })
        }
    }
}

private extension UpNextItem {
    var queueKey: String { UpNextPresentation.key(self) }
}
