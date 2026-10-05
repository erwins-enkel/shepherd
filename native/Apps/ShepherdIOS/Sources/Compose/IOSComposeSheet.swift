import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import ShepherdAppCore
import ShepherdKit

/// Public entry seam for the session-list stream's + NEU button.
@MainActor public enum IOSComposer {
    @discardableResult public static func open(_ app: AppModel) -> Bool {
        guard app.store != nil, app.liveRequestAudit == nil else { return false }
        app.sheet = .newSession; return true
    }
}
struct IOSComposeSheet: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        if let store = app.store {
            IOSComposeContent(app: app, store: store, activation: app.activationGeneration).id(app.activationGeneration)
        }
    }
}
struct IOSComposeContent: View {
    let app: AppModel
    let store: SessionStore
    let activation: Int
    private let fixtureCurrent: (() -> Bool)?
    private let serverPicker: AnyView?
    private let closeSheet: (() -> Void)?
    private let onCreated: ((String) -> Void)?
    private let promptChanged: ((String) -> Void)?
    @State var model: ComposeModel
    @State var voice: DictationController
    @State private var audioEngine: IOSDictationEngine?
    @State private var submission = ComposeSubmission()
    @State private var autoStart = ComposeAutoStart(keepAlive: { IOSBackgroundGrace.begin("shepherd.compose.autostart") })
    @State private var options: Options?
    @State private var files = false
    @State private var photos = false
    @State private var photo: PhotosPickerItem?
    @FocusState private var promptFocused: Bool
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.composeRendering) private var rendering
    @ScaledMetric(relativeTo: .body) private var bodySize = 13
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .body) private var promptHeight = 230
    enum Options: String, Identifiable { case branch, engine, issues, commands; var id: String { rawValue } }
    init(app: AppModel, store: SessionStore, activation: Int, model: ComposeModel? = nil, voice: DictationController? = nil, fixtureCurrent: (() -> Bool)? = nil, serverPicker: AnyView? = nil, close: (() -> Void)? = nil, onCreated: ((String) -> Void)? = nil, initialPrompt: String = "", promptChanged: ((String) -> Void)? = nil) {
        self.app = app; self.store = store; self.activation = activation; self.fixtureCurrent = fixtureCurrent
        self.serverPicker = serverPicker; self.closeSheet = close; self.onCreated = onCreated; self.promptChanged = promptChanged
        let model = model ?? ComposeModel(client: store.client, defaults: app.composerDefaults, runDefaults: ComposeRunConfig.defaults(from: store.settings))
        if !initialPrompt.isEmpty { model.prompt = initialPrompt }
        model.repoBranches.allowsStatusProbe = app.liveRequestAudit == nil
        model.attachments.keepAlive = { IOSBackgroundGrace.begin("shepherd.compose.upload") }
        _model = State(initialValue: model)
        if let voice { _voice = State(initialValue: voice) }
        else {
            let dictation = IOSDictationSession(client: store.client, defaults: app.composerDefaults,
                context: [model.repoPath, model.repoBranches.baseBranch],
                whisperStatus: app.extension(IOSTerminalController.self)?.whisperStatus,
                getText: { model.prompt }, setText: { model.prompt = $0 })
            _audioEngine = State(initialValue: dictation.engine)
            _voice = State(initialValue: dictation.voice)
        }
    }
    private var repos: [Repo] { store.repos.filter { !$0.hidden } }
    private var repo: Repo? { repos.first { $0.path == model.repoPath } }
    private var repoName: String { repo?.name ?? model.repoPath.components(separatedBy: "/").last ?? "" }
    private var current: Bool { fixtureCurrent?() ?? (app.store === store && app.activationGeneration == activation && app.sheet == .newSession) }
    private var holdLikely: Bool { ComposeReadiness.holdLikely(limits: SessionSignals.usageLimits(for: app), settings: store.settings) }
    var readiness: ComposeReadiness.State { model.readiness(submitting: submission.busy, repoResolved: repo != nil, holdLikely: holdLikely) }
    var body: some View {
        VStack(spacing: 0) {
            header
            if rendering {
                GeometryReader { geometry in
                    formContent.frame(width: geometry.size.width, alignment: .top)
                        .frame(height: geometry.size.height, alignment: .top).clipped()
                }
            } else {
                ScrollView { formContent }.scrollDismissesKeyboard(.interactively)
            }
            if submission.busy { spawnFooter }
            else {
                MicDock(voice: voice, audioEngine: audioEngine, micEnabled: !autoStart.armed) { attachmentMenu } submit: { startButton }
                    .padding(.top, promptFocused ? 0 : 12)
                    .disabled(submission.busy)
                if readiness.dualCTA {
                    HStack {
                        Button(L.t("newtask_hold_for_reset")) { submit(force: false) }
                        Button(L.t("newtask_submit_anyway")) { submit(force: true) }
                    }.buttonStyle(ComposeControlStyle(accent: true))
                        .disabled(!(readiness.canSubmit || readiness.canQueue) || voice.active || autoStart.armed)
                }
            }
            if let status = model.attachments.status { uploadFooter(status) }
            else {
                // A photo that never loaded leaves no row behind, so the notice cannot rely on the failed footer.
                if autoStart.aborted { abortedNotice.padding(.horizontal, 16).padding(.top, 8) }
                Text(verbatim: readiness.blocker == "empty_prompt" ? L.t("native_compose_prompt_missing") : readiness.canSubmit ? L.t("native_compose_ready_to_start") : readiness.copy).font(.system(.caption, design: .monospaced)).foregroundStyle(ComposePalette.muted).multilineTextAlignment(.center)
                    .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 18).accessibilityIdentifier("compose.readiness")
            }
        }.background(ComposePalette.bg).foregroundStyle(ComposePalette.ink)
            .font(.system(size: bodySize, design: .monospaced)).tint(ComposePalette.amber)
            .preferredColorScheme(.dark)
            .presentationDetents([.large]).presentationDragIndicator(.hidden)
            .interactiveDismissDisabled(voice.active || submission.busy || autoStart.armed)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("compose.sheet")
            .sheet(item: $options) { option in
                NavigationStack {
                    Group {
                        switch option {
                        case .branch: ComposeBranchSheet(model: model)
                        case .engine: ComposeEngineSheet(model: model).environment(app)
                        case .issues: ComposeSourceSheet(model: model, commands: false) { options = nil }
                        case .commands: ComposeSourceSheet(model: model, commands: true) { options = nil }
                        }
                    }.toolbar { ToolbarItem(placement: .confirmationAction) { Button(L.t("native_compose_voice_done")) { options = nil } } }
                }.preferredColorScheme(.dark).tint(ComposePalette.amber)
            }
            .fileImporter(isPresented: $files, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls): model.attachments.addFiles(urls)
                case .failure(let error): model.attachments.importError = ShepherdErrorCopy.message(error)
                }
            }
            // A PhotosPicker view inside the + Menu never presents: dismissing the menu tears it down.
            .photosPicker(isPresented: $photos, selection: $photo, matching: .images)
            .onChange(of: photo) { _, photo in importPhoto(photo) }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { if voice.capturing { voice.finalize() } else if voice.state == .arming { voice.cancel() } }
            }
            .onChange(of: voice.active) { _, active in if active { promptFocused = false } }
            .onChange(of: model.prompt) { _, text in
                promptChanged?(text)
                guard promptFocused, !voice.active, let trigger = ComposeModel.trigger(in: text, caret: text.endIndex) else { return }
                if trigger.query.isEmpty { options = trigger.symbol == "#" ? .issues : .commands }
            }
            .onChange(of: store.settings) { _, settings in model.runDefaults = ComposeRunConfig.defaults(from: settings) }
            .onChange(of: store.repos) { _, _ in seedRepo() }
            .onChange(of: model.attachments.inFlight) { _, inFlight in if inFlight { autoStart.clearAborted() } }
            .onAppear { seedRepo(); audioEngine?.probeWhisper() }
            .onDisappear { audioEngine?.stopWhisperProbe(); voice.teardown(); submission.teardown(); autoStart.teardown(); model.teardown() }
            .alert(L.t("native_compose_voice_label"), isPresented: Binding(get: { audioEngine?.needsAppleServerConsent == true }, set: { if !$0 { audioEngine?.resolveAppleServerConsent(false) } })) {
                Button(L.t("native_compose_voice_allow")) { audioEngine?.resolveAppleServerConsent(true) }
                Button(L.t("common_cancel"), role: .cancel) { audioEngine?.resolveAppleServerConsent(false) }
            } message: { Text(verbatim: L.t("native_compose_voice_apple_disclosure")) }
    }
    private var formContent: some View {
                VStack(alignment: .leading, spacing: 12) {
                    if let serverPicker { serverPicker.disabled(voice.active || submission.busy || autoStart.armed) }
                    context.opacity(voice.active || autoStart.armed ? 0.4 : 1).disabled(voice.active || submission.busy || autoStart.armed)
                    prompt
                    attachments
                    if voice.capturing || voice.state == .finalizing { TranscriptPreview(voice: voice, audioEngine: audioEngine) }
                    if voice.canUndo {
                        HStack {
                            Button(L.t("native_compose_voice_undo")) { voice.undo() }.buttonStyle(ComposeControlStyle()).frame(minHeight: 44)
                            Spacer(); Text(verbatim: L.t("native_compose_voice_kept")).font(.system(.caption2, design: .monospaced)).foregroundStyle(ComposePalette.muted)
                        }.accessibilityIdentifier("compose.voice.undo")
                    }
                    if audioEngine?.preparing == true, voice.state == .arming || voice.capturing { Text(verbatim: L.t("native_compose_voice_preparing")).font(.system(.caption, design: .monospaced)) }
                    notices
                    if let message = submission.message { Text(verbatim: message).foregroundStyle(ComposePalette.red) }
                    if let failure = submission.recoveryFailure { Text(verbatim: BackendRecovery.summary(failure)) }
                }.padding(.horizontal, 16).padding(.top, 12)
    }
    private var header: some View {
        HStack {
            Button { voice.teardown(); dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44).overlay(Circle().stroke(ComposePalette.line)) }
                .buttonStyle(.plain).accessibilityLabel(L.t("common_close")).disabled(submission.busy)
            Spacer(minLength: 8)
            Text(verbatim: L.t("newtask_title").uppercased()).font(.system(size: bodySize, design: .monospaced).weight(.bold)).tracking(1.4).foregroundStyle(ComposePalette.bright)
            Spacer(minLength: 8)
            if rendering { languageLabel }
            else {
                Menu {
                    Button("DE") { voice.locale = "de-DE" }; Button("EN") { voice.locale = "en-US" }
                } label: { languageLabel }
                    .disabled(voice.active).accessibilityLabel(L.t("native_compose_voice_language"))
            }
        }.padding(.horizontal, 16).padding(.vertical, 12).overlay(alignment: .bottom) { Rectangle().fill(ComposePalette.line).frame(height: 1) }
    }
    private var languageLabel: some View {
        Text(verbatim: voice.locale.hasPrefix("de") ? "DE ▾" : "EN ▾").font(.system(.caption, design: .monospaced))
            .frame(minWidth: 44, minHeight: 44).overlay(RoundedRectangle(cornerRadius: 6).stroke(ComposePalette.line))
    }
    private var contextLayout: AnyLayout {
        typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
    }
    private var context: some View {
        VStack(alignment: .leading, spacing: 10) {
            contextLayout {
                repoChip.accessibilityIdentifier("compose.repo")
                    .accessibilityLabel(L.t("newtask_repo_label")).accessibilityValue(repoName)
                Button { promptFocused = false; options = .branch } label: {
                    Text(verbatim: "\(model.repoBranches.baseBranch) ▾").lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                }.accessibilityIdentifier("compose.branch.open")
                    .accessibilityLabel(L.t("newtask_branch_label")).accessibilityValue(model.repoBranches.baseBranch)
                Button { promptFocused = false; options = .engine } label: {
                    Text(verbatim: "\(model.provider == .claude ? L.t("native_compose_engine_claude") : L.t("agent_provider_codex")) · \(L.t(model.planGateEnabled ? "native_compose_plan_on" : "native_compose_plan_off")) ▾").lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                }.accessibilityIdentifier("compose.engine.open")
            }.buttonStyle(ComposeControlStyle()).font(.system(.caption, design: .monospaced))
            modeBar
            HStack {
                Button { promptFocused = false; options = .issues } label: { Text(verbatim: model.activeIssue.map { "#\($0.number) · \($0.title)" } ?? L.t("native_compose_issue_choose")).lineLimit(1) }
                    .buttonStyle(ComposeControlStyle()).font(.system(.caption, design: .monospaced)).accessibilityIdentifier("compose.issues.open")
                if model.activeIssue != nil {
                    Button { model.removeIssue() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel(L.t("newtask_issue_remove_aria"))
                }
            }
        }
    }
    /// One tap opens the repo list itself; ImageRenderer cannot draw a Menu, so renders get the bare chip.
    @ViewBuilder private var repoChip: some View {
        let label = Text(verbatim: "\(repoName) ▾").lineLimit(typeSize.isAccessibilitySize ? nil : 1).frame(maxWidth: .infinity, alignment: .leading)
        if rendering { Button {} label: { label } }
        else { Menu { repoOptions } label: { label }.menuStyle(.button).menuOrder(.fixed) }
    }
    @ViewBuilder private var repoOptions: some View {
        let recent = RepoRecency.recent(repos, sessions: store.sessions)
        let stamps = RepoRecency.lastUsed(repos, sessions: store.sessions)
        if recent.isEmpty {
            ForEach(RepoRecency.alphabetical(repos), id: \.path) { repoOption($0, age: nil) }
        } else {
            Section(L.t("native_compose_repo_recent")) {
                ForEach(recent, id: \.path) { repo in repoOption(repo, age: stamps[repo.path].map { RepoRecency.age($0) }) }
            }
            Menu(L.t("native_compose_repo_all")) {
                ForEach(RepoRecency.alphabetical(repos), id: \.path) { repoOption($0, age: nil) }
            }
        }
    }
    private func repoOption(_ option: Repo, age: String?) -> some View {
        Button { model.repoPath = option.path } label: {
            Text(verbatim: option.name)
            if let age { Text(verbatim: age) }
            if option.path == model.repoPath { Image(systemName: "checkmark") }
        }
    }
    @ViewBuilder private var modeBar: some View {
        if typeSize.isAccessibilitySize {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(ComposeMode.allCases, id: \.self) { mode in modeButton(mode) }
            }
        } else {
            HStack(spacing: 0) { ForEach(ComposeMode.allCases, id: \.self) { mode in modeButton(mode) } }
                .clipShape(RoundedRectangle(cornerRadius: 6)).overlay(RoundedRectangle(cornerRadius: 6).stroke(ComposePalette.line))
        }
    }
    private func modeButton(_ mode: ComposeMode) -> some View {
        Button { model.setMode(mode) } label: {
            Text(verbatim: (mode == .plain ? L.t("native_compose_mode_plain") : mode.title).uppercased())
                .font(.system(.caption2, design: .monospaced).weight(model.mode == mode ? .bold : .regular))
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(model.mode == mode ? ComposePalette.bg : ComposePalette.muted)
                .background(model.mode == mode ? ComposePalette.amber : ComposePalette.bg)
        }.buttonStyle(.plain).accessibilityIdentifier("compose.mode.\(mode.rawValue)")
    }
    private var prompt: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: L.t("native_compose_prompt_label").uppercased()).font(.system(.caption2, design: .monospaced)).tracking(1.2).foregroundStyle(ComposePalette.faint)
            ZStack(alignment: .topLeading) {
                if model.prompt.isEmpty { Text(verbatim: L.t("native_compose_voice_placeholder")).foregroundStyle(ComposePalette.faint).padding(12).allowsHitTesting(false) }
                if rendering {
                    Text(verbatim: model.prompt).frame(maxWidth: .infinity, alignment: .topLeading).padding(12)
                } else {
                    TextEditor(text: $model.prompt).scrollContentBackground(.hidden).padding(6).focused($promptFocused)
                        .disabled(voice.active || submission.busy || autoStart.armed).accessibilityIdentifier("compose.prompt")
                        .accessibilityLabel(L.t("native_compose_prompt_label"))
                }
            }.frame(maxWidth: .infinity, alignment: .topLeading).frame(height: voice.capturing ? (voice.state == .locked ? 110 : 70) : voice.canUndo ? 180 : promptFocused ? min(promptHeight, 150) : promptHeight, alignment: .topLeading).clipped()
                .background(ComposePalette.panel).clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(voice.canUndo ? ComposePalette.amber : ComposePalette.line))
        }
    }
    @ViewBuilder private var attachmentMenu: some View {
        if rendering { attachmentLabel }
        else { Menu {
            Button { photos = true } label: { Label(L.t("native_compose_photos"), systemImage: "photo") }
            Button { files = true } label: { Label(L.t("native_compose_files"), systemImage: "doc") }
            Button {
                if let bytes = UIPasteboard.general.image?.pngData() { model.attachments.addFiles([.init(name: "paste.png", data: bytes)]) }
            } label: { Label(L.t("native_compose_paste"), systemImage: "doc.on.clipboard") }
            Button { options = .commands } label: { Label(L.t("promptsources_commands_tab"), systemImage: "command") }
        } label: { attachmentLabel }
            .accessibilityLabel(L.t("native_compose_attach")).accessibilityIdentifier("compose.attach").disabled(voice.active || autoStart.armed) }
    }
    private var attachmentLabel: some View {
        Image(systemName: "plus").font(.title2).frame(width: 52, height: 52).background(ComposePalette.panel, in: Circle()).overlay(Circle().stroke(ComposePalette.line))
    }
    private var startButton: some View {
        Button { submit(force: false) } label: {
            HStack(spacing: 6) {
                Text(verbatim: startLabel.uppercased())
                if autoStart.armed { Image(systemName: "xmark") }
            }.font(.system(.caption, design: .monospaced).bold()).monospacedDigit().padding(.horizontal, 16).frame(height: 52)
                .foregroundStyle(autoStart.armed ? ComposePalette.amber : startEnabled ? ComposePalette.bg : ComposePalette.faint)
                .background(startEnabled && !autoStart.armed ? ComposePalette.amber : ComposePalette.panel, in: Capsule())
                .overlay(Capsule().stroke(autoStart.armed ? ComposePalette.amber : ComposePalette.line))
        }.buttonStyle(.plain).disabled(!startEnabled)
            .accessibilityLabel(autoStart.armed ? L.t("native_compose_autostart_cancel") : startLabel)
            .accessibilityIdentifier("compose.submit")
    }
    /// Armed stays tappable so the operator can take the queued start back.
    private var startEnabled: Bool {
        autoStart.armed || ((readiness.canSubmit || readiness.canQueue) && !voice.active && !readiness.dualCTA)
    }
    private var startLabel: String {
        if autoStart.armed { return L.t("native_compose_autostart_armed_button") }
        guard readiness.canQueue, let status = model.attachments.status, status.phase == .transferring || status.phase == .finishing
        else { return L.t("native_compose_start") }
        return "\(L.t("native_compose_start")) · \(L.t("newtask_upload_percent", String(status.percent)))"
    }
    private func uploadFooter(_ status: UploadStatus) -> some View {
        VStack(spacing: 6) {
            if status.phase == .transferring || status.phase == .finishing {
                ProgressView(value: Double(status.percent), total: 100).accessibilityLabel(L.t("newtask_upload_progress_aria"))
            }
            Text(verbatim: status.line).monospacedDigit().accessibilityIdentifier("compose.upload.status")
            if status.phase == .failed {
                if autoStart.aborted { abortedNotice }
                Button(L.t("common_retry")) { model.attachments.retryFailed() }
                    .buttonStyle(ComposeControlStyle()).frame(minHeight: 44).accessibilityIdentifier("compose.upload.retry")
            } else {
                Text(verbatim: uploadHint).accessibilityIdentifier("compose.upload.hint")
            }
        }.font(.system(.caption, design: .monospaced)).foregroundStyle(ComposePalette.muted).multilineTextAlignment(.center)
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 18)
    }
    private var abortedNotice: some View {
        Text(verbatim: L.t("native_compose_autostart_aborted")).font(.system(.caption, design: .monospaced))
            .foregroundStyle(ComposePalette.red).multilineTextAlignment(.center).accessibilityIdentifier("compose.autostart.aborted")
    }
    /// Whether the start follows on its own, then the one rule that keeps it alive.
    private var uploadHint: String {
        let next = autoStart.armed ? L.t("native_compose_upload_autostart_armed")
            : readiness.canQueue ? L.t("native_compose_upload_autostart_hint")
            : readiness.blockerAfterUpload == "empty_prompt" ? L.t("native_compose_prompt_missing")
            : ComposeReadiness.copy(for: readiness.blockerAfterUpload)
        return "\(next) · \(L.t("native_compose_keep_app_open"))"
    }
    private var attachments: some View {
        ForEach(model.attachments.rows) { row in
            HStack {
                Text(verbatim: row.file.name).lineLimit(1)
                if row.state == .uploading { ProgressView(value: Double(model.attachments.progressPercent), total: 100) }
                if row.state == .failed {
                    Button(L.t("common_retry")) { model.attachments.retry(row.id) }
                        .accessibilityIdentifier("compose.attachment.retry")
                }
                Button { model.attachments.remove(row.id) } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel(L.t("common_close"))
            }.font(.system(.caption, design: .monospaced)).disabled(voice.active || submission.busy || autoStart.armed)
            if let error = row.error { Text(verbatim: error).font(.system(.caption, design: .monospaced)).foregroundStyle(ComposePalette.red) }
        }
    }
    @ViewBuilder private var notices: some View {
        if let copy = voice.noticeCopy {
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: copy).font(.system(.caption, design: .monospaced))
                if voice.state == .denied {
                    HStack {
                        Button(L.t("native_compose_voice_settings")) { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }
                        Button(L.t("native_compose_voice_type")) { promptFocused = true }
                    }.buttonStyle(ComposeControlStyle())
                }
                if voice.state == .error { Button(L.t("common_retry")) { voice.toggle() } }
            }.padding(12).background(ComposePalette.panel2).accessibilityIdentifier("compose.voice.notice")
        }
        if let error = model.attachments.importError { Text(verbatim: error).foregroundStyle(ComposePalette.red) }
    }
    private var spawnFooter: some View {
        VStack(spacing: 8) {
            ProgressView()
            Text(verbatim: submission.progress.map { ComposeSubmission.phaseCopy($0.phase) } ?? L.t("newtask_spawning"))
            if submission.slow { Text(verbatim: L.t("newtask_spawn_slow")).font(.system(.caption, design: .monospaced)) }
            Text(verbatim: L.t("native_compose_keep_app_open")).font(.system(.caption, design: .monospaced)).foregroundStyle(ComposePalette.muted)
                .multilineTextAlignment(.center)
            Button(L.t("newtask_spawn_cancel")) {
                Task { await submission.cancel(using: { try await store.client.cancelSpawn(id: $0) }, isCurrent: { current }) }
            }.disabled(submission.canceling || submission.cancelRequested).frame(minHeight: 44)
        }.padding()
    }
    private func dismiss() { if let closeSheet { closeSheet() } else { app.sheet = nil } }
    private func seedRepo() {
        if model.repoPath.isEmpty || (serverPicker != nil && repo == nil),
           let path = RepoRecency.defaultPath(repos, sessions: store.sessions) { model.repoPath = path }
    }
    private func submit(force: Bool) {
        if autoStart.armed { autoStart.disarm(); return }
        guard current, !voice.active else { return }
        voice.teardown(); promptFocused = false
        if readiness.canQueue {
            autoStart.arm(force: force, attachments: model.attachments) { force in await performSubmit(force: force) }
        } else {
            Task { await performSubmit(force: force) }
        }
    }
    private func performSubmit(force: Bool) async {
        // The create may outlive a brief app switch; the server finishes the spawn regardless.
        let release = IOSBackgroundGrace.begin("shepherd.compose.create")
        defer { release() }
        let session = await submission.submit(model: model, repoResolved: repo != nil, holdLikely: holdLikely, force: force,
            events: store.events(), recovery: app.extension(BackendRecoveryModel.self), create: { try await store.client.createSession($0, spawnID: $1) }, onHeld: { dismiss() }, isCurrent: { current })
        if let session, current {
            store.apply(.sessionNew(session))
            if let onCreated { onCreated(session.id) }
            else { app.selectedSessionID = session.id; dismiss() }
        }
    }
    private func importPhoto(_ photo: PhotosPickerItem?) {
        guard let photo, let stamp = model.attachments.beginImport() else { return }
        Task {
            do {
                let bytes = try await photo.loadTransferable(type: Data.self)
                let ext = photo.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                model.attachments.finishImport(bytes.map { .init(name: "photo.\(ext)", data: $0) }, error: nil, generation: stamp)
            } catch { model.attachments.finishImport(nil, error: ShepherdErrorCopy.message(error), generation: stamp) }
            self.photo = nil
        }
    }
}
