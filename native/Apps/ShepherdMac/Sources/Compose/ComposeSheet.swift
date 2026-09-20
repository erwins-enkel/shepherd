import ShepherdKit
import SwiftUI

struct ComposeSheet: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        if let store = app.store {
            ComposeSheetContent(app: app, store: store, activation: app.activationGeneration)
                .id(app.activationGeneration)
        }
    }
}

private struct ComposeSheetContent: View {
    let app: AppModel
    let store: SessionStore
    let activation: Int
    @State private var model: ComposeModel
    @State private var submission = ComposeSubmission()
    @State private var revealing = false
    @State private var keyCard = false
    @FocusedValue(\.composeEditingText) private var editingText

    init(app: AppModel, store: SessionStore, activation: Int) {
        self.app = app; self.store = store; self.activation = activation
        let settings = store.settings
        let defaults = ComposeRunConfig.Defaults(provider: settings?.defaultAgentProvider ?? .claude,
            claudeModel: settings?.defaultModel ?? "auto", codexModel: settings?.defaultCodexModel ?? "gpt-5.6-sol",
            effort: settings?.defaultEffort ?? "default",
            fableAvailable: settings?.additionalProperties.value["fableAvailable"] as? Bool ?? true)
        _model = State(initialValue: ComposeModel(client: store.client, runDefaults: defaults))
    }
    private var current: Bool { app.store === store && app.activationGeneration == activation && app.sheet == .newSession }
    private var repos: [Repo] { store.repos.filter { !$0.hidden } }
    private var repo: Repo? { repos.first { $0.path == model.repoPath } }
    private var holdLikely: Bool { ComposeReadiness.holdLikely(limits: SessionSignals.usageLimits(), settings: store.settings) }
    private var readiness: ComposeReadiness.State {
        model.readiness(submitting: submission.busy, repoResolved: repo != nil, holdLikely: holdLikely)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(verbatim: L.t("newtask_title")).font(.title2.bold())
                Spacer()
                Button { keyCard = true } label: { Image(systemName: "questionmark.circle") }
                    .accessibilityLabel(L.t("keymap_sheet_aria"))
                Button { app.sheet = nil } label: { Image(systemName: "xmark") }
                    .accessibilityLabel(L.t("common_cancel"))
                    .keyboardShortcut(.cancelAction).disabled(submission.busy)
                    .modifier(ComposeKeycap(ids: ["close"]))
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    RepoBranchRow(model: model, repos: repos).modifier(ComposeKeycap(ids: ["repo", "branch"]))
                    IssuePickerView(model: model).modifier(ComposeKeycap(ids: ["issue-filter", "sources-tab"]))
                    ModeTabs(model: model).modifier(ComposeKeycap(ids: ["mode-code", "mode-research", "mode-epic", "mode-plain"]))
                    ComposePromptEditor(model: model).modifier(ComposeKeycap(ids: ["focus-prompt", "issue-token", "command-token", "paste-image"]))
                    EnginePicker(model: model).modifier(ComposeKeycap(ids: ["engine"]))
                    CapacityLine(provider: model.provider)
                    ModelPicker(model: model).modifier(ComposeKeycap(ids: ["model"]))
                    SandboxPicker(model: model, holdLikely: holdLikely)
                    GuardToggles(model: model).modifier(ComposeKeycap(ids: ["plan-gate", "autopilot"]))
                    AttachmentsRow(model: model.attachments, choosingFiles: $model.choosingFiles)
                        .modifier(ComposeKeycap(ids: ["attach"]))
                    ShapeRoundView(model: model)
                    Text(verbatim: L.t("native_compose_dictation_deferred")).font(.caption).foregroundStyle(.secondary)
                }
                .padding(.trailing, 6)
                .disabled(submission.busy)
                .opacity(revealing ? 0.6 : 1)
            }
            if submission.slow { spawnPanel }
            if let message = submission.message { Text(verbatim: message).font(.callout).textSelection(.enabled) }
            ComposeFooter(readiness: readiness, repoName: repo?.name, branch: model.repoBranches, held: revealing, submit: submit)
        }
        .environment(\.composeReveal, revealing)
        .padding(20).frame(width: 740, height: 780)
        .background { shortcuts }
        .onModifierKeysChanged(mask: .command) { _, keys in revealing = keys.contains(.command) }
        .onKeyPress(characters: CharacterSet(charactersIn: "?")) { _ in
            guard ComposeKeymap.canDispatch("sheet", editingText: editingText == true) else { return .ignored }
            keyCard = true; return .handled
        }
        .sheet(isPresented: $keyCard) { ComposeKeyCard { keyCard = false } }
        .interactiveDismissDisabled(submission.busy)
        .onAppear { seedRepo() }
        .onChange(of: store.repos) { _, _ in seedRepo() }
        .onDisappear { submission.teardown(); model.teardown() }
        .accessibilityIdentifier("compose.sheet")
    }

    private func seedRepo() {
        if model.repoPath.isEmpty, let first = repos.first { model.repoPath = first.path }
    }
    private func submit(_ force: Bool = false) {
        guard current else { return }
        Task {
            let session = await submission.submit(model: model, repoResolved: repo != nil, holdLikely: holdLikely,
                force: force, events: store.events(), create: { try await store.client.createSession($0, spawnID: $1) },
                isCurrent: { current })
            if let session, current {
                store.apply(.sessionNew(session))
                app.selectedSessionID = session.id
                app.sheet = nil
            }
        }
    }

    @ViewBuilder private var shortcuts: some View {
        ForEach(ComposeKeymap.entries.filter { $0.chord != nil && !["submit", "sheet"].contains($0.id)
            && ComposeKeymap.canDispatch($0.id, editingText: false) }) { entry in
            Button { dispatch(entry.id) } label: { EmptyView() }
                .keyboardShortcut(entry.chord!.equivalent, modifiers: entry.chord!.modifiers)
                .disabled(submission.busy || keyCard)
                .hidden().accessibilityHidden(true)
        }
        // The single CTA owns plain Return; this bridge owns its documented ⌘↵ chord.
        if !readiness.dualCTA {
            Button { submit(false) } label: { EmptyView() }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!readiness.canSubmit || keyCard)
                .hidden().accessibilityHidden(true)
        }
    }

    private func dispatch(_ id: String) {
        switch id {
        case "focus-prompt": model.requestFocus("prompt")
        case "attach": if !model.attachments.hasOutstandingUploads { model.choosingFiles = true }
        case "repo": model.openRepoPicker()
        case "branch": model.openBranchPicker()
        case "repo-prev": model.cycleRepo(-1, repos: repos)
        case "repo-next": model.cycleRepo(1, repos: repos)
        case "issue-filter": if model.source == .issues { model.showFilters.toggle() }
        case "sources-tab": model.source = model.source == .issues ? .commands : .issues
        case "mode-code": model.setMode(.code)
        case "mode-research": model.setMode(.research)
        case "mode-epic": model.setMode(.epic)
        case "mode-plain": model.setMode(.plain)
        case "engine", "model": model.requestFocus(id)
        case "plan-gate": if !model.modeLocked { model.planGateEnabled.toggle(); model.planGateTouched = true }
        case "autopilot": if !model.modeLocked { model.autopilotEnabled.toggle(); model.autopilotTouched = true }
        default: break
        }
    }

    private var spawnPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: L.t("newtask_spawn_slow")).font(.headline)
            if let progress = submission.progress {
                ForEach(progress.completed.indices, id: \.self) { i in
                    Label { Text(verbatim: phaseCopy(progress.completed[i].phase)) } icon: { Image(systemName: "checkmark") }
                }
                HStack { ProgressView().controlSize(.small); Text(verbatim: phaseCopy(progress.phase)) }
            } else { Text(verbatim: L.t("newtask_spawning")) }
            Button(submission.canceling || submission.cancelRequested ? L.t("newtask_spawn_canceling") : L.t("newtask_spawn_cancel")) {
                Task { await submission.cancel(using: { try await store.client.cancelSpawn(id: $0) }, isCurrent: { current }) }
            }.disabled(submission.canceling || submission.cancelRequested)
        }.padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            .accessibilityLabel(L.t("newtask_spawn_progress_aria"))
    }
    private func phaseCopy(_ phase: Components.Schemas.SpawnPhase) -> String {
        switch phase {
        case .base: L.t("newtask_spawn_phase_base")
        case .worktree: L.t("newtask_spawn_phase_worktree")
        case .prompt: L.t("newtask_spawn_phase_prompt")
        case .launch: L.t("newtask_spawn_phase_launch")
        case .agent: L.t("newtask_spawn_phase_agent")
        }
    }
}
