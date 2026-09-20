import Foundation
import ShepherdKit
import SwiftUI

/// Presentation and the explicit stored-input -> writable-request boundary. Server-owned
/// fields such as `auto` are not part of CreateSessionRequest and never go into PATCH.
enum HeldQueuePresentation {
    static func reasonKey(_ reason: HeldReason?) -> StaticString {
        switch reason?.known {
        case .usage: "native_held_reason_usage"
        case .capacity: "native_held_reason_capacity"
        case nil: "native_held_reason_unknown"
        }
    }

    static func reasonLabel(_ reason: HeldReason?) -> String { L.t(reasonKey(reason)) }

    static func badgeLabel(_ count: Int) -> String { L.t("topbar_held_badge", String(count)) }

    static func showsBadge(_ count: Int) -> Bool { count > 0 }

    static func originalProvider(_ entry: HeldQueueEntry) -> AgentProvider {
        entry.input.agentProvider ?? .claude
    }

    static func providerLabel(_ provider: AgentProvider) -> String {
        provider == .claude ? L.t("agent_provider_claude") : L.t("agent_provider_codex")
    }

    static func spawnOverride(_ entry: HeldQueueEntry, selected: AgentProvider?) -> AgentProvider? {
        guard let selected, selected != originalProvider(entry) else { return nil }
        return selected
    }

    static func editRequest(_ input: Components.Schemas.HeldQueueInput) -> CreateSessionRequest {
        .init(repoPath: input.repoPath, baseBranch: input.baseBranch, prompt: input.prompt,
              agentProvider: input.agentProvider, model: input.model, effort: input.effort,
              images: input.images, planGateEnabled: input.planGateEnabled,
              autopilotEnabled: input.autopilotEnabled, sandboxProfile: input.sandboxProfile,
              plain: input.plain, force: input.force, mergeTrainPrs: input.mergeTrainPrs,
              issueRef: input.issueRef, research: input.research, epicAuthoring: input.epicAuthoring,
              attachmentNames: input.attachmentNames, launchUiState: input.launchUiState)
    }

    static func canSave(_ request: CreateSessionRequest) -> Bool {
        !request.repoPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !request.baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !request.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && request.prompt.count <= 8_000
    }
}

/// The row's dialog routes cancellation and dismissal through the same no-command path.
struct HeldDiscardConfirmation {
    private(set) var isPresented = false
    mutating func request() { isPresented = true }
    mutating func cancel() { isPresented = false }
    mutating func confirm(perform: () -> Void) {
        guard isPresented else { return }
        isPresented = false
        perform()
    }
}

enum HeldQueueAction {
    case spawn(AgentProvider?)
    case edit(CreateSessionRequest)
    case discard

    var failureKey: StaticString {
        switch self {
        case .spawn: "topbar_held_spawn_failed"
        case .edit: "newtask_edit_held_failed"
        case .discard: "topbar_held_discard_failed"
        }
    }
}

/// Only command dependencies: busy/error state belongs to SessionCommandState.
@MainActor
struct HeldQueueCommands {
    var spawn: (String, AgentProvider?) async throws -> Void
    var update: (String, CreateSessionRequest) async throws -> Void
    var discard: (String) async throws -> Void
    var reload: () async throws -> Void

    static func live(_ client: ShepherdClient, model: QueuesModel) -> Self {
        Self(spawn: { _ = try await client.spawnHeld(id: $0, agentProvider: $1) },
             update: { _ = try await client.updateHeld(id: $0, input: $1) },
             discard: { try await client.discardHeld(id: $0) },
             reload: { try await model.reloadHeld() })
    }

    func run(_ action: HeldQueueAction, id: String, gate: SessionCommandState,
             isCurrent: () -> Bool) async -> Bool {
        guard isCurrent() else { return false }
        return await gate.run({
            switch action {
            case .spawn(let provider): try await spawn(id, provider)
            case .edit(let input): try await update(id, input)
            case .discard: try await discard(id)
            }
            guard isCurrent() else { return }
            // The response is not a local list mutation. In particular, DELETE also succeeds
            // for missing ids, and the spawned Session is installed only by session:new.
            try await reload()
        }, failureCopy: { L.t(action.failureKey) + "\n" + $0 }, isCurrent: isCurrent)
    }
}

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
