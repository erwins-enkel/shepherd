import ShepherdKit
import SwiftUI

struct IssuePickerView: View {
    @Bindable var model: ComposeModel
    @State private var commandQuery = ""
    @State private var issueQuery = ""

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
                TextField(L.t("issuespanel_filter_placeholder"), text: $issueQuery)
                    .focusedValue(\.composeEditingText, true)
                    .accessibilityIdentifier("compose.issue-search")
                issueList
            } else { commandList }
            if let issue = model.activeIssue {
                HStack {
                    Text(verbatim: "#\(issue.number) · \(issue.title)").lineLimit(1)
                    Button { model.removeIssue() } label: { Image(systemName: "xmark.circle.fill") }
                        .accessibilityLabel(L.t("newtask_issue_remove_aria"))
                }
                .padding(8).background(.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
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
                issueQuery.isEmpty || $0.title.localizedCaseInsensitiveContains(issueQuery)
                    || String($0.number).contains(issueQuery.trimmingCharacters(in: CharacterSet(charactersIn: "#")))
            }
            if visible.isEmpty {
                Text(verbatim: issueQuery.isEmpty ? (result.emptiedBy?.message ?? L.t("common_no_open_issues")) : L.t("issuespanel_no_match"))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(visible.prefix(model.expanded ? visible.count : 3)), id: \.number) { issue in
                    Button { model.pickIssue(issue) } label: { IssuePickerRow(issue: issue) }
                        .buttonStyle(.plain)
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

private struct IssuePickerRow: View {
    let issue: Issue
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(verbatim: "#\(issue.number)").monospacedDigit().foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: issue.title).lineLimit(2)
                if !issue.labels.isEmpty {
                    Text(verbatim: issue.labels.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
}

/// Used alongside IssuePickerView by the complete sheet (Task 9). Selection is SwiftUI-native,
/// so the inline menu uses the actual caret without an AppKit text-view bridge.
struct ComposePromptEditor: View {
    @Bindable var model: ComposeModel
    @FocusState private var editingPrompt: Bool
    @State private var selection: TextSelection?
    @State private var caretOffset: Int?
    @State private var dismissed = false
    @State private var selectedMatch = 0

    private var caret: String.Index {
        String.Index(utf16Offset: min(caretOffset ?? model.prompt.utf16.count, model.prompt.utf16.count), in: model.prompt)
    }
    private var trigger: ComposeModel.Trigger? {
        dismissed ? nil : ComposeModel.trigger(in: model.prompt, caret: caret)
    }
    private var issueMatches: [Issue] { trigger?.symbol == "#" ? model.issueMatches(trigger?.query ?? "") : [] }
    private var commandProvider: AgentProvider { model.commandProvider(at: caret) }
    private var commandMatches: [SlashCommand] {
        guard let trigger, trigger.symbol != "#" else { return [] }
        return Array(ComposeModel.commandMatches(model.commands(for: commandProvider), query: trigger.query).prefix(20))
    }
    private var matchCount: Int { issueMatches.count + commandMatches.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: L.t("newtask_prompt_label"))
            TextEditor(text: $model.prompt, selection: $selection)
                .focused($editingPrompt)
                .focusedValue(\.composeEditingText, true)
                .onChange(of: model.focusRevision) { _, _ in
                    if model.focusTarget == "prompt" { editingPrompt = true }
                }
                .task(id: "\(model.repoPath):\(commandProvider.rawValue)") {
                    await model.loadCommands(provider: commandProvider)
                }
                .frame(minHeight: 100)
                .accessibilityLabel(L.t("newtask_prompt_label"))
                .accessibilityIdentifier("compose.prompt")
                .modifier(ComposeAttachmentInput(model: model.attachments))
                .onChange(of: selection) { _, value in
                    if let value, case .selection(let range) = value.indices {
                        caretOffset = range.upperBound.utf16Offset(in: model.prompt)
                    }
                }
                .onChange(of: model.prompt) { _, _ in dismissed = false; selectedMatch = 0 }
                .onKeyPress(.downArrow) { move(1) }
                .onKeyPress(.upArrow) { move(-1) }
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.isEmpty, matchCount > 0 else { return .ignored }
                    pickMatch(min(selectedMatch, matchCount - 1)); return .handled
                }
                .onKeyPress(.escape) {
                    guard trigger != nil else { return .ignored }
                    dismissed = true; return .handled
                }
            if matchCount > 0 {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(issueMatches.enumerated()), id: \.element.number) { index, issue in
                            Button { pickMatch(index) } label: { IssuePickerRow(issue: issue) }
                                .buttonStyle(.plain).padding(4)
                                .background(index == selectedMatch ? Color.accentColor.opacity(0.12) : .clear)
                        }
                        ForEach(Array(commandMatches.enumerated()), id: \.offset) { index, command in
                            Button { pickMatch(index) } label: {
                                Text(verbatim: command.displayName ?? command.name).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .disabled(!ComposeModel.isInsertable(command))
                            .buttonStyle(.plain).padding(4)
                            .background(index == selectedMatch ? Color.accentColor.opacity(0.12) : .clear)
                        }
                    }
                }.frame(maxHeight: 180)
            }
            if let constraint = model.providerConstraint {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: L.t("newtask_provider_constraint_title")).fontWeight(.medium)
                    Text(verbatim: L.t("newtask_provider_constraint_body", constraint.provider.rawValue, constraint.token))
                }
                .foregroundStyle(.blue).padding(10)
                .background(.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private func move(_ delta: Int) -> KeyPress.Result {
        guard matchCount > 0 else { return .ignored }
        selectedMatch = (selectedMatch + delta + matchCount) % matchCount
        return .handled
    }
    private func pickMatch(_ index: Int) {
        let next: String.Index
        if trigger?.symbol == "#", issueMatches.indices.contains(index) {
            model.pickIssueFromSearch(issueMatches[index], caret: caret)
            next = model.prompt.endIndex
        } else if commandMatches.indices.contains(index), ComposeModel.isInsertable(commandMatches[index]) {
            next = model.pickCommand(commandMatches[index], caret: caret)
        } else { return }
        caretOffset = next.utf16Offset(in: model.prompt)
        selection = TextSelection(insertionPoint: next)
        dismissed = true
    }
}
