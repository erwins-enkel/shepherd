import ShepherdAppCore
import Foundation
import ShepherdKit
import SwiftUI

/// The integration lane mounts this badge in the header. It owns its anchored popover;
/// editing is local until S11's composer gains a held-input entry point.
struct HeldQueueView: View {
    @Environment(AppModel.self) private var app
    let model: QueuesModel
    @State private var isPresented = false
    @State private var command = SessionCommandState()
    @State private var editing: HeldQueueEntry?
    @State private var presentationGeneration = 0

    var body: some View {
        Group {
            if HeldQueuePresentation.showsBadge(model.heldCount) {
                Button(HeldQueuePresentation.badgeLabel(model.heldCount), systemImage: "hourglass") {
                    isPresented.toggle()
                }
                .accessibilityIdentifier("queues-held-badge")
                .popover(isPresented: $isPresented, arrowEdge: .bottom) { panel }
            }
        }
        .onChange(of: model.heldCount) { _, count in
            if !HeldQueuePresentation.showsBadge(count) { isPresented = false }
        }
        .onChange(of: app.activationGeneration) { _, _ in
            isPresented = false
            editing = nil
            presentationGeneration &+= 1
        }
        .onDisappear { presentationGeneration &+= 1 }
    }

    private var panel: some View {
        let run = commandRunner()
        return VStack(alignment: .leading, spacing: 12) {
            Text(L.t("topbar_held_title")).font(.headline)
            if let message = command.message {
                NoticeBar(message: message, onDismiss: command.clear)
            }
            if command.busy { ProgressView().controlSize(.small) }
            if model.held.isEmpty {
                Text(L.t("topbar_held_empty")).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(model.held, id: \.id) { entry in
                            HeldQueueRow(entry: entry, busy: command.busy,
                                edit: { command.clear(); editing = entry },
                                perform: { action in Task { await run(action, entry.id) } })
                        }
                    }
                }
                .frame(maxHeight: 400)
            }
        }
        .padding(16)
        .frame(width: 480)
        .accessibilityIdentifier("queues-held-popover")
        .task {
            let activation = app.activationGeneration
            let presentation = presentationGeneration
            await command.run({ try await model.reloadHeld() }, failureCopy: { $0 },
                isCurrent: { app.activationGeneration == activation && presentationGeneration == presentation })
        }
        .sheet(isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
            if let entry = editing {
                HeldQueueEditSheet(entry: entry, command: command) { request in
                    await run(.edit(request), entry.id)
                }
            }
        }
        .onDisappear { presentationGeneration &+= 1 }
    }

    private func commandRunner() -> @MainActor (HeldQueueAction, String) async -> Bool {
        // Capture the destination before an action's Task can be scheduled after a switch.
        let activation = app.activationGeneration
        let presentation = presentationGeneration
        let client = app.store?.client
        return { action, id in
            guard let client else { return false }
            return await HeldQueueCommands.live(client, model: model).run(action, id: id, gate: command,
                isCurrent: { app.activationGeneration == activation && presentationGeneration == presentation })
        }
    }
}

private struct HeldQueueRow: View {
    let entry: HeldQueueEntry
    let busy: Bool
    let edit: () -> Void
    let perform: (HeldQueueAction) -> Void
    @State private var selectedProvider: AgentProvider?
    @State private var discardConfirmation = HeldDiscardConfirmation()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: entry.input.prompt).lineLimit(3)
            HStack {
                Text(verbatim: DonePresentation.repoBasename(entry.repoPath))
                Text(L.t("topbar_held_original_cli",
                         HeldQueuePresentation.providerLabel(HeldQueuePresentation.originalProvider(entry))))
            }
            .font(.caption).foregroundStyle(.secondary)
            Text(verbatim: HeldQueuePresentation.reasonLabel(entry.reason))
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("queues-held-reason-\(entry.id)")
            Picker(L.t("topbar_held_spawn_cli_label"), selection: Binding(
                get: { selectedProvider ?? HeldQueuePresentation.originalProvider(entry) },
                set: { selectedProvider = $0 })) {
                ForEach([AgentProvider.claude, .codex], id: \.self) { provider in
                    Text(verbatim: HeldQueuePresentation.providerLabel(provider)).tag(provider)
                }
            }
            .accessibilityIdentifier("queues-held-provider-\(entry.id)")
            HStack {
                Button(L.t("topbar_held_edit"), action: edit)
                    .accessibilityIdentifier("queues-held-edit-\(entry.id)")
                Button(L.t("topbar_held_spawn_now")) {
                    perform(.spawn(HeldQueuePresentation.spawnOverride(entry, selected: selectedProvider)))
                }
                .accessibilityIdentifier("queues-held-spawn-\(entry.id)")
                Button(L.t("topbar_held_discard"), role: .destructive) { discardConfirmation.request() }
                    .accessibilityIdentifier("queues-held-discard-\(entry.id)")
            }
        }
        .disabled(busy)
        .accessibilityIdentifier("queues-held-row-\(entry.id)")
        .confirmationDialog(L.t("native_held_discard_confirm"), isPresented: Binding(
            get: { discardConfirmation.isPresented },
            set: { if !$0 { discardConfirmation.cancel() } }), titleVisibility: .visible) {
                Button(L.t("topbar_held_discard"), role: .destructive) {
                    discardConfirmation.confirm { perform(.discard) }
                }
                Button(L.t("common_cancel"), role: .cancel) { discardConfirmation.cancel() }
        }
        .onDisappear { discardConfirmation.cancel() }
    }
}

private struct HeldQueueEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    let command: SessionCommandState
    let save: (CreateSessionRequest) async -> Bool
    @State private var request: CreateSessionRequest

    init(entry: HeldQueueEntry, command: SessionCommandState,
         save: @escaping (CreateSessionRequest) async -> Bool) {
        self.command = command
        self.save = save
        _request = State(initialValue: HeldQueuePresentation.editRequest(entry.input))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L.t("newtask_edit_held_title")).font(.title2.weight(.semibold))
            Form {
                TextField(L.t("newtask_repo_label"), text: $request.repoPath)
                TextField(L.t("newtask_branch_label"), text: $request.baseBranch)
                Picker(L.t("native_newsession_provider_label"), selection: Binding(
                    get: { request.agentProvider ?? .claude }, set: { request.agentProvider = $0 })) {
                    ForEach([AgentProvider.claude, .codex], id: \.self) { provider in
                        Text(verbatim: HeldQueuePresentation.providerLabel(provider)).tag(provider)
                    }
                }
                TextField(L.t("newtask_model_label"), text: Binding(
                    get: { request.model ?? "" }, set: { request.model = $0.isEmpty ? nil : $0 }))
                Picker(L.t("newtask_effort_label"), selection: $request.effort) {
                    Text(L.t("effort_default")).tag(Effort?.none)
                    Text(L.t("effort_label_low")).tag(Effort?.some(.low))
                    Text(L.t("effort_label_medium")).tag(Effort?.some(.medium))
                    Text(L.t("effort_label_high")).tag(Effort?.some(.high))
                    Text(L.t("effort_label_xhigh")).tag(Effort?.some(.xhigh))
                    Text(L.t("effort_label_max")).tag(Effort?.some(.max))
                    Text(L.t("effort_label_ultra")).tag(Effort?.some(.ultra))
                }
            }
            .formStyle(.grouped)
            .disabled(command.busy)
            Text(L.t("newtask_prompt_label")).font(.callout.weight(.semibold))
            TextEditor(text: $request.prompt).frame(minHeight: 140).disabled(command.busy)
                .accessibilityLabel(L.t("newtask_prompt_label"))
                .accessibilityIdentifier("queues-held-edit-prompt")
            if let message = command.message {
                Text(verbatim: message).foregroundStyle(.orange)
            }
            HStack {
                Button(L.t("common_cancel")) { dismiss() }
                    .keyboardShortcut(.cancelAction).disabled(command.busy)
                Spacer()
                Button(command.busy ? L.t("newtask_edit_held_saving") : L.t("newtask_edit_held_submit")) {
                    Task { if await save(request) { dismiss() } }
                }
                .buttonStyle(.borderedProminent)
                .disabled(command.busy || !HeldQueuePresentation.canSave(request))
                .accessibilityIdentifier("queues-held-edit-save")
            }
        }
        .padding(24).frame(width: 620)
        .interactiveDismissDisabled(command.busy)
        .accessibilityIdentifier("queues-held-edit-sheet")
    }
}
