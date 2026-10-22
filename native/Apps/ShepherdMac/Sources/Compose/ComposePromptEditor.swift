import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// SwiftUI text selection keeps issue/command completions anchored to the actual caret.
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
            VStack(alignment: .leading, spacing: 0) {
                TextEditor(text: $model.prompt, selection: $selection)
                    .focused($editingPrompt)
                    .focusedValue(\.composeEditingText, true)
                    .onChange(of: model.focusRevision) { _, _ in
                        if model.focusTarget == "prompt" { editingPrompt = true }
                    }
                    .task(id: "\(model.repoPath):\(commandProvider.rawValue)") {
                        await model.loadCommands(provider: commandProvider)
                    }
                    .scrollContentBackground(.hidden)
                    .frame(height: 200)
                    .accessibilityLabel(L.t("newtask_prompt_label"))
                    .accessibilityIdentifier("compose.prompt")
                    .modifier(ComposeAttachmentInput(model: model.attachments))
                    .background(PromptAttachmentBridge(model: model.attachments))
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
                Divider()
                AttachmentsRow(model: model.attachments, choosingFiles: $model.choosingFiles, composer: model)
                    .padding(10)
            }
            .background(.background, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator))
            if matchCount > 0 {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(issueMatches.enumerated()), id: \.element.number) { index, issue in
                            Button { pickMatch(index) } label: { IssuePickerRow(issue: issue, epic: model.epicParents.contains(issue.number), viewer: model.viewer) }
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
                    Text(verbatim: L.t("newtask_provider_constraint_body", EnginePicker.name(constraint.provider), constraint.token))
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
