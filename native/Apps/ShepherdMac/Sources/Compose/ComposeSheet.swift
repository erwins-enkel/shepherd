import ShepherdAppCore
import ShepherdKit
import SwiftUI

struct ComposeSheet: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        if let store = app.store {
            ComposeSheetContent(app: app, store: store, activation: app.activationGeneration)
                .id(app.activationGeneration)
        } else {
            VStack(spacing: 16) {
                ProgressView(L.t("common_loading"))
                if let warning = app.credentialAccessWarning {
                    Text(verbatim: warning)
                    Button(L.t("common_retry")) { Task { await app.retryCredentialAccess() } }
                        .accessibilityIdentifier("compose.retryCredentials")
                }
                Button(L.t("common_cancel")) { app.sheet = nil }.keyboardShortcut(.cancelAction)
            }.frame(width: 1040, height: 400)
        }
    }
}

struct ComposeSheetContent: View {
    let app: AppModel
    let store: SessionStore
    let activation: Int
    @State private var model: ComposeModel
    @State private var submission = ComposeSubmission()
    @State private var revealing = false
    @State private var keyCard = false
    @State private var steersIssue: Issue?
    @State private var serverPickerOpen = false
    @State private var repoConfig: RepoConfig?
    @State private var repoConfigLoading = false
    @State private var repoConfigPath = ""
    private var currentRepoConfig: RepoConfig? { repoConfigPath == model.repoPath ? repoConfig : nil }
    @State private var repoConfigRetry = 0

    private struct RepoGuardLoad: Equatable {
        let path: String
        let retry: Int
    }
    @FocusedValue(\.composeEditingText) private var editingText

    init(app: AppModel, store: SessionStore, activation: Int, model: ComposeModel? = nil) {
        self.app = app; self.store = store; self.activation = activation
        let defaults = ComposeRunConfig.defaults(from: store.settings)
        let composer = model ?? ComposeModel(client: store.client, defaults: app.composerDefaults, runDefaults: defaults)
        composer.repoBranches.allowsStatusProbe = app.liveRequestAudit == nil
        _model = State(initialValue: composer)
    }
    private var current: Bool { app.store === store && app.activationGeneration == activation && app.sheet == .newSession }
    private var repos: [Repo] { store.repos.filter { !$0.hidden } }
    private var repo: Repo? { repos.first { $0.path == model.repoPath } }
    private var holdLikely: Bool { ComposeReadiness.holdLikely(limits: SessionSignals.usageLimits(), settings: store.settings) }
    private var readiness: ComposeReadiness.State {
        model.readiness(submitting: submission.busy, repoResolved: repo != nil, holdLikely: holdLikely)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(verbatim: L.t("newtask_title")).font(.title2.bold())
                Spacer()
                Button { keyCard = true } label: { Image(systemName: "questionmark.circle") }
                    .accessibilityLabel(L.t("keymap_sheet_aria"))
                    .modifier(ComposeKeycap(ids: ["sheet"]))
                Button { app.sheet = nil } label: { Image(systemName: "xmark") }
                    .accessibilityLabel(L.t("common_cancel"))
                    .keyboardShortcut(.cancelAction).disabled(submission.busy)
                    .modifier(ComposeKeycap(ids: ["close"]))
            }
            .padding(20)
            Divider()
            HStack(alignment: .top, spacing: 0) {
                ScrollView {
                    ComposeLeftColumn(app: app, model: model, repos: repos, sessions: store.sessions,
                                      serverPickerOpen: $serverPickerOpen, editSteers: { steersIssue = $0 })
                        .padding(20)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                Divider()
                ScrollView {
                    ComposeRail(model: model, holdLikely: holdLikely, repoConfig: currentRepoConfig, repoConfigLoading: repoConfigLoading,
                                retryRepoDefaults: { repoConfigRetry += 1 }, openAutomation: openAutomation).padding(20)
                }
                .frame(width: 340)
                .frame(maxHeight: .infinity)
                .background(Color.primary.opacity(0.035))
            }
            .disabled(submission.busy || keyCard || steersIssue != nil)
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                if let audit = app.liveRequestAudit { LiveRequestAuditView(audit: audit) }
                if submission.slow { spawnPanel }
                if let failure = submission.recoveryFailure { BackendRecoveryPanel(failure: failure) }
                if let message = submission.message { Text(verbatim: message).font(.callout).textSelection(.enabled) }
                ComposeFooter(readiness: readiness, repoName: repo?.name, branch: model.repoBranches, held: revealing, serverName: app.profiles.count > 1 ? app.activeProfile?.name : nil,
                              shortcutsBlocked: keyCard || steersIssue != nil, submit: submit)
            }.padding(20)
        }
        .environment(\.composeReveal, revealing)
        .frame(minWidth: 900, idealWidth: 1040, maxWidth: 1040)
        .frame(minHeight: 400, idealHeight: 780, maxHeight: 780)
        .background(Color(nsColor: .windowBackgroundColor))
        .background { shortcuts }
        .onModifierKeysChanged(mask: .command) { _, keys in revealing = keys.contains(.command) }
        .onKeyPress(characters: CharacterSet(charactersIn: "?")) { _ in
            guard ComposeKeymap.canDispatch("sheet", editingText: editingText == true) else { return .ignored }
            keyCard = true; return .handled
        }
        .sheet(isPresented: Binding(get: { steersIssue != nil }, set: { if !$0 { steersIssue = nil } })) {
            if let issue = steersIssue {
                ComposeActionSheet(mode: .steers, session: nil, store: store, app: app, activation: activation, issue: issue)
            }
        }
        .sheet(isPresented: $keyCard) { ComposeKeyCard { keyCard = false } }
        .interactiveDismissDisabled(submission.busy)
        .onAppear {
            if let prompt = app.consumeComposePrompt(activation: activation) { model.prompt = prompt }
            seedRepo()
        }
        .task(id: RepoGuardLoad(path: model.repoPath, retry: repoConfigRetry)) { await loadRepoGuards() }
        .onChange(of: model.prompt) { _, prompt in
            app.updateComposeHandoverPrompt(prompt, activation: activation)
        }
        .onChange(of: store.settings, initial: true) { _, settings in
            if let settings { model.runDefaults = ComposeRunConfig.defaults(from: settings) }
        }
        .onChange(of: store.repos) { _, _ in seedRepo() }
        .onDisappear { submission.teardown(); model.teardown() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("compose.sheet")
    }

    private func openAutomation() {
        guard current else { return }
        app.extension(SettingsModel.self)?.selectRepo(model.repoPath, client: store.client)
        SettingsPresentation.shared.requestPane("workspace")
    }

    private func loadRepoGuards() async {
        let path = model.repoPath
        repoConfig = nil
        repoConfigPath = path
        repoConfigLoading = !path.isEmpty
        guard !path.isEmpty else { return }
        let config = try? await store.client.getRepoConfig(repo: path)
        guard !Task.isCancelled, current, model.repoPath == path else { return }
        repoConfig = config
        repoConfigLoading = false
        if let config { model.applyRepoGuardDefaults(planGate: config.planGateEnabled, autopilot: config.autopilotEnabled) }
    }

    private func seedRepo() {
        if model.repoPath.isEmpty, let path = RepoRecency.defaultPath(repos, sessions: store.sessions) { model.repoPath = path }
    }
    private func submit(_ force: Bool = false) {
        guard current else { return }
        Task {
            let session = await submission.submit(model: model, repoResolved: repo != nil, holdLikely: holdLikely,
                force: force, events: store.events(), recovery: app.extension(BackendRecoveryModel.self), create: { try await store.client.createSession($0, spawnID: $1) },
                onHeld: { app.sheet = nil }, isCurrent: { current })
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
                .disabled(submission.busy || keyCard || steersIssue != nil)
                .hidden().accessibilityHidden(true)
        }

    }

    private func dispatch(_ id: String) {
        switch id {
        case "focus-prompt": model.requestFocus("prompt")
        case "attach": if !model.attachments.hasOutstandingUploads { model.choosingFiles = true }
        case "server": if app.profiles.count > 1 { serverPickerOpen = true }
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
                    Label {
                        Text(verbatim: ComposeSubmission.phaseCopy(progress.completed[i].phase))
                        Text(Duration.milliseconds(progress.completed[i].ms).formatted(.time(pattern: .minuteSecond)))
                            .monospacedDigit().foregroundStyle(.secondary)
                    } icon: { Image(systemName: "checkmark") }
                }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    HStack {
                        ProgressView().controlSize(.small)
                        Text(verbatim: ComposeSubmission.phaseCopy(progress.phase))
                        Text(Duration.seconds(max(0, context.date.timeIntervalSince1970 - Double(progress.startedAt) / 1_000))
                            .formatted(.time(pattern: .minuteSecond)))
                            .monospacedDigit().foregroundStyle(.secondary)
                    }
                }
            } else { Text(verbatim: L.t("newtask_spawning")) }
            Button(submission.canceling || submission.cancelRequested ? L.t("newtask_spawn_canceling") : L.t("newtask_spawn_cancel")) {
                Task { await submission.cancel(using: { try await store.client.cancelSpawn(id: $0) }, isCurrent: { current }) }
            }.disabled(submission.canceling || submission.cancelRequested)
        }.padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            .accessibilityLabel(L.t("newtask_spawn_progress_aria"))
    }
}
