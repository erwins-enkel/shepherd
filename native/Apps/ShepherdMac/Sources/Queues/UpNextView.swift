import ShepherdAppCore
import Foundation
import Observation
import ShepherdKit
import SwiftUI

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
