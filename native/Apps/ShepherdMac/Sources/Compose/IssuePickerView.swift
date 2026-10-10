import ShepherdAppCore
import ShepherdKit
import SwiftUI

struct IssuePickerView: View {
    @Bindable var model: ComposeModel
    var editSteers: (Issue) -> Void = { _ in }
    @State private var commandQuery = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(verbatim: L.t("promptsources_title")).font(.headline)
                Spacer()
                if model.source == .issues, let count = model.openCount {
                    Text(verbatim: L.t("promptsources_open_count", String(count))).foregroundStyle(.secondary)
                }
            }
            HStack {
                SourceToggle(selection: $model.source)
                if model.source == .issues {
                    Button { model.showFilters.toggle() } label: {
                        HStack {
                            Text(verbatim: L.t("issue_filter_button"))
                            Text(verbatim: "\(model.filter.activeCount(hasViewer: model.viewer != nil))")
                                .font(.caption.monospacedDigit())
                        }
                    }
                    .accessibilityLabel(L.t("issue_filter_button_aria", String(model.filter.activeCount(hasViewer: model.viewer != nil))))
                    .popover(isPresented: $model.showFilters) { filters.padding().frame(width: 300) }
                }
            }
            if model.source == .issues {
                TextField(L.t("issuespanel_filter_placeholder"), text: $model.issueQuery)
                    .focusedValue(\.composeEditingText, true)
                    .accessibilityIdentifier("compose.issue-search")
                issueList
            } else { commandList }
            if let issue = model.activeIssue {
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(verbatim: "#\(issue.number) · \(issue.title)").lineLimit(1)
                        Spacer()
                        Button { model.removeIssue() } label: { Image(systemName: "xmark.circle.fill") }
                            .accessibilityLabel(L.t("newtask_issue_remove_aria"))
                    }
                    let others = model.viewer.map { viewer in issue.assignees.filter { $0 != viewer } } ?? []
                    if !others.isEmpty {
                        Label(L.t("issuerow_assigned_notice", others.joined(separator: ", ")), systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if let blockers = issue.blockedBy, !blockers.isEmpty {
                        Label(L.t("newtask_issue_blocked_notice", blockers.map { "#\($0)" }.joined(separator: ", ")),
                              systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                    }
                }
                .padding(8).background(.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                .contextMenu { Button(L.t("steerbar_edit")) { editSteers(issue) } }
            }
        }
        .task(id: model.repoPath) { await model.loadSources() }
        .task(id: model.provider) { await model.loadCommands() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("compose.sources")
    }

    @ViewBuilder private var issueList: some View {
        if model.loading {
            ProgressView().controlSize(.small)
        } else if model.issuesFailed {
            Text(verbatim: L.t("common_issues_load_failed")).foregroundStyle(.secondary)
        } else if model.listing?.lightweight == true {
            Text(verbatim: L.t("common_issues_lightweight")).foregroundStyle(.secondary)
        } else if model.listing?.slug == nil {
            Text(verbatim: L.t("promptsources_no_github")).foregroundStyle(.secondary)
        } else {
            let result = model.filteredIssues
            let visible = result.visible.filter {
                model.issueQuery.isEmpty || $0.title.localizedCaseInsensitiveContains(model.issueQuery)
                    || String($0.number).contains(model.issueQuery.trimmingCharacters(in: CharacterSet(charactersIn: "#")))
            }
            if visible.isEmpty {
                Text(verbatim: model.issueQuery.isEmpty ? (result.emptiedBy?.message ?? L.t("common_no_open_issues")) : L.t("issuespanel_no_match"))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(visible.prefix(model.expanded ? visible.count : 3)), id: \.number) { issue in
                    Button { model.pickIssue(issue) } label: { IssuePickerRow(issue: issue, epic: model.epicParents.contains(issue.number), viewer: model.viewer) }
                        .buttonStyle(.plain)
                        .contextMenu { Button(L.t("steerbar_edit")) { editSteers(issue) } }
                        .accessibilityIdentifier("compose.issue.\(issue.number)")
                }
                if visible.count > 3 {
                    Button {
                        model.expanded.toggle()
                    } label: {
                        Text(verbatim: model.expanded ? L.t("promptsources_collapse_row")
                             : L.t("promptsources_more_row", String(visible.count - 3)))
                    }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var commandList: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(L.t("promptsources_commands_filter"), text: $commandQuery)
                .focusedValue(\.composeEditingText, true)
            if let error = model.commandsError {
                Text(verbatim: error).foregroundStyle(.secondary)
            } else if model.commands.isEmpty {
                Text(verbatim: L.t("promptsources_no_commands")).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(ComposeModel.commandMatches(model.commands, query: commandQuery).enumerated()), id: \.offset) { _, command in
                            Button { model.pickCommand(command) } label: {
                                VStack(alignment: .leading) {
                                    Text(verbatim: command.displayName ?? command.name).fontWeight(.medium)
                                    Text(verbatim: command.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            .disabled(!ComposeModel.isInsertable(command))
                        }
                    }
                }.frame(maxHeight: 160)
            }
        }
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: L.t("issue_filter_heading")).font(.headline)
            Toggle(L.t("issues_filter_mine_label"), isOn: $model.filter.hideOthers)
                .help(L.t("issues_filter_mine_title"))
            Toggle(L.t("issues_filter_active_label"), isOn: $model.filter.hideActive)
                .help(L.t("issues_filter_active_title"))
            Toggle(L.t("issues_filter_subissues_label"), isOn: $model.filter.hideSubIssues)
                .help(L.t("issues_filter_subissues_title"))
            Toggle(L.t("issues_filter_blocked_label"), isOn: $model.filter.hideBlocked)
                .help(L.t("issues_filter_blocked_title"))
            Divider()
            Picker(L.t("issues_filter_author_heading"), selection: $model.filter.author) {
                Text(verbatim: L.t("issues_filter_author_all")).tag(nil as String?)
                ForEach(model.authors, id: \.self) { Text(verbatim: $0).tag(Optional($0)) }
            }
            Text(verbatim: L.t("issues_filter_labels_heading")).font(.subheadline)
            ScrollView {
                VStack(alignment: .leading) {
                    ForEach(model.labels, id: \.self) { label in
                        Toggle(isOn: Binding(get: { model.filter.labels.contains(label) }, set: { selected in
                            if selected { model.filter.labels.insert(label) } else { model.filter.labels.remove(label) }
                        })) { Text(verbatim: label) }
                    }
                }
            }.frame(maxHeight: 160)
        }
        .toggleStyle(.checkbox)
    }
}

struct IssuePickerRow: View {
    let issue: Issue
    var epic = false
    var viewer: String?
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(verbatim: "#\(issue.number)").monospacedDigit().foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: issue.title).lineLimit(2)
                HStack {
                    if epic { Label(L.t("upnext_pill_epic"), systemImage: "square.stack.3d.up").font(.caption) }
                    ForEach(issue.labels, id: \.self) { label in
                        Text(verbatim: label).font(.caption).padding(.horizontal, 5)
                            .background(.quaternary, in: Capsule())
                    }
                }
                let assignees = viewer.map { viewer in issue.assignees.filter { $0 != viewer } } ?? issue.assignees
                if !assignees.isEmpty {
                    Text(verbatim: L.t("issuerow_assigned_pill", assignees.joined(separator: ", ")))
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let blockers = issue.blockedBy, !blockers.isEmpty {
                    Label(L.t("issuerow_blocked_on", blockers.map { "#\($0)" }.joined(separator: ", ")), systemImage: "lock")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
}
